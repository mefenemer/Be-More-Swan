// netlify/functions/meeting-pickup.ts — every 15 minutes, find meetings that ended on Google Meet, Teams or Zoom and
// hand each one with a transcript to the background writer (docs/meeting-apps-pickup-plan.md §2,
// src/utils/meeting-pickup.ts). No platform is switched on yet (MEETING_SOURCES is empty), so today it finds nothing.
//
// ⚠️ Netlify runs scheduled functions on PRODUCTION only, and answers a direct URL call to one with a bare 403 before
// this handler runs. Staging is poked through run-meeting-pickup.ts instead.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runMeetingPickup } from '../../src/utils/meeting-pickup-db';
import { mayRunScheduled } from '../../src/utils/scheduled-run-auth';

export const config = { schedule: '*/15 * * * *' };

export default withLambda(async (event) => {
    if (!mayRunScheduled(event)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    const result = await runMeetingPickup(getDb());
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
});
