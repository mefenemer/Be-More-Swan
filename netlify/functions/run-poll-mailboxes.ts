// netlify/functions/run-poll-mailboxes.ts
// On-demand HTTP trigger for the 10-minute mailbox poll (poll-mailboxes.ts).
//
// WHY THIS EXISTS: poll-mailboxes declares `config.schedule`, and Netlify refuses a direct URL call to
// a scheduled function on a deployed site with a bare 403 — the handler never runs, so its own
// CRON_TRIGGER_SECRET check never gets a say. Every staging-crons.yml run from 2026-11-14 failed on
// that 403. Same split as every other staging job: the scheduled function for production, a plain
// `run-*` wrapper for .github/workflows/staging-crons.yml.
//
// AUTH: CRON_TRIGGER_SECRET as `Authorization: Bearer <secret>`; refuses to run when unset (fail closed).
//
// POST /.netlify/functions/run-poll-mailboxes → 200 { ok: true, due, dispatched }

import { withLambda } from '@netlify/aws-lambda-compat';
import { pollDueMailboxes } from './poll-mailboxes';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-poll-mailboxes] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await pollDueMailboxes();
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[run-poll-mailboxes]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
