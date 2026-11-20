// tests/social-messages.test.ts
// Facebook Page + Instagram messages, Phase 2 (docs/meta-messages-plan.md): the Messages tab, Send,
// the chat card, the notifications and the 15-minute tick.
//
// What has to hold:
//   · a reply is cut to the platform's limit (Messenger 2,000, Instagram 1,000)
//   · Meta's refusals map to plain reasons — above all the 24-hour rule (#10 / 2018278, 2534022)
//   · the Send API call is POST /{page-id}/messages with the PAGE token, recipient = the person,
//     messaging_type RESPONSE, and nothing else
//   · Send checks the window with the database clock under a per-conversation lock, BEFORE calling Meta
//   · nothing sends except social-messages.ts sendReply, reached only from the tab's endpoint — never
//     from the tick, the webhook, the orchestrator or a model turn (owner decision D1)
//   · the chat card is rebuilt from the row and blocked once the window has closed
//   · the webhook notifies only when a conversation starts waiting; both notifications are wired
//     everywhere a notification type has to be (catalog, category, prefs, SQL mirror, CTA)
//   · the tab hides itself where messages are switched off or not set up
//   · Phase 1 carry-overs: an out-of-range timestamp never makes an Invalid Date; a postback with
//     no mid and no timestamp still gets a stable id
// No network, no database.
//
// Run:  npx tsx tests/social-messages.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    MAX_REPLY_CHARS, REFUSAL_COPY, callSendApi, classifySendError, conversationView, timeLeftLabel, tidyReply, windowOpen,
} from '../src/utils/social-messages';
import { messageActionFromUiElement } from '../src/utils/chat-message-action';
import { parseMessagingWebhook, sentAtFrom } from '../src/utils/meta-messaging';

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (err) { failed++; console.error(`✗ ${name}\n  ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

async function main() {
    // ── Pure helpers ─────────────────────────────────────────────────────────────────────────
    await check('a reply is tidied and cut to the platform limit', () => {
        assert.equal(MAX_REPLY_CHARS.facebook, 2000);
        assert.equal(MAX_REPLY_CHARS.instagram, 1000);
        assert.equal(tidyReply('  hi\r\n\n\n\nthere  ', 'facebook'), 'hi\n\nthere');
        assert.equal(tidyReply('x'.repeat(1500), 'instagram').length, 1000);
        assert.equal(tidyReply('x'.repeat(2500), 'facebook').length, 2000);
    });
    await check('the window is open only before window_closes_at', () => {
        const now = Date.parse('2026-11-20T10:00:00Z');
        assert.equal(windowOpen('2026-11-20T10:00:01Z', now), true);
        assert.equal(windowOpen('2026-11-20T09:59:59Z', now), false);
        assert.equal(windowOpen(null, now), false);
        // A naive timestamp from the database is UTC.
        assert.equal(windowOpen('2026-11-20 10:30:00', now), true);
    });
    await check('time left reads as hours and minutes, or closed', () => {
        const now = Date.parse('2026-11-20T10:00:00Z');
        assert.equal(timeLeftLabel('2026-11-20T15:30:00Z', now), '5h 30m left');
        assert.equal(timeLeftLabel('2026-11-20T10:20:00Z', now), '20m left');
        assert.equal(timeLeftLabel('2026-11-20T09:00:00Z', now), 'closed');
    });
    await check("Meta's refusals map to plain reasons", () => {
        assert.equal(classifySendError(400, { error: { code: 10, error_subcode: 2018278, message: '(#10) This message is sent outside of allowed window.' } }), 'window_closed');
        assert.equal(classifySendError(400, { error: { code: 10, error_subcode: 2534022, message: 'x' } }), 'window_closed');
        assert.equal(classifySendError(401, { error: { code: 190, type: 'OAuthException', message: 'Error validating access token: Session has expired' } }), 'not_connected');
        assert.equal(classifySendError(403, { error: { code: 200, message: '(#200) Requires pages_messaging permission to manage the object' } }), 'scope_missing');
        assert.equal(classifySendError(400, { error: { code: 551, message: "This person isn't available right now." } }), 'person_unavailable');
        assert.equal(classifySendError(400, { error: { code: 3, message: 'To use this API, turn on Allow access to messages in Connected tools' } }), 'instagram_access_off');
        assert.equal(classifySendError(500, {}), 'meta_error');
        for (const k of Object.keys(REFUSAL_COPY)) assert.ok(REFUSAL_COPY[k as keyof typeof REFUSAL_COPY].length > 20);
    });
    await check('a conversation without a name reads "Someone on Instagram", and messages run oldest first', () => {
        const v = conversationView({
            id: 1, organisationId: 1, aiAssistantId: 2, connectionId: 3, platform: 'instagram', accountExternalId: 'a', participantId: 'p',
            participantName: null, lastInboundAt: new Date('2026-11-20T09:00:00Z'), lastOutboundAt: null, windowClosesAt: new Date('2026-11-21T09:00:00Z'),
            status: 'new', draftReply: null, remindedForWindow: null, decidedBy: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date(),
        }, [
            { id: 2, organisationId: 1, conversationId: 1, direction: 'out', mid: 'b', body: 'second', attachmentType: null, sentAt: new Date('2026-11-20T09:05:00Z'), sentBy: 7, createdAt: new Date() },
            { id: 1, organisationId: 1, conversationId: 1, direction: 'in', mid: 'a', body: 'first', attachmentType: null, sentAt: new Date('2026-11-20T09:00:00Z'), sentBy: null, createdAt: new Date() },
        ], Date.parse('2026-11-20T10:00:00Z'));
        assert.equal(v.personLabel, 'Someone on Instagram');
        assert.equal(v.maxReplyChars, 1000);
        assert.equal(v.windowOpen, true);
        assert.deepEqual(v.messages.map((m) => [m.body, m.sentHere]), [['first', false], ['second', true]]);
    });

    // ── The Send API call ────────────────────────────────────────────────────────────────────
    await check('callSendApi posts to /{page-id}/messages with the Page token, the person and RESPONSE', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fake = (async (url: string, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify({ recipient_id: 'psid', message_id: 'm_123' }), { status: 200 });
        }) as unknown as typeof fetch;
        const r = await callSendApi({ pageId: '111', pageToken: 'PAGE_TOKEN' }, 'psid', 'Hello!', fake);
        assert.deepEqual(r, { ok: true, messageId: 'm_123' });
        assert.ok(calls[0].url.includes('/111/messages?access_token=PAGE_TOKEN'));
        assert.equal(calls[0].init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { recipient: { id: 'psid' }, messaging_type: 'RESPONSE', message: { text: 'Hello!' } });
    });
    await check('callSendApi reports the reason when Meta refuses, and never throws', async () => {
        const refuse = (async () => new Response(JSON.stringify({ error: { code: 10, error_subcode: 2018278, message: 'outside of allowed window' } }), { status: 400 })) as unknown as typeof fetch;
        const r = await callSendApi({ pageId: '1', pageToken: 't' }, 'p', 'x', refuse);
        assert.equal(r.ok, false);
        assert.equal((r as { reason: string }).reason, 'window_closed');
        const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
        const r2 = await callSendApi({ pageId: '1', pageToken: 't' }, 'p', 'x', boom);
        assert.equal((r2 as { reason: string }).reason, 'meta_error');
    });

    // ── Send rules (source) ──────────────────────────────────────────────────────────────────
    const lib = read('src/utils/social-messages.ts');
    await check('Send checks the window with the database clock, under a lock, before calling Meta', () => {
        const fn = lib.slice(lib.indexOf('export async function sendReply'));
        const lockAt = fn.indexOf('pg_try_advisory_xact_lock');
        const windowAt = fn.indexOf('${socialConversations.windowClosesAt} > now()');
        const refuseAt = fn.indexOf("code: 'window_closed'");
        const callAt = fn.indexOf('await callSendApi(');
        assert.ok(lockAt !== -1 && windowAt !== -1 && refuseAt !== -1 && callAt !== -1);
        assert.ok(lockAt < windowAt && windowAt < refuseAt && refuseAt < callAt);
        assert.ok(fn.indexOf('if (!messagingEnabled())') < callAt, 'refuses when messages are switched off');
    });
    await check('only sendReply calls the Send API, and only the tab endpoint calls sendReply', () => {
        assert.equal((lib.match(/await callSendApi\(/g) || []).length, 1);
        const callers = ['netlify/functions/social-messages.ts', 'netlify/functions/meta-webhook.ts', 'netlify/functions/social-messages-tick.ts',
            'netlify/functions/chat-orchestrator.ts', 'src/utils/chat-message-action.ts'];
        for (const f of callers) {
            const src = read(f);
            const n = (src.match(/sendReply\(/g) || []).length;
            if (f === 'netlify/functions/social-messages.ts') assert.equal(n, 1, 'the tab endpoint sends once, on action "send"');
            else assert.equal(n, 0, `${f} must never send`);
        }
        assert.ok(!lib.slice(lib.indexOf('export async function runMessagesTick')).includes('callSendApi'), 'the tick never sends');
    });
    await check('the tab endpoint refuses writes while impersonating', () => {
        assert.ok(read('netlify/functions/social-messages.ts').includes("requireTenant(event, db, { mutates: action !== 'list' })"));
    });

    // ── Chat card ────────────────────────────────────────────────────────────────────────────
    await check('the chat proposal is shape-checked; instruction only on draft', () => {
        assert.deepEqual(messageActionFromUiElement({ type: 'message_action_proposal', action: 'draft', conversationId: '#12', instruction: ' shorter ' }), { action: 'draft', conversationId: 12, instruction: 'shorter' });
        assert.deepEqual(messageActionFromUiElement({ type: 'message_action_proposal', action: 'send', conversationId: 3, instruction: 'x' }), { action: 'send', conversationId: 3, instruction: null });
        assert.equal(messageActionFromUiElement({ type: 'message_action_proposal', action: 'post', conversationId: 3 }), null);
        assert.equal(messageActionFromUiElement({ type: 'comment_action_proposal', action: 'draft', conversationId: 3 }), null);
        assert.equal(messageActionFromUiElement({ type: 'message_action_proposal', action: 'send', conversationId: 0 }), null);
    });
    await check('the card is rebuilt from the row and blocked once the window has closed', () => {
        const src = read('src/utils/chat-message-action.ts');
        assert.ok(src.includes("if (req.action !== 'dismiss' && !c.windowOpen) blocked ="));
        assert.ok(src.includes("else if (req.action === 'send' && !c.draftReply) blocked ="));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('uiElement = await resolveMessageActionProposal(db, orgId, session.aiAssistantId, messageReq);'));
        assert.ok(orch.includes('usesSocialMessages: true,'));
        assert.ok(orch.includes("rc.messagesBlock ?? '',"));
    });
    await check('the chat card and the tab call the same endpoint, and both reload the tab', () => {
        const session = read('src/components/chat-session.js');
        assert.ok(session.includes("container.addEventListener('message:action', onMessageAction);"));
        assert.ok(session.includes("container.removeEventListener('message:action', onMessageAction);"));
        assert.ok(session.includes("fetch('/.netlify/functions/social-messages'"));
        assert.ok(session.includes("new CustomEvent('messages:changed'"));
        assert.ok(read('src/components/assistant-messages.js').includes("document.addEventListener('messages:changed'"));
        assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('message_action_proposal', renderMessageActionProposalCard);"));
    });
    await check('the chat is told never to send on its own or after the window', () => {
        assert.ok(lib.includes('You never message anyone on your own, never message someone who hasn\'t messaged the business first, and never send after the reply window closes.'));
        assert.ok(lib.includes('Never say a message HAS been sent'));
    });

    // ── Notifications ────────────────────────────────────────────────────────────────────────
    await check('the webhook notifies only when a conversation starts waiting', () => {
        const hook = read('netlify/functions/meta-webhook.ts');
        assert.ok(hook.includes('if (res.stored && res.opened) await notifyConversationOpened(db, res);'));
        const mm = read('src/utils/meta-messaging.ts');
        assert.ok(mm.includes("const opened = after?.status === 'new' && (conv.created === true || conv.statusBefore !== 'new');"));
    });
    await check('both notification types are wired wherever a notification type must be', () => {
        for (const t of ['social_message_received', 'social_message_window_closing']) {
            assert.ok(read('src/utils/notification-templates-catalog.ts').includes(`templateKey: '${t}'`), `catalog: ${t}`);
            assert.ok(read('src/utils/notification-actions.ts').includes(`${t}: 'suggested_action'`), `category: ${t}`);
            assert.ok(read('src/utils/notification-prefs.ts').includes(`'${t}'`), `prefs: ${t}`);
            assert.ok(read('db/notifications-categorization.sql').includes(`WHEN '${t}' THEN 'suggested_action'`), `SQL mirror: ${t}`);
            assert.ok(read('notifications.js').includes(`notif.type === '${t}'`), `CTA: ${t}`);
        }
        assert.ok(lib.includes("metadata: { assistantId: r.assistantId, conversationId: r.conversationId, platform: r.platform }"), 'assistantId rides in metadata (per-assistant prefs)');
    });
    await check('the reminder is claimed per window before it is sent, so two ticks never remind twice', () => {
        const tick = lib.slice(lib.indexOf('export async function runMessagesTick'));
        const claimAt = tick.indexOf('remindedForWindow: sql`${socialConversations.windowClosesAt}`');
        const notifyAt = tick.indexOf("createNotification(db, 'social_message_window_closing'");
        assert.ok(claimAt !== -1 && notifyAt !== -1 && claimAt < notifyAt);
    });

    // ── The tab ──────────────────────────────────────────────────────────────────────────────
    await check('the tab is wired into the page and hides itself where messages are off or not set up', () => {
        const comp = read('src/components/assistant-messages.js');
        assert.ok(comp.includes("btn.classList.toggle('hidden', state.notSetUp || (!state.connection.enabled && !any));"));
        assert.ok(read('assistant-detail.html').includes('id="maintab-btn-messages"'));
        assert.ok(read('assistant-detail.html').includes('<div id="messages-host"></div>'));
        assert.ok(read('workspace.html').includes('<script src="/src/components/assistant-messages.js"></script>'));
        assert.ok(read('assistants.js').includes("if (name === 'messages') window.AssistantMessages?.activate();"));
        assert.ok(read('src/components/assistant-dashboard-registry.js').includes("messagesTab: { label: 'Messages' },"));
    });
    await check('every server value on the tab and the card is escaped', () => {
        const comp = read('src/components/assistant-messages.js');
        for (const raw of ['${m.body}', '${c.personLabel}', '${c.draftReply}', '${text}']) assert.ok(!comp.includes(raw), `unescaped ${raw}`);
        // confirmModal renders its message as HTML (dialogs.js) — the Send confirm escapes the name and the text.
        assert.ok(comp.includes('to ${esc(c.personLabel)} as a private ${esc(where)} message'));
        const card = read('src/components/disruptive-ui-registry.js');
        const map = card.slice(card.indexOf('function renderMessageActionProposalCard'), card.indexOf("register('message_action_proposal'"));
        for (const raw of ['${m.body}', '${ui.personLabel}', '${ui.draftReply}']) assert.ok(!map.includes(raw), `unescaped ${raw} on the card`);
    });

    // ── Phase 1 carry-overs ──────────────────────────────────────────────────────────────────
    await check('an out-of-range or missing timestamp becomes "now", never an Invalid Date', () => {
        const now = Date.parse('2026-11-20T10:00:00Z');
        assert.equal(sentAtFrom(Date.parse('2026-11-20T09:00:00Z'), now).toISOString(), '2026-11-20T09:00:00.000Z');
        for (const bad of [NaN, -1, 0, 1e20, Number.MAX_VALUE, now + 2 * 86_400_000, 1000]) {
            const d = sentAtFrom(bad, now);
            assert.ok(!Number.isNaN(d.getTime()), `Invalid Date for ${bad}`);
            assert.equal(d.getTime(), now);
        }
        const [m] = parseMessagingWebhook({ object: 'page', entry: [{ id: 'P', messaging: [{ sender: { id: 'U' }, recipient: { id: 'P' }, timestamp: 1e20, message: { mid: 'm', text: 'hi' } }] }] });
        assert.doesNotThrow(() => m.sentAt.toISOString());
    });
    await check('a postback with no mid and no timestamp gets the same id on every retry', () => {
        const body = { object: 'page', entry: [{ id: 'P', messaging: [{ sender: { id: 'U' }, recipient: { id: 'P' }, postback: { title: 'Book', payload: 'BOOK' } }] }] };
        const a = parseMessagingWebhook(body)[0].mid;
        const b = parseMessagingWebhook(JSON.parse(JSON.stringify(body)))[0].mid;
        assert.equal(a, b);
        assert.ok(a.startsWith('postback:'));
    });

    if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
    console.log('\nAll social-messages checks passed');
    process.exit(0);
}

main();
