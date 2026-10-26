// netlify/functions/dispatch-mentor-reviews.ts
// The Business Mentor's weekly review — scheduled daily on PRODUCTION by netlify.toml
// ([functions.dispatch-mentor-reviews]). Queues the workspaces whose review day is today, or was earlier
// this week and missed (src/utils/mentor-review.ts dispatchDueReviews); each runs in
// mentor-review-background.ts.
//
// Staging never fires Netlify schedules, so run-mentor-review-dispatch.ts wraps the same function for
// .github/workflows/staging-crons.yml.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueReviews } from '../../src/utils/mentor-review';

export default withLambda(async () => {
    try {
        const result = await dispatchDueReviews(getDb());
        // One line per tick, so a schedule that has silently stopped firing is visible in the log.
        console.log('[dispatch-mentor-reviews]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[dispatch-mentor-reviews] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
