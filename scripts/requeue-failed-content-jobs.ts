// scripts/requeue-failed-content-jobs.ts
// Bring back content generation jobs that were failed by an outage at OUR end.
//
// ⚠️ THIS EXISTS BECAUSE A FAILED JOB IS TERMINAL. Nothing in the product requeues one: both paths
// that write status='queued' (the stuck-job reclaimer and the backoff retry in
// process-content-jobs.ts) require attempt < max_attempts, and a job only fails AT max_attempts. So
// a job that gave up has given up for good, and topping the provider back up does not bring it back.
//
// Between 2026-09-17 and 2026-09-28 that cost 1,829 posts across all five organisations on
// production: the Anthropic account's credit balance ran out, a credit failure arrives as a 400
// (which the gateway's failover does not cover), and every job burned its three attempts in seconds
// against an API that could not answer. The drain now PARKS a job for up to 72 hours instead of
// spending its retries on our outage — but nothing had parked these, and they are still sitting
// there as 'failed'.
//
// ── What it will and will not touch ─────────────────────────────────────────────────────────────
// Only jobs whose error_message matches the outage (--match, default: the credit-balance message).
// A job that failed because its blueprint is missing, or because the model would not produce valid
// JSON for one awkward prompt, is a real failure and must stay failed — requeuing those would run
// them three more times to reach the same answer, and bury the genuine problem in the noise.
//
// A job that already produced a post is skipped outright (result_post_id IS NOT NULL). The drain has
// its own idempotency guard, but this script must not depend on it: a job requeued after it had
// already written a post is exactly how one job came to write two posts into one cross-post group.
//
// ── Pace it ─────────────────────────────────────────────────────────────────────────────────────
// ⚠️ The drain takes 20 jobs per tick, every 10 minutes, and each one is a model call. Releasing
// 1,829 at once is its own incident — it is a thundering herd at the provider that just came back,
// and it will backdate a fortnight of posts into the review queues of five customers in an evening.
// --limit is not a convenience, it is the point. Run it in batches and watch the first one land.
//
// DRY RUN by default. Nothing is written without --apply.
//
//   npx tsx scripts/requeue-failed-content-jobs.ts
//   npx tsx scripts/requeue-failed-content-jobs.ts --apply --limit=50
//   npx tsx scripts/requeue-failed-content-jobs.ts --apply --limit=200 --org=37 --url-var=DATABASE_URL_PROD
//
// ⚠️ --url-var takes the NAME of an environment variable, never a connection string: a URL on the
// command line ends up in shell history and in this session's transcript.

import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const limit = Number(flag('limit')) || 100;
const org = Number(flag('org')) || null;
const match = flag('match') ?? 'credit balance is too low';
const sinceDays = Number(flag('since-days')) || 30;

/** Host + database of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set — the script will fail to connect`;
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}  [${urlVar}]`;
    } catch {
        return `unparseable ${urlVar}`;
    }
}

async function main() {
    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) {
            console.error(`\n${urlVar} is not set. Export it, or drop --url-var to use NETLIFY_DATABASE_URL.\n`);
            process.exit(1);
        }
        process.env.NETLIFY_DATABASE_URL = override;
    }

    const { getDb } = await import('../db/client');
    const db = getDb();

    // ⚠️ Escaped for a LIKE, not just for a quote: an operator passing --match with a % would widen
    // the pattern silently, and the widest version of this query requeues every failed job there is.
    const safeMatch = match.replace(/'/g, "''").replace(/[%_\\]/g, (c) => `\\${c}`);
    const orgClause = org ? `AND organisation_id = ${org}` : '';
    const where =
        `WHERE status = 'failed'
           AND result_post_id IS NULL
           AND updated_at > now() - interval '${sinceDays} days'
           AND error_message LIKE '%${safeMatch}%' ESCAPE '\\'
           ${orgClause}`;

    console.log('\nRequeue: content_generation_jobs failed by an outage at our end');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)'}`);
    console.log(`  match  : error_message contains "${match}"`);
    console.log(`  scope  : ${org ? `organisation ${org}` : 'all organisations'}, failed in the last ${sinceDays} days`);
    console.log(`  batch  : ${limit} job${limit === 1 ? '' : 's'} (the drain takes 20 per 10-minute tick)`);
    console.log('');

    const totals = await db.execute<{ organisation_id: number; jobs: number }>(
        `SELECT organisation_id, count(*)::int AS jobs FROM content_generation_jobs ${where}
          GROUP BY organisation_id ORDER BY jobs DESC`
    );
    const eligible = totals.reduce((n, r) => n + Number(r.jobs || 0), 0);
    if (!eligible) {
        console.log('  Nothing matches. Either they have been requeued already, or the failures were not this outage.\n');
        return;
    }
    console.log(`  ${eligible} eligible job${eligible === 1 ? '' : 's'}:`);
    for (const r of totals) console.log(`    organisation ${r.organisation_id}: ${r.jobs}`);
    console.log('');

    if (!apply) {
        console.log(`  DRY RUN — nothing written. Re-run with --apply to release ${Math.min(limit, eligible)} of them.\n`);
        return;
    }

    // attempt = 0, because these never had a real attempt: three calls to an API that could not
    // answer is not three tries at writing the post. next_retry_at = now() so the next tick takes
    // them. Oldest first — the customer has been waiting longest for those.
    const updated = await db.execute<{ id: number; organisation_id: number }>(
        `UPDATE content_generation_jobs
            SET status = 'queued', attempt = 0, next_retry_at = now(),
                error_message = NULL, updated_at = now()
          WHERE id IN (SELECT id FROM content_generation_jobs ${where} ORDER BY created_at LIMIT ${limit})
      RETURNING id, organisation_id`
    );
    console.log(`  Requeued ${updated.length} job${updated.length === 1 ? '' : 's'}.`);
    console.log(`  ${eligible - updated.length} still waiting — re-run when this batch has drained.\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
