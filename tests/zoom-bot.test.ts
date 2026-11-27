// The Note Taker's bot on Zoom (src/utils/zoom-bot.ts; docs/note-taker-bot-plan.md step 4): connect, the signed OBF
// token URL Recall calls, deauthorization, and the dialog's Zoom line. Run: npx tsx tests/zoom-bot.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    fetchObfToken, fetchZoomUser, obfSignature, obfTokenAllowed, obfTokenUrl, verifyObfQuery, verifyZoomWebhook,
    zoomMeetingNumber, zoomScopesGranted, zoomUrlValidation,
} from '../src/utils/zoom-bot';
import { recallBotRequest } from '../src/utils/meeting-bot';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};
const read = (p: string) => readFileSync(p, 'utf8');
const KEY = 'test-client-secret';

(async () => {

await test('scopes: both user:read:token and user:read:user are needed, space- or comma-separated', () => {
    assert.equal(zoomScopesGranted('user:read:token user:read:user'), true);
    assert.equal(zoomScopesGranted('user:read:user,user:read:token,user:read:token:admin'), true);
    assert.equal(zoomScopesGranted('user:read:user'), false);
    assert.equal(zoomScopesGranted(undefined), false);
});

await test('meeting number: from /j/, /w/ and /wc/join/ on any zoom.us host; none for personal or foreign links', () => {
    assert.equal(zoomMeetingNumber('https://us02web.zoom.us/j/81234567890?pwd=abc'), '81234567890');
    assert.equal(zoomMeetingNumber('https://zoom.us/w/123456789'), '123456789');
    assert.equal(zoomMeetingNumber('https://zoom.us/wc/join/123456789'), '123456789');
    assert.equal(zoomMeetingNumber('https://zoom.us/my/kate'), null);
    assert.equal(zoomMeetingNumber('https://evilzoom.us/j/123456789'), null);
    assert.equal(zoomMeetingNumber('https://zoom.us.evil.com/j/123456789'), null);
    assert.equal(zoomMeetingNumber('not a url'), null);
});

await test('token URL: signed per bot; only the exact bot id and signature verify', () => {
    const url = new URL(obfTokenUrl('https://staging--bemoreswan.netlify.app/', 42, KEY));
    assert.equal(url.pathname, '/.netlify/functions/zoom-obf-token');
    const bot = url.searchParams.get('bot'), sig = url.searchParams.get('sig');
    assert.equal(verifyObfQuery(KEY, bot, sig), 42);
    assert.equal(verifyObfQuery(KEY, '43', sig), null, 'another bot id with this signature');
    assert.equal(verifyObfQuery('other-key', bot, sig), null, 'another key');
    assert.equal(verifyObfQuery(KEY, bot, sig!.slice(0, 63) + (sig!.endsWith('0') ? '1' : '0')), null, 'one character changed');
    assert.equal(verifyObfQuery('', bot, sig), null, 'no key = nothing verifies');
    assert.equal(verifyObfQuery(KEY, '42', undefined), null);
    assert.equal(verifyObfQuery(KEY, '42; drop', obfSignature(KEY, 42)), null);
    // The label keeps this HMAC apart from any other use of the client secret.
    assert.notEqual(obfSignature(KEY, 42), createHmac('sha256', KEY).update('42').digest('hex'));
});

await test('token allowed: Zoom bots still on their way in, 15 min before to 12 h after the join time', () => {
    const joinAt = new Date('2026-11-27T10:00:00Z');
    const at = (iso: string) => new Date(iso);
    const bot = (o: Partial<{ platform: string; status: string }>) => ({ platform: 'zoom', status: 'waiting_room', joinAt, ...o });
    assert.equal(obfTokenAllowed(bot({}), at('2026-11-27T10:01:00Z')), true);
    assert.equal(obfTokenAllowed(bot({ status: 'scheduled' }), at('2026-11-27T09:50:00Z')), true);
    assert.equal(obfTokenAllowed(bot({ status: 'scheduled' }), at('2026-11-27T09:40:00Z')), false, 'too early');
    assert.equal(obfTokenAllowed(bot({}), at('2026-11-27T22:30:00Z')), false, 'too late');
    for (const status of ['ended', 'done', 'failed', 'not_admitted', 'removed', 'cancelled']) {
        assert.equal(obfTokenAllowed(bot({ status }), at('2026-11-27T10:01:00Z')), false, status);
    }
    assert.equal(obfTokenAllowed(bot({ platform: 'google_meet' }), at('2026-11-27T10:01:00Z')), false);
});

await test('fetchObfToken: GET users/me/token?type=onbehalf&meeting_id=N with the bearer; the token, or an error without it', async () => {
    let seen = { url: '', auth: '' };
    const ok = (async (url: string, init: { headers: Record<string, string> }) => {
        seen = { url, auth: init.headers.Authorization };
        return new Response(JSON.stringify({ token: 'obf-123' }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await fetchObfToken('acc', '81234567890', ok), 'obf-123');
    assert.equal(seen.url, 'https://api.zoom.us/v2/users/me/token?type=onbehalf&meeting_id=81234567890');
    assert.equal(seen.auth, 'Bearer acc');
    const empty = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(fetchObfToken('acc', '1', empty), /no token/);
    const refused = (async () => new Response(JSON.stringify({ code: 124, message: 'Invalid access token secret-ish' }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(fetchObfToken('acc', '1', refused), (e: Error) => e.message === 'Zoom 401 code 124');
});

await test('fetchZoomUser: id + email, and no id is an error', async () => {
    const f = (async () => new Response(JSON.stringify({ id: 'zu_1', email: 'owner@example.com' }), { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchZoomUser('acc', f), { id: 'zu_1', email: 'owner@example.com' });
    const none = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(fetchZoomUser('acc', none), /no user id/);
});

await test('Zoom webhook: v0 HMAC over v0:ts:body, five-minute window; URL validation answer', () => {
    const secret = 'whsecret';
    const now = new Date('2026-11-27T10:00:00Z');
    const ts = String(Math.floor(now.getTime() / 1000));
    const body = '{"event":"app_deauthorized","payload":{"user_id":"zu_1"}}';
    const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
    const h = { 'x-zm-request-timestamp': ts, 'x-zm-signature': sig };
    assert.equal(verifyZoomWebhook(secret, h, body, now), true);
    assert.equal(verifyZoomWebhook(secret, h, body + ' ', now), false, 'body changed');
    assert.equal(verifyZoomWebhook('other', h, body, now), false, 'other secret');
    assert.equal(verifyZoomWebhook(secret, h, body, new Date(now.getTime() + 6 * 60 * 1000)), false, 'replayed later');
    assert.equal(verifyZoomWebhook('', h, body, now), false, 'no secret = refused');
    assert.equal(verifyZoomWebhook(secret, { 'x-zm-request-timestamp': ts }, body, now), false);
    assert.deepEqual(zoomUrlValidation(secret, 'abc'), { plainToken: 'abc', encryptedToken: createHmac('sha256', secret).update('abc').digest('hex') });
});

await test('Recall request: zoom.obf_token_url only when a Zoom token URL is given', () => {
    const base = { meetingUrl: 'https://zoom.us/j/123456789', businessName: 'Acme', joinAt: new Date(), scheduled: false, lengthLimitMinutes: 60, botRowId: 7, organisationId: 58 };
    assert.equal('zoom' in recallBotRequest(base), false);
    const withZoom = recallBotRequest({ ...base, zoomObfTokenUrl: 'https://x/.netlify/functions/zoom-obf-token?bot=7&sig=s' });
    assert.deepEqual(withZoom.zoom, { obf_token_url: 'https://x/.netlify/functions/zoom-obf-token?bot=7&sig=s' });
});

await test('send: Zoom needs the flag, a meeting number and a connected Zoom, all checked BEFORE the bot row is saved', () => {
    const src = read('src/utils/meeting-bot-db.ts');
    const body = src.slice(src.indexOf('export async function sendMeetingBot'));
    const flag = body.indexOf('MEETING_BOT_ZOOM_FLAG');
    const number = body.indexOf("fail(400, 'zoom_link'");
    const connect = body.indexOf("fail(409, 'zoom_connect'");
    const insert = body.indexOf('db.insert(meetingBots)');
    assert.ok(flag > 0 && number > flag && connect > number && insert > connect, 'order: flag → number → connected → insert');
    assert.match(body, /zoomObfTokenUrl: obfTokenUrl\(zoomBase, row\.id, obfKey\(\)\)/);
    assert.match(read('netlify/functions/meeting-bots.ts'), /baseUrl: resolveBaseUrl\(event\.headers\)/);
});

await test('connect: Zoom OAuth only with meeting_bot_zoom on, and a grant without user:read:token is refused', () => {
    const src = read('netlify/functions/oauth-integrations.ts');
    assert.match(src, /provider === 'zoom' && !\(await isFeatureEnabled\(organisationId, MEETING_BOT_ZOOM_FLAG\)\)/);
    assert.match(src, /if \(!zoomScopesGranted\(tokenData\.scope\)\) return redirect\('\/integrations\.html\?oauth_error=scope_missing&provider=zoom'\)/);
    assert.match(src, /tenantId: zoomUser\.id/);
    assert.match(src, /inbox: \{ tab: 'review-queue' \}/);
    // Zoom rotates the refresh token: the refresh branch must hand the new one back to be saved.
    const wi = read('src/utils/workspace-integrations.ts');
    const zoomRefresh = wi.slice(wi.indexOf("if (provider === 'zoom')"), wi.indexOf("if (provider === 'google_meet')"));
    assert.match(zoomRefresh, /refreshToken: data\.refresh_token \?\? null/);
});

await test('token endpoint: signed URL, allowed bot, flag on, a meeting number; never logs the token', () => {
    const src = read('netlify/functions/zoom-obf-token.ts');
    for (const needle of ['verifyObfQuery(key', 'obfTokenAllowed(bot', 'MEETING_BOT_ZOOM_FLAG', 'zoomMeetingNumber(bot.meetingUrl)', "'text/plain; charset=utf-8'"]) {
        assert.ok(src.includes(needle), needle);
    }
    assert.doesNotMatch(src, /console\.(log|error)\([^)]*token[,)]/, 'no token in a log line');
});

await test('deauthorize: signed, answers the URL check, deletes the connection of that Zoom user only', () => {
    const src = read('netlify/functions/zoom-deauthorize.ts');
    assert.ok(src.indexOf('verifyZoomWebhook(') < src.indexOf('JSON.parse(raw)'), 'signature checked before anything is read');
    assert.match(src, /endpoint\.url_validation/);
    assert.match(src, /eq\(workspaceIntegrations\.provider, 'zoom'\), eq\(workspaceIntegrations\.tenantId, zoomUserId\)/);
    assert.match(src, /if \(!secretToken\)/);
});

await test('dialog: no Zoom line while Zoom is off; Connect Zoom back to the Inbox; connected names the account (escaped)', () => {
    const sandbox: Record<string, unknown> = { window: {} as Record<string, unknown>, document: {}, console };
    vm.runInNewContext(read('src/components/meeting-bots.js'), sandbox);
    const mb = (sandbox.window as { MeetingBots: { _zoomHtml: (z: unknown, id: number) => string; _rowHtml: (b: unknown, now: number) => string } }).MeetingBots;
    assert.equal(mb._zoomHtml(null, 21), '');
    const off = mb._zoomHtml({ connected: false, accountName: null }, 21);
    assert.match(off, /href="\/api\/oauth\/zoom\/connect\?assistantId=21&returnTo=inbox"/);
    assert.match(off, /that person must be in the call/);
    const on = mb._zoomHtml({ connected: true, accountName: '<b>kate@example.com</b>', canDisconnect: true }, 21);
    assert.match(on, /&lt;b&gt;kate@example\.com&lt;\/b&gt; must be in the call/);
    assert.match(on, /data-mb-zoom-disconnect/);
    // A member can't disconnect (owner/admin only on the server): no button, they're told who can.
    const member = mb._zoomHtml({ connected: true, accountName: 'kate@example.com', canDisconnect: false }, 21);
    assert.doesNotMatch(member, /data-mb-zoom-disconnect/);
    assert.match(member, /An owner or admin of your workspace can disconnect it/);
    const row = mb._rowHtml({ id: 1, status: 'failed', statusReason: 'zoom_obf_user_not_in_meeting', platformLabel: 'Zoom', title: 'Call', joinAt: '2026-11-27T10:00:00Z', statusWords: 'Couldn’t join' }, Date.parse('2026-11-27T10:05:00Z'));
    assert.match(row, /The person who connected Zoom wasn’t in the call/);
});

await test('flag SQL: meeting_bot_zoom seeded OFF, idempotent', () => {
    const sql = read('db/z-meeting-bot-zoom-flag.sql');
    assert.match(sql, /VALUES \('meeting_bot_zoom', FALSE, 0, NULL,/);
    assert.match(sql, /ON CONFLICT \(key\) DO NOTHING/);
});

console.log(`zoom-bot: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
