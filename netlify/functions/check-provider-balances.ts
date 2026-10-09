// netlify/functions/check-provider-balances.ts
// Is fal, Anthropic or Stability out of money (or refusing our key)? Are AI images or videos failing
// across workspaces for any other reason? Emails the founder address when so.
//
// Scheduled every 6h (netlify.toml). The probes and the rules live in src/utils/provider-balance.ts,
// which says why this exists: two provider accounts ran dry within two weeks of each other and no
// human was told either time.
//
// ── Cooldown, per provider ──────────────────────────────────────────────────────────────────────
// An unchanged problem re-alerts at most every 6h ('down') or 24h ('low' — a warning, not an
// outage). An ESCALATION alerts at once: "fal is low" followed by "fal has locked" is news, and
// waiting out a warning's cooldown to say so is how the lock goes unread for a day.
//
// Like check-content-generation-health: alerts the OPERATOR only, and a failed send is logged
// loudly rather than crashing the run.

import { getDb } from '../../db/client';
import { CONFIG_KEYS, getPlatformConfig, setPlatformConfig } from '../../src/utils/platform-config';
import { sendEmail } from '../../src/utils/email';
import {
    readFalBalance, probeAnthropic, assessProviders, FAL_LOCK_PATTERN, DEFAULT_FAL_LOW_BALANCE_USD,
    readStabilityBalance, DEFAULT_STABILITY_LOW_BALANCE_CREDITS,
    type FalLockEvidence, type MediaFailureEvidence, type ProviderProblem,
} from '../../src/utils/provider-balance';
import { recordHeartbeat } from '../../src/utils/monitor-heartbeat';
import { withLambda } from '@netlify/aws-lambda-compat';

const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';
const COOLDOWN_HOURS: Record<ProviderProblem['severity'], number> = { down: 6, low: 24 };

type AlertLog = Partial<Record<ProviderProblem['provider'], { at: string; severity: ProviderProblem['severity'] }>>;

/** Should this problem be emailed now, given what we last sent about the same provider? */
export function dueForAlert(problem: ProviderProblem, log: AlertLog, now: Date): boolean {
    const last = log[problem.provider];
    if (!last) return true;
    if (last.severity === 'low' && problem.severity === 'down') return true;   // escalation
    const hours = (now.getTime() - new Date(last.at).getTime()) / 3_600_000;
    return !(hours < COOLDOWN_HOURS[problem.severity]);
}

async function readFalEvidence(): Promise<FalLockEvidence> {
    const db = getDb();
    const [row] = await db.execute<{ failures: number; organisations: number; latest_at: string | null; sample: string | null; last_success_at: string | null }>(
        `SELECT count(*)::int AS failures,
                count(DISTINCT organisation_id)::int AS organisations,
                max(created_at) AS latest_at,
                left(min(error_message), 200) AS sample,
                (SELECT max(created_at) FROM content_assets WHERE provider = 'fal') AS last_success_at
           FROM media_generation_jobs
          WHERE status = 'failed'
            AND created_at > now() - interval '24 hours'
            AND error_message ~ '${FAL_LOCK_PATTERN}'`
    );
    return {
        failures: Number(row?.failures ?? 0),
        organisations: Number(row?.organisations ?? 0),
        latestAt: row?.latest_at ? new Date(row.latest_at).toISOString() : null,
        sample: row?.sample ?? null,
        lastSuccessAt: row?.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    };
}

/**
 * AI image/video failures that are NOT the lock, per media type (see MediaFailureEvidence).
 * ⚠️ Excludes what is not a platform fault: the lock pattern (its own rule — counting it twice would
 * send two emails for one outage), operator clean-up (`Superseded:`, as in the content check), and a
 * job whose owner was deleted. 'flagged' is a content-policy refusal of one user's prompt — never
 * counted. A job queued or processing for over an hour is STUCK: the background function died and
 * nothing will ever settle it.
 */
export async function readMediaFailureEvidence(db: Pick<ReturnType<typeof getDb>, 'execute'> = getDb()): Promise<MediaFailureEvidence[]> {
    const rows = await db.execute<{ media_type: string; failures: number; stuck: number; organisations: number; latest_at: string | null; top_error: string | null; last_success_at: string | null }>(
        `WITH bad AS (
            SELECT media_type, organisation_id, updated_at,
                   CASE WHEN status = 'failed' THEN left(error_message, 180)
                        ELSE 'stuck in ' || status || ' for over an hour' END AS error,
                   (status = 'failed') AS failed
              FROM media_generation_jobs
             WHERE (status = 'failed'
                    AND updated_at > now() - interval '24 hours'
                    AND coalesce(error_message, '') !~ '${FAL_LOCK_PATTERN}'
                    AND coalesce(error_message, '') NOT LIKE 'Superseded:%'
                    AND coalesce(error_message, '') <> 'Owning user no longer exists.')
                OR (status IN ('queued', 'processing')
                    AND created_at > now() - interval '24 hours'
                    AND updated_at < now() - interval '1 hour')
         ), top AS (
            SELECT DISTINCT ON (media_type) media_type, error
              FROM (SELECT media_type, error, count(*) AS n FROM bad GROUP BY media_type, error) e
             ORDER BY media_type, n DESC
         )
         SELECT b.media_type,
                count(*) FILTER (WHERE b.failed)::int AS failures,
                count(*) FILTER (WHERE NOT b.failed)::int AS stuck,
                count(DISTINCT b.organisation_id)::int AS organisations,
                max(b.updated_at) AS latest_at,
                max(t.error) AS top_error,
                (SELECT max(created_at) FROM content_assets
                  WHERE provider = 'fal' AND asset_type = b.media_type) AS last_success_at
           FROM bad b LEFT JOIN top t ON t.media_type = b.media_type
          GROUP BY b.media_type`
    );
    return rows
        .filter(r => r.media_type === 'image' || r.media_type === 'video')
        .map(r => ({
            mediaType: r.media_type as 'image' | 'video',
            failures: Number(r.failures ?? 0),
            stuck: Number(r.stuck ?? 0),
            organisations: Number(r.organisations ?? 0),
            latestAt: r.latest_at ? new Date(r.latest_at).toISOString() : null,
            topError: r.top_error ?? null,
            lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
        }));
}

/**
 * Run the check and stamp its heartbeat. ⚠️ A run that THROWS stamps nothing, deliberately: the
 * heartbeat goes stale and platform-watchdog reports the check as not running.
 */
export async function runProviderBalanceCheck() {
    const result = await evaluateProviderBalances();
    await recordHeartbeat('provider_balances', {
        // Every OPEN problem, not just the ones due an email: the watchdog says "still down" even
        // while this check sits out its cooldown.
        problems: result.open.filter(p => p.severity === 'down').map(p => p.headline),
        warnings: result.open.filter(p => p.severity === 'low').map(p => p.headline),
        alertFailed: result.alertFailed,
    });
    const { open: _open, alertFailed: _failed, ...summary } = result;
    return summary;
}

async function evaluateProviderBalances() {
    const now = new Date();
    const lowLine = Number(process.env.FAL_LOW_BALANCE_USD) || DEFAULT_FAL_LOW_BALANCE_USD;
    const stabilityLow = Number(process.env.STABILITY_LOW_BALANCE_CREDITS) || DEFAULT_STABILITY_LOW_BALANCE_CREDITS;
    const [fal, anthropic, stability, falEvidence, mediaFailures] = await Promise.all([
        readFalBalance(),
        probeAnthropic(),
        readStabilityBalance(),
        readFalEvidence().catch((err): FalLockEvidence => {
            console.error('[check-provider-balances] fal evidence query failed:', err);
            return { failures: 0, organisations: 0, latestAt: null, sample: null, lastSuccessAt: null };
        }),
        // ⚠️ A failed read is logged and treated as "nothing seen" — same as the lock evidence: the
        // balance probes must still run and alert when this query breaks.
        readMediaFailureEvidence().catch((err): MediaFailureEvidence[] => {
            console.error('[check-provider-balances] media failure query failed:', err);
            return [];
        }),
    ]);
    const problems = assessProviders({
        fal, falEvidence, anthropic, falLowBalanceUsd: lowLine, stability, stabilityLowBalanceCredits: stabilityLow, mediaFailures,
    });
    const summary = { fal, anthropic, stability, falEvidence, mediaFailures, problems: problems.map(p => p.headline) };
    // Always logged: with no alert, this line is the only record that the check ran and what it saw.
    console.log('[check-provider-balances]', JSON.stringify(summary));

    const raw = await getPlatformConfig(CONFIG_KEYS.PROVIDER_BALANCE_LAST_ALERT);
    const log: AlertLog = raw && typeof raw === 'object' ? { ...(raw as AlertLog) } : {};
    const due = problems.filter(p => dueForAlert(p, log, now));
    const open = problems;
    if (due.length === 0) return { ...summary, alerted: false, open, alertFailed: false };

    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const worst = due.some(p => p.severity === 'down') ? 'DOWN' : 'LOW';
    try {
        await sendEmail({
            to: FOUNDER_EMAIL,
            subject: `[Be More Swan] AI provider ${worst}: ${due.map(p => p.headline).join('; ')}`,
            html: due.map(p => `<h3 style="margin:16px 0 6px">${esc(p.headline)}</h3><ul>${p.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')
                + (fal.status === 'no_access'
                    ? `<p style="color:#666;font-size:12px">fal's balance could not be read (HTTP ${fal.httpStatus}) — the billing endpoint needs an ADMIN key. Set FAL_ADMIN_KEY to get a low-balance warning before the lock, not just the lock.</p>`
                    : ''),
            text: due.map(p => `${p.headline}\n${p.lines.map(l => `- ${l}`).join('\n')}`).join('\n\n'),
        });
        for (const p of due) log[p.provider] = { at: now.toISOString(), severity: p.severity };
        await setPlatformConfig(CONFIG_KEYS.PROVIDER_BALANCE_LAST_ALERT, log);
        return { ...summary, alerted: true, open, alertFailed: false };
    } catch (err) {
        console.error('[check-provider-balances] ALERT SEND FAILED — a provider is out and nobody has been told', err);
        return { ...summary, alerted: false, open, alertFailed: true };
    }
}

export default withLambda(async () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await runProviderBalanceCheck()),
}));
