// netlify/functions/sync-busy-calendars.ts — reads each owner's calendar for busy times, every 15
// minutes (netlify.toml; src/utils/calendar-sync.ts), and keeps signed-in Outlook calendars in step both
// ways (calendar-microsoft.ts). Usually finds nothing to do. Not AI work: no tasks.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { syncDueCalendars } from '../../src/utils/calendar-sync';
import { microsoftOrgs, syncMicrosoft } from '../../src/utils/calendar-microsoft';

export default withLambda(async () => {
    try {
        const db = getDb();
        const started = Date.now();
        const done = await syncDueCalendars(db, new Date(), 12_000);
        // Signed-in Outlook calendars: busy times in, bookings out (calendar-microsoft.ts).
        let ms = 0;
        for (const orgId of await microsoftOrgs(db)) {
            if (Date.now() - started > 20_000) break;
            await syncMicrosoft(db, orgId, new Date());
            ms++;
        }
        if (done || ms) console.log(`[sync-busy-calendars] read ${done} iCal calendars, ${ms} Outlook calendars`);
        return { statusCode: 200, body: JSON.stringify({ done, ms }) };
    } catch (err) {
        console.error('[sync-busy-calendars] failed', err instanceof Error ? err.message : err);
        return { statusCode: 500, body: 'failed' };
    }
});
