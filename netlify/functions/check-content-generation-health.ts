// netlify/functions/check-content-generation-health.ts
// Is content generation working for ANYBODY? Alerts a human when it is not.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// ⚠️ Between 2026-09-17 and 2026-09-28, every AI draft on production failed. The Anthropic account's
// credit balance had run out, and a credit failure arrives as a 400 — so there was no failover, no
// retry that could ever succeed, and 1,829 jobs across ALL FIVE organisations marked themselves
// terminally failed. Eleven days. Four paying workspaces got nothing.
//
// Nothing was broken about the detection. There simply was none. Each failure notified the owner of
// the workspace it happened in, and nobody sees five workspaces at once — so the outage was
// perfectly visible five times over and invisible in aggregate. A failure that is only ever reported
// to the person it happened to is not reported.
//
// ── What it watches, and why those two numbers ──────────────────────────────────────────────────
// Failures ACROSS organisations, and the last successful AI call anywhere.
//
// One workspace failing is that workspace's problem — a bad blueprint, an empty knowledge base, a
// model that will not produce JSON for one awkward prompt. Several workspaces failing at once is
// ours, always, because they share nothing except us. So the alert is keyed on the spread, not the
// count: two organisations is a platform fault at any volume.
//
// ai_usage_log is written ONLY on success, which makes it the cheapest liveness check we have —
// during the outage it showed thirteen calls in seven days for the whole platform. ⚠️ It is read
// alongside the failures and never alone: ten of those thirteen landed in the final 24 hours, while
// failures carried on. A nonzero success count does not mean healthy.
//
// ── Correlated failure, stated rather than pretended away ───────────────────────────────────────
// This runs on the same Netlify scheduler as the drain it watches, so a scheduler outage takes both.
// It catches what actually happened here — an upstream refusing every call — and the ordinary
// faults: a bad deploy, an exception in the drain, a schedule entry that stopped matching a
// filename. The uncorrelated watcher is .github/workflows/prod-watchdog.yml, which reads this
// check's heartbeat through platform-watchdog.ts and fails (GitHub emails) when it goes stale.
// ⚠️ NOT staging-crons.yml, which this comment used to name: that pokes STAGING only.
//
// ── It alerts the OPERATOR, not the customer ────────────────────────────────────────────────────
// Customers already get the consequence, in their own words, from the job itself. Telling them our
// monitoring noticed adds alarm without an action they can take. The founder alert leads somewhere:
// it names the error and the organisations, because "generation is failing" sends you to the
// database before you can do anything, and this alert should be enough on a phone.
//
// POST-guarded like the other pokes so an external monitor can call it too.

import { getDb } from '../../db/client';
import { CONFIG_KEYS, getPlatformConfig, setPlatformConfig } from '../../src/utils/platform-config';
import { sendEmail } from '../../src/utils/email';
import { recordHeartbeat } from '../../src/utils/monitor-heartbeat';
import { withLambda } from '@netlify/aws-lambda-compat';

const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';

/** Six hours: see check-optimiser-health — hourly gets filtered, daily loses a working day. */
const ALERT_COOLDOWN_HOURS = 6;

/**
 * ⚠️ TWO organisations, not a count of jobs.
 *
 * Workspaces share nothing but us, so two of them failing in the same day is a platform fault at any
 * volume — and waiting for a volume threshold is how you miss the first morning of an outage. A
 * single workspace failing is left alone deliberately: that is its own content problem, and paging a
 * human for it would train them to ignore this alert.
 */
const ORGS_THAT_MEAN_PLATFORM = 2;

/**
 * ⚠️ Failures WE made on purpose are not failures.
 *
 * On 2026-09-30 the outage clean-up set 94 duplicate backlog jobs to `failed` with a message starting
 * `Superseded:`, and the next morning this check emailed that generation was failing for four
 * workspaces — while it was working everywhere. A job an operator retires is not one the platform
 * failed to draft. Any manual clean-up that marks jobs failed should start its message with this
 * prefix, and this check will step over them. (The drain's own slot guard says `Superseded:` too, but
 * it marks those jobs `completed`, so they were never counted.)
 */
const DELIBERATE_FAILURE_PREFIX = 'Superseded:';

export interface ContentHealthResult {
    failedJobs24h: number;
    organisationsAffected: number;
    topError: string | null;
    lastSuccessfulAiCall: string | null;
    successes24h: number;
    actionable: boolean;
    alerted: boolean;
    /** The alert was due and the send threw. */
    alertFailed?: boolean;
}

/**
 * Run the check and stamp its heartbeat. ⚠️ A run that THROWS stamps nothing, deliberately: the
 * heartbeat goes stale and platform-watchdog reports the check as not running — which it isn't.
 */
export async function runContentGenerationHealthCheck(): Promise<ContentHealthResult> {
    const result = await evaluateContentGenerationHealth();
    await recordHeartbeat('content_generation', {
        problems: result.actionable
            ? [`drafting failing in ${result.organisationsAffected} workspaces — ${result.failedJobs24h} jobs in 24h; top error: ${result.topError ?? 'not recorded'}`]
            : [],
        warnings: [],
        alertFailed: !!result.alertFailed,
    });
    return result;
}

async function evaluateContentGenerationHealth(): Promise<ContentHealthResult> {
    const db = getDb();
    const now = new Date();

    // Grouped by organisation AND error, so the error reported is the one that occurred MOST. It used
    // to be min(error_message) of the busiest organisation — the alphabetically first message, which
    // can be a minor one sitting in front of the real fault. Grouped on the first 180 characters,
    // because the stored message is the upstream body verbatim and ends in a per-request id: grouped
    // whole, every credit failure would be its own error of one.
    const rows = await db.execute<{ organisation_id: number; error: string | null; jobs: number }>(
        `SELECT organisation_id, left(error_message, 180) AS error, count(*)::int AS jobs
           FROM content_generation_jobs
          WHERE status = 'failed'
            AND updated_at > now() - interval '24 hours'
            AND coalesce(error_message, '') NOT LIKE '${DELIBERATE_FAILURE_PREFIX}%'
          GROUP BY organisation_id, error`
    );
    const byOrg = new Map<number, number>();
    const byError = new Map<string, number>();
    for (const r of rows) {
        const n = Number(r.jobs || 0);
        byOrg.set(r.organisation_id, (byOrg.get(r.organisation_id) ?? 0) + n);
        if (r.error) byError.set(r.error, (byError.get(r.error) ?? 0) + n);
    }
    const failures = [...byOrg].map(([organisation_id, jobs]) => ({ organisation_id, jobs }))
        .sort((a, b) => b.jobs - a.jobs);
    const organisationsAffected = failures.length;
    const failedJobs24h = failures.reduce((n, r) => n + r.jobs, 0);
    const topError = [...byError].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const [usage] = await db.execute<{ last_at: string | null; n24: number }>(
        `SELECT max(created_at) AS last_at,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS n24
           FROM ai_usage_log`
    );
    const lastSuccessfulAiCall = usage?.last_at ? new Date(usage.last_at).toISOString() : null;
    const successes24h = Number(usage?.n24 ?? 0);

    const actionable = organisationsAffected >= ORGS_THAT_MEAN_PLATFORM;
    const base = { failedJobs24h, organisationsAffected, topError, lastSuccessfulAiCall, successes24h };
    if (!actionable) return { ...base, actionable, alerted: false };

    const last = await getPlatformConfig(CONFIG_KEYS.CONTENT_GEN_LAST_ALERT);
    const lastAt = last && typeof last === 'object' && 'at' in (last as any)
        ? new Date(String((last as any).at)) : null;
    const sinceAlert = lastAt && !isNaN(lastAt.getTime())
        ? (now.getTime() - lastAt.getTime()) / 3_600_000 : Infinity;
    if (sinceAlert < ALERT_COOLDOWN_HOURS) return { ...base, actionable, alerted: false };

    const orgList = failures.map(r => `${r.organisation_id} (${r.jobs})`).join(', ');
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
        await sendEmail({
            to: FOUNDER_EMAIL,
            subject: `[Be More Swan] Content generation failing for ${organisationsAffected} workspaces — ${failedJobs24h} jobs in 24h`,
            html: `<p><strong>${failedJobs24h}</strong> content generation job${failedJobs24h === 1 ? '' : 's'} failed in the last 24 hours, across <strong>${organisationsAffected}</strong> organisations. Workspaces share nothing but us, so this is ours.</p>
<ul>
  <li>Organisations (failed jobs): ${esc(orgList)}</li>
  <li>Most common error: <code>${topError ? esc(topError) : 'not recorded'}</code></li>
  <li>Last successful AI call anywhere: ${lastSuccessfulAiCall ?? 'never'}</li>
  <li>Successful AI calls in 24h, whole platform: ${successes24h}</li>
</ul>
<p>If the error mentions a credit balance, the Anthropic account needs topping up — no code change
will help, and jobs are parked rather than failed for 72 hours, so they will generate themselves
once service returns. After that they fail terminally and need requeuing with
<code>scripts/requeue-failed-content-jobs.ts</code>.</p>`,
            text: `${failedJobs24h} content generation jobs failed in 24h across ${organisationsAffected} organisations.\n\n`
                + `Organisations (failed jobs): ${orgList}\nMost common error: ${topError ?? 'not recorded'}\n`
                + `Last successful AI call anywhere: ${lastSuccessfulAiCall ?? 'never'}\n`
                + `Successful AI calls in 24h: ${successes24h}\n`,
        });
        await setPlatformConfig(CONFIG_KEYS.CONTENT_GEN_LAST_ALERT, { at: now.toISOString(), organisationsAffected, failedJobs24h });
        return { ...base, actionable, alerted: true };
    } catch (err) {
        // ⚠️ Swallowed, but LOUDLY — a failed alert must not crash the check, and must not read as
        // a clean run either. See check-optimiser-health.
        console.error('[check-content-generation-health] ALERT SEND FAILED — generation is broken platform-wide and nobody has been told', err);
        return { ...base, actionable, alerted: false, alertFailed: true };
    }
}

export default withLambda(async () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await runContentGenerationHealthCheck()),
}));
