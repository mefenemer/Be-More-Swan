// netlify/functions/run-autonomous-drafts-background.ts
// The daily autonomous drafter's working lane. The cron (autonomous-media-suggestions.ts) starts this and
// returns; the `-background` suffix gives it fifteen minutes.
//
// It walks every opted-in assistant in turn, and each one is a caption, a picture prompt, an image and a
// confidence score. Inside a scheduled function's limit of seconds a run could be killed part-way, with
// the assistants at the end of the list never reached.
//
// AUTH: the same shared secret as the other background drains, failing closed. Unlike a queue, this
// spends a customer's credits on every run it is asked for, so it must not be open.

import { withLambda } from '@netlify/aws-lambda-compat';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { runAutonomousDrafts } from './autonomous-media-suggestions';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-autonomous-drafts-background] CRON_TRIGGER_SECRET is not set — trigger disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        // Logged because this is invisible from outside: Netlify answers 202 before the handler runs.
        console.warn('[run-autonomous-drafts-background] rejected a poke with a bad or missing token — no drafts today.');
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    if (await isGlobalAiDisabled()) {
        console.warn('[run-autonomous-drafts-background] global AI kill switch is ON — nothing drafted.');
        return { statusCode: 200, body: JSON.stringify({ ok: true, ran: false, reason: 'ai_disabled' }) };
    }

    try {
        const summary = await runAutonomousDrafts({ imageWriter: true });
        console.log('[run-autonomous-drafts-background]', JSON.stringify(summary));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...summary }) };
    } catch (err) {
        // 200, not 500: an error status invites a platform retry, and a second run costs credits. The
        // once-a-day guard in runAutonomousDrafts protects against one anyway; tomorrow's run picks this up.
        console.error('[run-autonomous-drafts-background] run failed:', err);
        return { statusCode: 200, body: JSON.stringify({ ok: false }) };
    }
});
