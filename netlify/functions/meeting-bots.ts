// netlify/functions/meeting-bots.ts — send the Note Taker into a call, list its bots, take one out
// (docs/note-taker-bot-plan.md §4). The GUI dialog and the chat card both come here, so a bot is sent one way only
// (src/utils/meeting-bot-db.ts sendMeetingBot). Behind the meeting_bot flag and DPA 1.2.
//
//   GET  ?assistantId=N                                   → 200 { available, dpaAccepted, tasksPer5Min, bots: MeetingBotView[] }
//        available = the meeting_bot flag is on for this workspace (the GUI shows nothing otherwise)
//        zoom = { connected, accountName, canDisconnect } while the meeting_bot_zoom flag is on (Connect Zoom in the dialog), else null
//   POST { action: 'send', assistantId, meetingUrl, title?, joinAt?, lengthLimitMinutes?, source? }
//                                                         → 200 { bot, alreadySent } | 4xx/5xx { error, code }
//   POST { action: 'remove', botId }                      → 200 { bot } | 4xx/5xx { error }

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { hasAcceptedBotDpa, hasAcceptedBotTerms, listMeetingBots, meetingBotAvailable, removeMeetingBot, sendMeetingBot } from '../../src/utils/meeting-bot-db';
import { MEETING_BOT_FLAG, MEETING_BOT_ZOOM_FLAG } from '../../src/utils/meeting-bot';
import { getIntegration } from '../../src/utils/workspace-integrations';
// Only this function imports the pictures (the one place a bot is sent), so no other bundle carries them: the
// workspace's own picture is drawn here (meeting-bot-tile.ts, canvas loaded on send only), the fallback is fixed.
import { BOT_TILE_NOT_RECORDING_JPEG_B64, BOT_TILE_RECORDING_JPEG_B64 } from '../../src/utils/meeting-bot-tile-data';
import { drawBotTiles } from '../../src/utils/meeting-bot-tile';
import { isFeatureEnabled } from '../../src/utils/feature-flags';
import { getTaskCosts, getUpcomingTaskCosts } from '../../src/utils/task-costs';
import { canAccessAssistant } from '../../src/utils/assistant-access';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId, assistantAccess, role } = ctx;

    /** The workspace's Zoom connection, only while Zoom is switched on for it (plan B7: after Zoom's review). */
    async function zoomState(orgId: number): Promise<{ connected: boolean; accountName: string | null; canDisconnect: boolean } | null> {
        if (!(await isFeatureEnabled(orgId, MEETING_BOT_ZOOM_FLAG))) return null;
        const row = await getIntegration(db, orgId, 'zoom');
        // Disconnecting is for owners and admins (oauth-integrations.ts disconnect); members are told who can.
        return { connected: !!row && row.status === 'active', accountName: row?.status === 'active' ? row.externalAccountName ?? null : null, canDisconnect: role === 'owner' || role === 'admin' };
    }

    if (event.httpMethod === 'GET') {
        const assistantId = Number(event.queryStringParameters?.assistantId);
        if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });
        if (!canAccessAssistant(assistantAccess, assistantId)) return json(404, { error: 'Meeting assistant not found in this workspace.' });
        const available = await meetingBotAvailable(db, organisationId);
        if (!available) return json(200, { available: false, dpaAccepted: false, termsAccepted: false, tasksPer5Min: 0, bots: [] });
        try {
            const [bots, dpaAccepted, termsAccepted, costs, upcoming, zoom] = await Promise.all([
                listMeetingBots(db, organisationId, assistantId), hasAcceptedBotDpa(db, organisationId), hasAcceptedBotTerms(db, userId),
                getTaskCosts(), getUpcomingTaskCosts(), zoomState(organisationId),
            ]);
            // The announced price, so the dialog can say "free until 1 January 2027, then …" (task-costs.ts getUpcomingTaskCosts).
            const next = upcoming.meeting_bot_call ?? null;
            return json(200, { available: true, dpaAccepted, termsAccepted, tasksPer5Min: costs.weights.meeting_bot_call, nextTasksPer5Min: next ? { units: next.units, from: next.from } : null, zoom, bots });
        } catch (err) {
            console.error('[meeting-bots] list failed', err instanceof Error ? err.message : err);
            return json(200, { available: true, dpaAccepted: false, termsAccepted: false, tasksPer5Min: 0, bots: [] });
        }
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    if (body.action === 'remove') {
        const botId = Number(body.botId);
        if (!Number.isInteger(botId) || botId <= 0) return json(400, { error: 'botId is required.' });
        const r = await removeMeetingBot(db, organisationId, botId, assistantAccess);
        return r.ok ? json(200, { bot: r.bot }) : json(r.status, { error: r.error });
    }
    if (body.action !== 'send') return json(400, { error: 'Unknown action.' });

    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });
    // requireTenant already refuses a named assistant outside a member's list; checked here too, as remove must.
    if (!canAccessAssistant(assistantAccess, assistantId)) return json(404, { error: 'Meeting assistant not found in this workspace.' });
    const r = await sendMeetingBot(db, {
        organisationId, userId, assistantId,
        meetingUrl: body.meetingUrl, title: body.title, joinAt: body.joinAt, lengthLimitMinutes: body.lengthLimitMinutes,
        source: body.source === 'chat' ? 'chat' : 'link',
        videoTile: { recordingJpegB64: BOT_TILE_RECORDING_JPEG_B64, notRecordingJpegB64: BOT_TILE_NOT_RECORDING_JPEG_B64 },
        tileFor: drawBotTiles,
        baseUrl: resolveBaseUrl(event.headers),
    });
    return r.ok ? json(200, { bot: r.bot, alreadySent: r.alreadySent }) : json(r.status, { error: r.error, code: r.code });
});
