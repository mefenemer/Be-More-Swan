// tests/meta-messaging.test.ts
// Facebook Page + Instagram messages, Phase 1 (docs/meta-messages-plan.md):
// src/utils/meta-messaging.ts, netlify/functions/meta-webhook.ts, the connect path in meta-oauth.ts
// and the disconnect path in integrations.ts.
//
// What has to hold:
//   · the webhook trusts nothing before the X-Hub-Signature-256 check over the RAW body
//   · the GET handshake echoes the challenge only for the right verify token, and fails closed unset
//   · Meta's payload parses to the messages we keep: Messenger + Instagram, echoes (the Page's own
//     replies) as 'out', postbacks as 'in', unsends flagged; read/delivery/foreign events dropped
//   · the reply window is the person's last message + 24h
//   · the three messaging permissions are asked for only while META_MESSAGING_ENABLED=true
//   · Page subscribe / unsubscribe never throw and report Meta's refusal
//   · nothing in Phase 1 sends a message, and the webhook never calls a model
//   · disconnect unsubscribes BEFORE the token is revoked / deleted, and only when no other row uses the Page
// No network, no database.
//
// Run:  npx tsx tests/meta-messaging.test.ts

import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    MESSAGING_SCOPES, REPLY_WINDOW_MS, SUBSCRIBED_FIELDS, messagingEnabled, parseMessagingWebhook,
    subscribePageToMessages, unsubscribePageFromMessages, verifyMetaSignature, windowClosesAt, withMessagingScopes,
} from '../src/utils/meta-messaging';

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (err) { failed++; console.error(`✗ ${name}\n  ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sign = (body: string, secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const PAGE = '111222333';
const IG = '178414000';
const PERSON = '9988776655';

async function main() {
    // ── Signature ────────────────────────────────────────────────────────────────────────────
    await check('a correct signature passes, for a string and for the same bytes as a Buffer', () => {
        const body = '{"object":"page","entry":[]}';
        assert.equal(verifyMetaSignature(body, sign(body, 's3cret'), 's3cret'), true);
        assert.equal(verifyMetaSignature(Buffer.from(body), sign(body, 's3cret'), 's3cret'), true);
    });
    await check('wrong secret, tampered body, missing header, missing secret, junk header all fail', () => {
        const body = '{"a":1}';
        assert.equal(verifyMetaSignature(body, sign(body, 'other'), 's3cret'), false);
        assert.equal(verifyMetaSignature('{"a":2}', sign(body, 's3cret'), 's3cret'), false);
        assert.equal(verifyMetaSignature(body, undefined, 's3cret'), false);
        assert.equal(verifyMetaSignature(body, sign(body, 's3cret'), undefined), false);
        assert.equal(verifyMetaSignature(body, 'sha1=abc', 's3cret'), false);
        assert.equal(verifyMetaSignature(body, 'sha256=zz', 's3cret'), false);
    });

    // ── Parsing ──────────────────────────────────────────────────────────────────────────────
    await check('a Messenger message from a person → one inbound facebook message', () => {
        const out = parseMessagingWebhook({ object: 'page', entry: [{ id: PAGE, time: 1, messaging: [
            { sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 1763500000000, message: { mid: 'm_1', text: 'Are you open Sunday?' } },
        ] }] });
        assert.equal(out.length, 1);
        assert.deepEqual(
            { ...out[0], sentAt: out[0].sentAt.getTime() },
            { platform: 'facebook', accountId: PAGE, participantId: PERSON, direction: 'in', mid: 'm_1', text: 'Are you open Sunday?', attachmentType: null, sentAt: 1763500000000, deleted: false },
        );
    });
    await check("an echo (the Page's own reply) → outbound, filed under the person it went to", () => {
        const [m] = parseMessagingWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [
            { sender: { id: PAGE }, recipient: { id: PERSON }, timestamp: 2, message: { mid: 'm_2', text: 'Yes, 10–4', is_echo: true } },
        ] }] });
        assert.equal(m.direction, 'out');
        assert.equal(m.participantId, PERSON);
    });
    await check('an Instagram DM with only a picture → instagram, inbound, attachment type kept, no text', () => {
        const [m] = parseMessagingWebhook({ object: 'instagram', entry: [{ id: IG, messaging: [
            { sender: { id: PERSON }, recipient: { id: IG }, timestamp: 3, message: { mid: 'ig_1', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }] } },
        ] }] });
        assert.equal(m.platform, 'instagram');
        assert.equal(m.text, null);
        assert.equal(m.attachmentType, 'image');
        assert.ok(!JSON.stringify(m).includes('cdn.example'), "Meta's attachment URL must not be kept");
    });
    await check('an Instagram unsend is flagged deleted', () => {
        const [m] = parseMessagingWebhook({ object: 'instagram', entry: [{ id: IG, messaging: [
            { sender: { id: PERSON }, recipient: { id: IG }, timestamp: 4, message: { mid: 'ig_1', is_deleted: true } },
        ] }] });
        assert.equal(m.deleted, true);
    });
    await check('a postback (button tapped) → inbound with its title; a stable mid when Meta gives none', () => {
        const body = { object: 'page', entry: [{ id: PAGE, messaging: [
            { sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 5, postback: { title: 'Book a table', payload: 'BOOK' } },
        ] }] };
        const [a] = parseMessagingWebhook(body);
        const [b] = parseMessagingWebhook(body);
        assert.equal(a.direction, 'in');
        assert.equal(a.text, 'Book a table');
        assert.equal(a.mid, b.mid, 'a retried postback must dedupe');
    });
    await check('read / delivery / reaction events, events missing ids or a mid, and other objects are dropped', () => {
        assert.deepEqual(parseMessagingWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [
            { sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 6, read: { watermark: 1 } },
            { sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 6, delivery: { mids: ['x'] } },
            { sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 6, reaction: { mid: 'x', reaction: 'love' } },
            { sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 6, message: { text: 'no mid' } },
            { recipient: { id: PAGE }, timestamp: 6, message: { mid: 'm_x', text: 'no sender' } },
        ] }] }), []);
        assert.deepEqual(parseMessagingWebhook({ object: 'user', entry: [] }), []);
        assert.deepEqual(parseMessagingWebhook(null), []);
        assert.deepEqual(parseMessagingWebhook('junk'), []);
    });
    await check('a message that is not to (or, for an echo, from) the entry account is not filed', () => {
        assert.deepEqual(parseMessagingWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [
            { sender: { id: PERSON }, recipient: { id: 'someone-else' }, timestamp: 7, message: { mid: 'm_7', text: 'hi' } },
            { sender: { id: 'someone-else' }, recipient: { id: PERSON }, timestamp: 7, message: { mid: 'm_8', text: 'hi', is_echo: true } },
        ] }] }), []);
    });

    // ── Window ───────────────────────────────────────────────────────────────────────────────
    await check('the reply window closes 24 hours after the last message', () => {
        assert.equal(REPLY_WINDOW_MS, 86_400_000);
        assert.equal(windowClosesAt(new Date('2026-11-19T18:00:00Z')).toISOString(), '2026-11-20T18:00:00.000Z');
    });

    // ── Scopes ───────────────────────────────────────────────────────────────────────────────
    await check('messaging permissions are asked for only when META_MESSAGING_ENABLED is exactly "true"', () => {
        assert.equal(messagingEnabled({}), false);
        assert.equal(messagingEnabled({ META_MESSAGING_ENABLED: '1' }), false);
        assert.equal(messagingEnabled({ META_MESSAGING_ENABLED: 'true' }), true);
        assert.equal(withMessagingScopes('a,b', false), 'a,b');
        assert.equal(withMessagingScopes('a,b', true), `a,b,${MESSAGING_SCOPES.join(',')}`);
        assert.equal(withMessagingScopes('a,pages_messaging', true), 'a,pages_messaging,instagram_manage_messages,pages_manage_metadata');
    });
    await check('meta-oauth builds its login scopes through the flag, and subscribes only when it is on', () => {
        const src = read('netlify/functions/meta-oauth.ts');
        assert.ok(src.includes('const SCOPES      = withMessagingScopes(BASE_SCOPES, messagingEnabled());'));
        assert.ok(!/BASE_SCOPES = '[^']*(pages_messaging|instagram_manage_messages|pages_manage_metadata)/.test(src),
            'messaging permissions must not be in the always-asked list');
        assert.ok(src.includes('if (messagingEnabled() && fbPageId) {'));
        assert.ok(!src.includes('scopes: SCOPES'), 'the stored scopes must not claim messaging permissions a person may have unticked');
        assert.ok(src.includes('scopes: BASE_SCOPES'));
    });
    await check('filing a message is one transaction', () => {
        assert.ok(read('src/utils/meta-messaging.ts').includes('return db.transaction(async (tx) => storeInTx(tx as unknown as Db, m));'));
    });

    // ── Subscribe / unsubscribe ──────────────────────────────────────────────────────────────
    type Call = { url: string; init?: RequestInit };
    const fakeFetch = (responses: Array<{ status: number; body: unknown }>, calls: Call[]) =>
        (async (url: string, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            const r = responses.shift() ?? { status: 500, body: {} };
            return new Response(JSON.stringify(r.body), { status: r.status });
        }) as unknown as typeof fetch;

    await check('subscribe: derives the Page token, POSTs the three fields with it, reports success', async () => {
        const calls: Call[] = [];
        const res = await subscribePageToMessages('USER_TOKEN', PAGE, fakeFetch([
            { status: 200, body: { access_token: 'PAGE_TOKEN', id: PAGE } },
            { status: 200, body: { success: true } },
        ], calls));
        assert.deepEqual(res, { ok: true });
        assert.ok(calls[0].url.includes(`/${PAGE}?fields=access_token`) && calls[0].url.includes('USER_TOKEN'));
        assert.ok(calls[1].url.endsWith(`/${PAGE}/subscribed_apps`));
        assert.equal(calls[1].init?.method, 'POST');
        const form = new URLSearchParams(String(calls[1].init?.body));
        assert.equal(form.get('subscribed_fields'), SUBSCRIBED_FIELDS);
        assert.equal(form.get('access_token'), 'PAGE_TOKEN', 'subscribed_apps needs the PAGE token, not the user token');
    });
    await check("subscribe: Meta's refusal and a missing Page token come back as errors, not throws", async () => {
        const refused = await subscribePageToMessages('U', PAGE, fakeFetch([
            { status: 200, body: { access_token: 'P' } },
            { status: 403, body: { error: { message: '(#200) Requires pages_manage_metadata' } } },
        ], []));
        assert.deepEqual(refused, { ok: false, error: '(#200) Requires pages_manage_metadata' });
        const noToken = await subscribePageToMessages('U', PAGE, fakeFetch([{ status: 400, body: {} }], []));
        assert.deepEqual(noToken, { ok: false, error: 'no_page_token' });
        const thrown = await subscribePageToMessages('U', PAGE, (async () => { throw new Error('network down'); }) as unknown as typeof fetch);
        assert.deepEqual(thrown, { ok: false, error: 'network down' });
    });
    await check('unsubscribe: DELETEs subscribed_apps with the Page token', async () => {
        const calls: Call[] = [];
        const res = await unsubscribePageFromMessages('U', PAGE, fakeFetch([
            { status: 200, body: { access_token: 'PAGE_TOKEN' } },
            { status: 200, body: { success: true } },
        ], calls));
        assert.deepEqual(res, { ok: true });
        assert.equal(calls[1].init?.method, 'DELETE');
        assert.ok(calls[1].url.includes(`/${PAGE}/subscribed_apps?access_token=PAGE_TOKEN`));
    });

    // ── Webhook handler ──────────────────────────────────────────────────────────────────────
    const saved = { token: process.env.META_WEBHOOK_VERIFY_TOKEN, secret: process.env.META_APP_SECRET };
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me';
    process.env.META_APP_SECRET = 'app-secret';
    const { default: handler } = await import('../netlify/functions/meta-webhook');
    const call = (url: string, init?: RequestInit) => (handler as unknown as (r: Request, c: object) => Promise<Response>)(
        new Request(url, { ...init, headers: { 'x-forwarded-host': 'staging--bemoreswan.netlify.app', 'x-forwarded-proto': 'https', ...(init?.headers ?? {}) } }), {});
    const base = 'https://staging--bemoreswan.netlify.app/.netlify/functions/meta-webhook';

    await check('GET handshake echoes the challenge for the right token and refuses a wrong one', async () => {
        const good = await call(`${base}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
        assert.equal(good.status, 200);
        assert.equal(await good.text(), '12345');
        const bad = await call(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`);
        assert.equal(bad.status, 403);
    });
    await check('GET handshake fails closed when META_WEBHOOK_VERIFY_TOKEN is not set', async () => {
        delete process.env.META_WEBHOOK_VERIFY_TOKEN;
        const res = await call(`${base}?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`);
        assert.equal(res.status, 403);
        process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me';
    });
    await check('POST with a bad or missing signature is refused before anything is read', async () => {
        const body = JSON.stringify({ object: 'page', entry: [] });
        assert.equal((await call(base, { method: 'POST', body })).status, 401);
        assert.equal((await call(base, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body, 'wrong') } })).status, 401);
    });
    await check('POST correctly signed with nothing to store → 200 without touching the database', async () => {
        const body = JSON.stringify({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PERSON }, recipient: { id: PAGE }, timestamp: 1, read: { watermark: 1 } }] }] });
        const res = await call(base, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body, 'app-secret') } });
        assert.equal(res.status, 200);
    });
    if (saved.token === undefined) delete process.env.META_WEBHOOK_VERIFY_TOKEN; else process.env.META_WEBHOOK_VERIFY_TOKEN = saved.token;
    if (saved.secret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = saved.secret;

    // ── Source rules ─────────────────────────────────────────────────────────────────────────
    await check('Phase 1 sends nothing: no /messages send call and no model in the webhook or the helpers', () => {
        for (const f of ['netlify/functions/meta-webhook.ts', 'src/utils/meta-messaging.ts']) {
            const src = read(f);
            assert.ok(!/\/messages['`?]/.test(src), `${f} must not call the Send API`);
            assert.ok(!src.includes('@anthropic-ai/sdk'), `${f} must not call a model`);
        }
    });
    await check('the webhook checks the signature before parsing the body', () => {
        const src = read('netlify/functions/meta-webhook.ts');
        const sigAt = src.indexOf('verifyMetaSignature(raw');
        const parseAt = src.indexOf('JSON.parse(');
        assert.ok(sigAt !== -1 && parseAt !== -1 && sigAt < parseAt);
    });
    await check('disconnect unsubscribes the Page before revoking / deleting the token, and only if no other row uses it', () => {
        const src = read('netlify/functions/integrations.ts');
        const unsubAt = src.indexOf('unsubscribePageFromMessages(s.token, fbPageId)');
        const inUseAt = src.indexOf('pageStillInUse(db, fbPageId, connIdInt)');
        const revokeAt = src.indexOf('/me/permissions?access_token=');
        const deleteAt = src.indexOf('if (plan.deleteVaultSecret) await deleteSecret(');
        assert.ok(unsubAt !== -1 && inUseAt !== -1 && revokeAt !== -1 && deleteAt !== -1);
        assert.ok(inUseAt < unsubAt && unsubAt < revokeAt && unsubAt < deleteAt);
        const subAt = src.indexOf('?.messaging?.subscribed === true');
        assert.ok(subAt !== -1 && subAt < inUseAt, 'only a row that subscribed the Page unsubscribes it');
    });

    if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
    console.log('\nAll meta-messaging checks passed');
    process.exit(0);
}

main();
