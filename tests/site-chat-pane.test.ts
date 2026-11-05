// tests/site-chat-pane.test.ts
// The Website tab built like a chat-first site builder (owner, 2026-11-04, after trying Lovable):
//   1. the assistant asks its questions one at a time on a chat_questions card, and the answers go
//      back as the user's own message — the card itself changes and spends nothing;
//   2. the chat is docked as the first sub-tab of the pane beside the preview (preview left);
//   3. "Select" on the preview puts the clicked part on a chip above the chat's message box.
//
// Run:  npx tsx tests/site-chat-pane.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const editor = read('src/components/assistant-site-editor.js');
const session = read('src/components/chat-session.js');
const cards = read('src/components/disruptive-ui-registry.js');
const chat = read('netlify/functions/chat-orchestrator.ts');

let passed = 0;
const checks: [string, () => void][] = [];
const check = (name: string, fn: () => void) => checks.push([name, fn]);
const slice = (src: string, from: string, to: string) => {
    const a = src.indexOf(from);
    assert.ok(a > -1, `marker missing: ${from}`);
    const b = src.indexOf(to, a + from.length);
    assert.ok(b > -1, `end marker missing: ${to}`);
    return src.slice(a, b);
};

check('the question card asks one at a time and answers through the chat, nothing else', () => {
    assert.ok(cards.includes("register('chat_questions', renderChatQuestionsCard);"));
    const card = slice(cards, 'function renderChatQuestionsCard(', "register('chat_questions'");
    assert.ok(card.includes(".slice(0, 6)"), 'at most six questions');
    assert.ok(card.includes("new CustomEvent('chat:send'"), 'answers are sent as the user\'s message');
    for (const evt of ['site:apply', 'site:draft', 'site:import', 'fetch(']) assert.ok(!card.includes(evt), `the card must not ${evt}`);
    for (const b of ['data-cq-back', 'data-cq-skip', 'data-cq-skipall', 'data-cq-send', 'data-cq-other']) assert.ok(card.includes(b), b);
    assert.ok(card.includes("el.addEventListener('questions:closed'"), 'closes once anything is sent');
    // Every model value is escaped.
    assert.ok(card.includes('${esc(q.question)}') && card.includes('${esc(o.label)}') && card.includes('${esc(o.description)}') && card.includes('value="${esc(a.other)}"'));
});

check('the chat sends a card\'s answers as the user\'s own turn and closes open question cards', () => {
    assert.ok(session.includes("container.addEventListener('chat:send', onCardSend);") && session.includes("container.removeEventListener('chat:send', onCardSend);"));
    const h = slice(session, 'function onCardSend(', 'function onSubmit(');
    assert.ok(h.includes('if (readOnly)') && h.includes("sendMessage(String(d.text || ''), { noReference: true })"));
    const append = slice(session, 'function appendMessage(', 'const bubble = ');
    assert.ok(append.includes("if (isUser) scrollEl.querySelectorAll('[data-questions-open]')"));
});

check('a selected part rides in front of the next message, visibly, then clears', () => {
    const send = slice(session, 'async function sendMessage(', 'appendMessage({ role: \'user\'');
    assert.ok(send.includes('const message = withRef ? `${reference.message}\\n\\n${typed}` : typed;'));
    assert.ok(send.includes('if (withRef) setReference(null);'));
    assert.ok(session.includes('setReference,'), 'mount() hands it to the surface');
    assert.ok(session.includes('data-chat-ref-clear'), 'the chip can be removed');
});

check('the pane: Chat first, preview on the left, the chat mounted once and kept across repaints', () => {
    assert.ok(editor.includes("const SUBTABS_ALL = [['chat', 'Chat'], ['setup', 'Set up']"));
    assert.ok(editor.includes("[data-sb-preview-col] { order: 1; } [data-sb-pane] { order: 2; }"));
    assert.ok(editor.includes("const blocks = P === 'chat' ? [] :"));
    const paint = slice(editor, 'function paintChat(', 'async function mountChat(');
    assert.ok(paint.includes('box.contains(chatPane.mountEl)) return;'), 'a repaint must not remount the chat');
    const mount = slice(editor, 'async function mountChat(', '// ── "Select"');
    assert.ok(mount.includes("d.session.status !== 'archived'") && mount.includes('Number(d.session.aiAssistantId) === Number(forId)'), 'only carries on its own, live thread');
    assert.ok(mount.includes("roleKey: 'website_assistant'"));
    // The chat's own cards still refresh the preview.
    assert.match(editor, /document\.addEventListener\('site:changed'/);
});

check('"Select" only describes what was clicked — it never changes the site', () => {
    const pick = slice(editor, '// ── "Select"', '/** The preview full screen');
    for (const w of ["action: 'apply'", 'apply(', 'post(', 'fetch(']) assert.ok(!pick.includes(w), `picker must not ${w}`);
    assert.ok(pick.includes('About this part of my website: the ${typeLabel} section${where} (section ${sec.id})'));
    assert.ok(pick.includes("if (e.key === 'Escape')"), 'Esc stops selecting');
    assert.ok(editor.includes('if (picker.on) attachPicker(e.target);'), 'still selecting after the preview reloads');
    // The prompt reads the same opening words.
    assert.ok(chat.includes('A message may start "About this part of my website:"'));
});

check('the Website Assistant is told to ask with the card, then propose with its usual one', () => {
    const at = chat.indexOf('ASK STEP BY STEP BEFORE YOU BUILD.');
    assert.ok(at > -1);
    const rule = chat.slice(at, chat.indexOf('WHAT THEY SELECTED ON THE PAGE.', at));
    assert.ok(rule.includes('ONE chat_questions card') && rule.includes('"My answers:"') && rule.includes('site_draft_request'));
    assert.ok(chat.includes('"type": "chat_questions"'), 'in the reply shapes');
    const s = slice(chat, 'function websiteAssistantSurfaces()', '\n}');
    for (const n of ['"Chat"', '"Select"']) {
        assert.ok(s.includes(n), `surfaces: ${n}`);
        assert.ok(editor.includes(n.replace(/"/g, "'")), `editor: ${n}`);
    }
});

for (const [name, fn] of checks) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.log(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
console.log(`\n${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exit(1);
