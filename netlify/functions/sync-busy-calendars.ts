// netlify/functions/sync-busy-calendars.ts — reads each owner's calendar for busy times, every 15
// minutes (netlify.toml; src/utils/calendar-sync.ts). Usually finds nothing to do. Not AI work: no tasks.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { syncDueCalendars } from '../../src/utils/calendar-sync';

export default withLambda(async () => {
    try {
        const done = await syncDueCalendars(getDb(), new Date());
        if (done) console.log(`[sync-busy-calendars] read ${done} calendars`);
        return { statusCode: 200, body: JSON.stringify({ done }) };
    } catch (err) {
        console.error('[sync-busy-calendars] failed', err instanceof Error ? err.message : err);
        return { statusCode: 500, body: 'failed' };
    }
});
