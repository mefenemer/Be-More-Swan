// netlify/functions/mentor-review-background.ts
// The Business Mentor's weekly-review worker: writes one review (src/utils/mentor-review.ts,
// runMentorReview). Woken by the daily dispatch (dispatch-mentor-reviews.ts / run-mentor-review-dispatch.ts)
// and by "Review my week now" (mentor.ts review_now).
//
// A background function because the review runs on the Mentor's model (Opus 5.5 by default, not held to
// Low thinking) and can outrun the 26 s a synchronous function gets. runMentorReview never throws and
// always ends the row; one this worker never reaches is ended (free) by the stale sweep.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runMentorReview } from '../../src/utils/mentor-review';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a workspace's tasks.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[mentor-review-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let reviewId = 0;
    try { reviewId = Number(JSON.parse(event.body || '{}').reviewId); } catch { /* handled below */ }
    if (!Number.isInteger(reviewId) || reviewId <= 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'reviewId required.' }) };

    await runMentorReview(getDb(), reviewId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
