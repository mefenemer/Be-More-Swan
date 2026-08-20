// netlify/functions/process-newsletter-sequences.ts
// Scheduled worker: send the next due welcome-sequence step. See netlify.toml.
//
// Thin, like process-newsletter-sends.ts — every safety property lives in
// src/utils/newsletter-sequence.ts so the same code can be driven from a test or a manual trigger.

import { getDb } from '../../db/client';
import { processDueSequenceSteps } from '../../src/utils/newsletter-sequence';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl((event.headers || {}) as Record<string, string | undefined>);
    if (!baseUrl) {
        // Every footer needs an absolute unsubscribe link, and a welcome email is the first thing a
        // new subscriber sees. Refusing beats sending one they cannot leave.
        console.error('[process-newsletter-sequences] no BASE_URL — refusing to send without a working unsubscribe link');
        return { statusCode: 500, body: JSON.stringify({ error: 'BASE_URL is not configured.' }) };
    }

    const db = getDb();
    try {
        const result = await processDueSequenceSteps(db, { baseUrl });
        // One line per tick, so a schedule that silently stopped firing is visible in the log.
        console.log('[process-newsletter-sequences]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify(result) };
    } catch (err) {
        // A missing table means db/newsletter-sequences.sql has not been applied here. Degrade to
        // "no welcome emails" rather than erroring the scheduled invocation — but say which it is,
        // because the symptom is identical to "nobody subscribed this week".
        const code = (err as { code?: string; cause?: { code?: string } })?.code
            ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code === '42P01') {
            console.error('[process-newsletter-sequences] sequence tables are missing — db/newsletter-sequences.sql has not been applied here');
            return { statusCode: 200, body: JSON.stringify({ due: 0, needsSetup: true }) };
        }
        throw err;
    }
});
