// netlify/functions/platform-watchdog.ts
// Are our monitors running, and what did they last conclude? Read from OUTSIDE Netlify by
// .github/workflows/prod-watchdog.yml.
//
// ── Why this is a separate endpoint ─────────────────────────────────────────────────────────────
// check-content-generation-health and check-provider-balances alert through an email sent from
// inside Netlify. When the alert path itself is what broke — the schedule stopped firing, the
// function throws before alerting, Resend refuses the send — they fall silent, and silence reads as
// "healthy". This endpoint reads the heartbeats they stamp (src/utils/monitor-heartbeat.ts) and
// answers 503 when a monitor has stopped, could not alert, or is reporting an outage still open.
// GitHub notifies on a failed workflow run through its OWN email, so the failure reaches a human
// through a channel that shares nothing with ours. (The DB is the one shared dependency, and a DB
// outage makes this endpoint fail too, which the workflow also reports.)
//
// It sends nothing and probes nothing: it only reads two rows' worth of state. Cheap enough to call
// hourly, and it cannot itself cause an alert storm.
//
// AUTH: CRON_TRIGGER_SECRET as `Authorization: Bearer <secret>`, like the run-* wrappers. Fails
// closed (503 "not configured") when unset — the workflow then fails loudly, which is correct: an
// unconfigured watchdog is not watching.
//
// GET|POST /.netlify/functions/platform-watchdog  → 200 { ok: true, … } | 503 { ok: false, failures, … }

import { withLambda } from '@netlify/aws-lambda-compat';
import { CONFIG_KEYS, getPlatformConfig, invalidatePlatformConfig } from '../../src/utils/platform-config';
import { assessHeartbeats, type HeartbeatLog } from '../../src/utils/monitor-heartbeat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[platform-watchdog] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return json(503, { ok: false, failures: ['Watchdog not configured: CRON_TRIGGER_SECRET is not set on this deploy.'] });
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return json(401, { ok: false, error: 'Unauthorized.' });

    try {
        invalidatePlatformConfig(CONFIG_KEYS.MONITOR_HEARTBEAT);
        const raw = await getPlatformConfig(CONFIG_KEYS.MONITOR_HEARTBEAT);
        const log: HeartbeatLog = raw && typeof raw === 'object' ? (raw as HeartbeatLog) : {};
        const verdict = assessHeartbeats(log, new Date());
        return json(verdict.ok ? 200 : 503, verdict);
    } catch (err) {
        console.error('[platform-watchdog] could not read heartbeats', err);
        return json(503, { ok: false, failures: [`Could not read monitor heartbeats: ${err instanceof Error ? err.message : String(err)}`] });
    }
});
