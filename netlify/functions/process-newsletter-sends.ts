// netlify/functions/process-newsletter-sends.ts
// Scheduled worker: push every due newsletter issue along by one batch. See netlify.toml.
//
// Deliberately thin — the work, and every safety property, lives in src/utils/newsletter-send.ts so
// the same code can be driven from a test or a manual trigger. Mirrors publish-blog-posts.ts.

import { getDb } from '../../db/client';
import { sendDueIssues } from '../../src/utils/newsletter-send';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl((event.headers || {}) as Record<string, string | undefined>);
    if (!baseUrl) {
        // Every footer needs an absolute unsubscribe link. Sending without one would be worse than
        // not sending, so this stops rather than guessing a host.
        console.error('[process-newsletter-sends] no BASE_URL — refusing to send without a working unsubscribe link');
        return { statusCode: 500, body: JSON.stringify({ error: 'BASE_URL is not configured.' }) };
    }

    const db = getDb();
    const result = await sendDueIssues(db, { baseUrl });

    // Logged as one line so a failing cron is visible in the function log — two nightly sweeps in
    // this codebase ran for months doing nothing, and nobody could tell.
    console.log('[process-newsletter-sends]', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
});
