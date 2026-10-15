// netlify/functions/send-review-requests.ts — asks customers for a review, once, a set time after a
// confirmed booking ends or a website order is paid (src/utils/review-requests.ts has the rules).
// Scheduled hourly (netlify.toml). Off for every workspace until its owner turns it on in Business
// Information ▸ Reviews. A request is a message, not AI work: no tasks.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { sendDueReviewRequests } from '../../src/utils/review-requests';

export default withLambda(async () => {
    try {
        const sent = await sendDueReviewRequests(getDb(), new Date());
        if (sent) console.log(`[send-review-requests] sent ${sent}`);
        return { statusCode: 200, body: JSON.stringify({ sent }) };
    } catch (err) {
        console.error('[send-review-requests] failed', err instanceof Error ? err.message : err);
        return { statusCode: 500, body: 'failed' };
    }
});
