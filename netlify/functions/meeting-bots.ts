// netlify/functions/meeting-bots.ts — send the Note Taker into a call, list its bots, take one out
// (docs/note-taker-bot-plan.md §4). The GUI dialog and the chat card both come here, so a bot is sent one way only
// (src/utils/meeting-bot-db.ts sendMeetingBot). Behind the meeting_bot flag and DPA 1.2.
//
//   GET  ?assistantId=N                                   → 200 { bots: MeetingBotView[] }
//   POST { action: 'send', assistantId, meetingUrl, title?, joinAt?, lengthLimitMinutes?, source? }
//                                                         → 200 { bot, alreadySent } | 4xx/5xx { error, code }
//   POST { action: 'remove', botId }                      → 200 { bot } | 4xx/5xx { error }

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { listMeetingBots, removeMeetingBot, sendMeetingBot } from '../../src/utils/meeting-bot-db';
import { requireTenant } from '../../src/utils/tenant';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    if (event.httpMethod === 'GET') {
        const assistantId = Number(event.queryStringParameters?.assistantId);
        if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });
        try {
            return json(200, { bots: await listMeetingBots(db, organisationId, assistantId) });
        } catch (err) {
            // The table may not exist yet (z-meeting-bots.sql not applied): nothing sent, nothing to list.
            console.error('[meeting-bots] list failed', err instanceof Error ? err.message : err);
            return json(200, { bots: [] });
        }
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    if (body.action === 'remove') {
        const botId = Number(body.botId);
        if (!Number.isInteger(botId) || botId <= 0) return json(400, { error: 'botId is required.' });
        const r = await removeMeetingBot(db, organisationId, botId);
        return r.ok ? json(200, { bot: r.bot }) : json(r.status, { error: r.error });
    }
    if (body.action !== 'send') return json(400, { error: 'Unknown action.' });

    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });
    const r = await sendMeetingBot(db, {
        organisationId, userId, assistantId,
        meetingUrl: body.meetingUrl, title: body.title, joinAt: body.joinAt, lengthLimitMinutes: body.lengthLimitMinutes,
        source: body.source === 'chat' ? 'chat' : 'link',
    });
    return r.ok ? json(200, { bot: r.bot, alreadySent: r.alreadySent }) : json(r.status, { error: r.error, code: r.code });
});
