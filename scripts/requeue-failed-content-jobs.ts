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
// A job that already produced a post is skipped outright. The drain has its own idempotency guard,
// but this script must not depend on it: a job requeued after it had already written a post is
// exactly how one job came to write two posts into one cross-post group.
//
// ⚠️ BOTH result columns. The first version checked only `result_post_id`, which is the SOCIAL one —
// a blog job records its draft in `result_blog_post_id`, so for every blog job the guard was
// inert: it read NULL and waved them through regardless of what they had already written. Found
// 2026-09-30 while recovering 36 blog jobs the September outage had failed. It happened not to
// matter for those (all 36 died at ideation, before a post existed), but a guard that is true by
// accident is not a guard.
//
// ── ⚠️ THE DATES, WHICH ARE THE DANGEROUS PART ──────────────────────────────────────────────────
// A job carries the slot it was meant to publish in, and for this backlog that slot is up to eleven
// days in the PAST. The draft it writes inherits it. That is harmless while the draft sits in the
// review queue — and it is not harmless at all for a workspace with Autopilot publishing on:
//
//   • the post is inserted 'pending_approval', then runAutoPublishGate may promote it to 'scheduled'
//   • runAutoPublishGate has NO staleness check — it asks about confidence, media and connections
//   • publish-social-posts takes everything 'scheduled' with publish_date <= now()
//
// So requeuing this backlog unmodified would publish a fortnight of backdated posts to five
// customers' real accounts, all within five minutes, with nobody having read them. --shift-days
// moves the slots that have PASSED forward by the same number of days, which keeps their spacing
// relative to each other (they were a cadence, not a pile) while putting all of it in the future.
//
// ⚠️ Only the ones that have passed. A job is enqueued ahead of the slot it is for, so most of a
// backlog like this is still correctly dated — the first real dry run found 275 stale out of 1,834.
// Shifting all of them would move fifteen hundred perfectly good posts later than the customer
// asked for, silently, and call it a recovery.
//
// It is REFUSED rather than defaulted: the right shift depends on when you run this, it must be the
// same for every batch or the batches interleave, and guessing it on the operator's behalf is how
// you get the incident this flag exists to prevent. The dry run computes it and prints it.
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
//   npx tsx scripts/requeue-failed-content-jobs.ts --apply --limit=50 --shift-days=12
//   npx tsx scripts/requeue-failed-content-jobs.ts --apply --limit=200 --shift-days=12 --org=37 --url-var=DATABASE_URL_PROD
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
const shiftDays = flag('shift-days') != null ? Number(flag('shift-days')) : null;
const keepDates = args.includes('--keep-dates');

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
           AND result_blog_post_id IS NULL
           AND updated_at > now() - interval '${sinceDays} days'
           AND error_message LIKE '%${safeMatch}%' ESCAPE '\\'
           ${orgClause}`;

    console.log('\nRequeue: content_generation_jobs failed by an outage at our end');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)'}`);
    console.log(`  match  : error_message contains "${match}"`);
    console.log(`  scope  : ${org ? `organisation ${org}` : 'all organisations'}, failed in the last ${sinceDays} days`);
    console.log(`  batch  : ${limit} job${limit === 1 ? '' : 's'} (the drain takes 20 per 10-minute tick)`);
    console.log(`  dates  : ${keepDates ? '⚠️  KEPT AS THEY ARE' : shiftDays != null ? `moved forward ${shiftDays} days` : 'not decided yet'}`);
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

    // ── The slot check ──────────────────────────────────────────────────────────────────────────
    const [slots] = await db.execute<{ oldest: string | null; stale: number }>(
        `SELECT min(target_publish_date) AS oldest,
                count(*) FILTER (WHERE target_publish_date < now())::int AS stale
           FROM content_generation_jobs ${where}`
    );
    const stale = Number(slots?.stale ?? 0);
    const oldest = slots?.oldest ? new Date(slots.oldest) : null;
    const recommended = oldest
        ? Math.ceil((Date.now() + 86_400_000 - oldest.getTime()) / 86_400_000)
        : 0;

    if (stale) {
        console.log(`  ⚠️  ${stale} of them are scheduled for a slot that has already passed`
            + `${oldest ? ` (oldest: ${oldest.toISOString().slice(0, 10)})` : ''}.`);
        console.log('      A draft inherits that slot. Autopilot can promote a draft to \'scheduled\',');
        console.log('      and anything scheduled with a past date publishes on the next 5-minute tick —');
        console.log('      so left alone this posts a fortnight of old content to real accounts at once.');
        console.log(`      Use --shift-days=${recommended} to move THOSE ${stale} forward; the other `
            + `${eligible - stale} are still correctly dated and are left alone.`);
        console.log('');
    }

    if (!apply) {
        console.log(`  DRY RUN — nothing written. Re-run with --apply --limit=${Math.min(limit, eligible)}`
            + `${stale ? ` --shift-days=${recommended}` : ''} to release them.\n`);
        return;
    }

    // ⚠️ REFUSED, not defaulted. The right shift depends on when this is run, and it must be the
    // same across every batch or the batches interleave. Choosing it for the operator is how you get
    // the incident this exists to prevent.
    if (stale && shiftDays == null && !keepDates) {
        console.error(`  REFUSING: ${stale} jobs carry a slot in the past and no --shift-days was given.`);
        console.error(`  Pass --shift-days=${recommended}, or --keep-dates if you have decided you want`);
        console.error('  backdated posts to go live immediately for every workspace on Autopilot.\n');
        process.exit(1);
    }
    if (shiftDays != null && (!Number.isFinite(shiftDays) || shiftDays < 0)) {
        console.error('  --shift-days must be a whole number of days, zero or more.\n');
        process.exit(1);
    }

    // attempt = 0, because these never had a real attempt: three calls to an API that could not
    // answer is not three tries at writing the post. next_retry_at = now() so the next tick takes
    // them. Oldest first — the customer has been waiting longest for those.
    // ── ⚠️ ONLY THE SLOTS THAT HAVE PASSED ──────────────────────────────────────────────────────
    // The first version of this shifted every job in the batch, and the first real dry run showed
    // why that is wrong: of 1,834 eligible jobs only 275 carried a stale slot. A job is enqueued
    // AHEAD of the slot it is for, so most of this backlog is still correctly dated — shifting all
    // of them would have moved about 1,500 perfectly good posts eight days later than the customer
    // asked for, silently, and called it a recovery.
    //
    // The shift is applied to the slot, not to created_at: the ORDER BY below still releases the
    // jobs the customer has been waiting longest for first, and the stale slots keep their spacing
    // relative to each other.
    const shiftSql = shiftDays
        ? `, target_publish_date = CASE
                 WHEN target_publish_date < now()
                 THEN target_publish_date + interval '${shiftDays} days'
                 ELSE target_publish_date
               END`
        : '';
    const updated = await db.execute<{ id: number; organisation_id: number }>(
        `UPDATE content_generation_jobs
            SET status = 'queued', attempt = 0, next_retry_at = now(),
                error_message = NULL, updated_at = now()${shiftSql}
          WHERE id IN (
                SELECT id FROM (
                    -- ⚠️ ONE job per slot. A failed job does not cover its slot, so while drafting was
                    -- down gap-fill enqueued a fresh one EVERY HOUR — ~30 per slot by the end of the
                    -- 2026-09 outage — and requeuing them all drafted ~30 posts per slot on
                    -- 2026-09-30. The weekly Short is its own stream (same slot time, on purpose), so
                    -- it is kept apart in the key. The newest job per slot is kept.
                    SELECT DISTINCT ON (assistant_id, target_publish_date,
                                        (platform = 'youtube' AND crosspost_group_id IS NULL))
                           id, created_at
                      FROM content_generation_jobs ${where}
                       -- And none at all for a slot that already holds a live post.
                       AND NOT EXISTS (
                           SELECT 1 FROM scheduled_posts sp
                            WHERE sp.assistant_id = content_generation_jobs.assistant_id
                              AND sp.publish_date = content_generation_jobs.target_publish_date
                              AND sp.status IN ('draft','pending_approval','in_review','approved','scheduled'))
                       -- …or already has a job waiting for it (a previous batch of this script).
                       AND NOT EXISTS (
                           SELECT 1 FROM content_generation_jobs q
                            WHERE q.assistant_id = content_generation_jobs.assistant_id
                              AND q.target_publish_date = content_generation_jobs.target_publish_date
                              AND q.status IN ('queued','processing'))
                     ORDER BY assistant_id, target_publish_date,
                              (platform = 'youtube' AND crosspost_group_id IS NULL), created_at DESC
                ) one_per_slot
                ORDER BY created_at LIMIT ${limit})
      RETURNING id, organisation_id`
    );
    console.log(`  Requeued ${updated.length} job${updated.length === 1 ? '' : 's'} (at most one per slot).`);
    console.log('  The rest are duplicates of a slot now queued or already filled, and stay failed on purpose.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
