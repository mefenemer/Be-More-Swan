// netlify/functions/meeting-bots.ts — send the Note Taker into a call, list its bots, take one out
// (docs/note-taker-bot-plan.md §4). The GUI dialog and the chat card both come here, so a bot is sent one way only
// (src/utils/meeting-bot-db.ts sendMeetingBot). Behind the meeting_bot flag and DPA 1.2.
//
//   GET  ?assistantId=N                                   → 200 { available, dpaAccepted, tasksPer5Min, bots: MeetingBotView[] }
//        available = the meeting_bot flag is on for this workspace (the GUI shows nothing otherwise)
//   POST { action: 'send', assistantId, meetingUrl, title?, joinAt?, lengthLimitMinutes?, source? }
//                                                         → 200 { bot, alreadySent } | 4xx/5xx { error, code }
//   POST { action: 'remove', botId }                      → 200 { bot } | 4xx/5xx { error }

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { hasAcceptedBotDpa, listMeetingBots, removeMeetingBot, sendMeetingBot } from '../../src/utils/meeting-bot-db';
import { MEETING_BOT_FLAG } from '../../src/utils/meeting-bot';
// Only this function imports the pictures (the one place a bot is sent), so no other bundle carries them: the
// workspace's own picture is drawn here (meeting-bot-tile.ts, canvas loaded on send only), the fallback is fixed.
import { BOT_TILE_NOT_RECORDING_JPEG_B64, BOT_TILE_RECORDING_JPEG_B64 } from '../../src/utils/meeting-bot-tile-data';
import { drawBotTiles } from '../../src/utils/meeting-bot-tile';
import { isFeatureEnabled } from '../../src/utils/feature-flags';
import { getTaskCosts } from '../../src/utils/task-costs';
import { canAccessAssistant } from '../../src/utils/assistant-access';
import { requireTenant } from '../../src/utils/tenant';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId, assistantAccess } = ctx;

    if (event.httpMethod === 'GET') {
        const assistantId = Number(event.queryStringParameters?.assistantId);
        if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });
        if (!canAccessAssistant(assistantAccess, assistantId)) return json(404, { error: 'Meeting assistant not found in this workspace.' });
        const available = await isFeatureEnabled(organisationId, MEETING_BOT_FLAG).catch(() => false);
        if (!available) return json(200, { available: false, dpaAccepted: false, tasksPer5Min: 0, bots: [] });
        try {
            const [bots, dpaAccepted, costs] = await Promise.all([
                listMeetingBots(db, organisationId, assistantId), hasAcceptedBotDpa(db, organisationId), getTaskCosts(),
            ]);
            return json(200, { available: true, dpaAccepted, tasksPer5Min: costs.weights.meeting_bot_call, bots });
        } catch (err) {
            console.error('[meeting-bots] list failed', err instanceof Error ? err.message : err);
            return json(200, { available: true, dpaAccepted: false, tasksPer5Min: 0, bots: [] });
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
    });
    return r.ok ? json(200, { bot: r.bot, alreadySent: r.alreadySent }) : json(r.status, { error: r.error, code: r.code });
});
