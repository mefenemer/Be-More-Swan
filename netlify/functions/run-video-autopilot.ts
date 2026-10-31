// netlify/functions/run-video-autopilot.ts
// On-demand HTTP trigger for the Video Producer's autopilot (video-autopilot.ts). Netlify runs
// scheduled functions ONLY on the production deploy, so staging needs this wrapper, poked by
// .github/workflows/staging-crons.yml. Mirrors run-site-directory-dispatch.ts. Storyboards only —
// it never makes a video, so it never spends.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed.
//
// POST /.netlify/functions/run-video-autopilot → 200 { ok, checked, planned, … } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runVideoAutopilot } from '../../src/utils/video-autopilot';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-video-autopilot] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await runVideoAutopilot(getDb());
        console.log('[run-video-autopilot]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[run-video-autopilot] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
