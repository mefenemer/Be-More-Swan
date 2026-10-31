// netlify/functions/video-autopilot.ts
// Video Producer autopilot: daily — for each active Video Producer whose owner turned autopilot on,
// write the next storyboard when one is due (src/utils/video-autopilot.ts). Storyboards only: making
// the video is the owner's click on "Make the video", so this run never spends a credit.
//
// Schedule: "30 5 * * *" (05:30 UTC daily) — after blog-horizon-fill (05:00), so the two do not
// contend for the same Neon compute window. Planning runs in process-video-project-background.

import { getDb } from '../../db/client';
import { runVideoAutopilot } from '../../src/utils/video-autopilot';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    // Scheduled invocations, and a manual POST for testing (as blog-horizon-fill).
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    const result = await runVideoAutopilot(getDb());
    console.log('[video-autopilot]', JSON.stringify(result));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ran: true, ...result }) };
});
