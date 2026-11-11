// task-costs.ts — GET the task costs in force today, public. /task-costs.js puts them on the page.
//
// No sign-in: the Pricing page and the FAQ read it, and terms 5.2 promise the current weights are always
// shown there. Only the figures, nothing about any customer. Terms 5.2 is why this is the live number
// rather than one typed into the page.

import { getTaskCosts } from '../../src/utils/task-costs';
import { basicWorkCharged, videoPricedBySecond } from '../../src/config/task-weights';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const costs = await getTaskCosts();
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify({
            weights: costs.weights,
            videoTasksPerSecond: costs.videoTasksPerSecond,
            chatMessagesPerTask: costs.chatMessagesPerTask,
            videoPricedBySecond: videoPricedBySecond(),
            basicWorkCharged: basicWorkCharged(),
        }),
    };
});
