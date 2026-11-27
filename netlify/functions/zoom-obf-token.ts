// netlify/functions/zoom-obf-token.ts — Recall asks here for the Zoom OBF token when a Note Taker bot joins a Zoom call
// (src/utils/zoom-bot.ts; docs/note-taker-bot-plan.md step 4).
//
//   GET ?bot=<meeting_bots.id>&sig=<HMAC>  → 200 text/plain <token> | 404 text/plain
//
// The URL is signed per bot (obfTokenUrl, key = ZOOM_CLIENT_SECRET with its own label), so only the URL we gave Recall
// works, and only for that bot. A token is minted only for a Zoom bot that is still on its way into or in the call, from
// the workspace's own Zoom connection, for that bot's meeting number. Zoom then lets the bot in only while the person who
// connected Zoom is in the call. Logs ids and statuses only, never a token.

import { withLambda } from '@netlify/aws-lambda-compat';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { meetingBots } from '../../db/schema';
import { getFreshAccessToken } from '../../src/utils/workspace-integrations';
import { isFeatureEnabled } from '../../src/utils/feature-flags';
import { MEETING_BOT_ZOOM_FLAG } from '../../src/utils/meeting-bot';
import { fetchObfToken, obfKey, obfTokenAllowed, verifyObfQuery, zoomMeetingNumber, ZoomError } from '../../src/utils/zoom-bot';

const text = (statusCode: number, body: string) => ({ statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return text(405, 'Method not allowed');
    const key = obfKey();
    if (!key) return text(503, 'Not configured');
    const botId = verifyObfQuery(key, event.queryStringParameters?.bot, event.queryStringParameters?.sig);
    if (!botId) return text(404, 'Not found');

    const db = getDb();
    const [bot] = await db.select({
        id: meetingBots.id, organisationId: meetingBots.organisationId, platform: meetingBots.platform,
        meetingUrl: meetingBots.meetingUrl, status: meetingBots.status, joinAt: meetingBots.joinAt,
    }).from(meetingBots).where(eq(meetingBots.id, botId)).limit(1);
    if (!bot || !obfTokenAllowed(bot, new Date())) return text(404, 'Not found');
    if (!(await isFeatureEnabled(bot.organisationId, MEETING_BOT_ZOOM_FLAG))) return text(404, 'Not found');
    const meetingNumber = zoomMeetingNumber(bot.meetingUrl);
    if (!meetingNumber) return text(404, 'Not found');

    try {
        const { accessToken } = await getFreshAccessToken(db, bot.organisationId, 'zoom');
        const token = await fetchObfToken(accessToken, meetingNumber);
        console.log('[zoom-obf-token] issued', { botId: bot.id, status: bot.status });
        return text(200, token);
    } catch (err) {
        // Not connected, a refused refresh, or Zoom said no: Recall's join then fails and the strip says why.
        console.error('[zoom-obf-token] not issued', { botId: bot.id, zoomStatus: err instanceof ZoomError ? err.status : null, err: err instanceof Error ? err.message : 'unknown' });
        return text(404, 'Not found');
    }
});
