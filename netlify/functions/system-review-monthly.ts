// system-review-monthly.ts — System Map Phase 3 (docs/system-map-plan.md). Scheduled (netlify.toml,
// 2nd of the month 05:00 UTC; scheduled functions run on PRODUCTION only): queues a "better options"
// check for every reviewable system and wakes system-review-background.ts. ~16 checks × ~4 web
// searches on Opus 5.5 — every call is logged to ai_usage_log (tokens + searches).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { REVIEWABLE_SYSTEMS, queueSystemReviews, startReviewWorker } from '../../src/utils/system-review';

export default withLambda(async () => {
    const db = getDb();
    const ids = await queueSystemReviews(db, [...REVIEWABLE_SYSTEMS], 'monthly', null);
    const problem = await startReviewWorker(process.env.BASE_URL || 'https://bemoreswan.com', ids);
    if (problem) console.error('[system-review-monthly]', problem);
    else console.log(`[system-review-monthly] queued ${ids.length} checks`);
    return { statusCode: 200, body: JSON.stringify({ queued: ids.length, problem }) };
});
