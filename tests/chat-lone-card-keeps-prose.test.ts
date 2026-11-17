// tests/chat-lone-card-keeps-prose.test.ts
// #703 review (Changes needed on 1b893fef), BEHAVIOUR checks:
//   1. A reply that is prose THEN a card keeps the prose: it is not taken as a lone card (the prod
//      2026-11-08 shape, org 40, Website Assistant), so splitProseAndCard keeps both.
//   2. A card sent on its own (fenced or bare, even with raw newlines in a string) is still kept.
//   3. {"type":"text",…} and other generic shapes are not cards.
//   4. An explicit `uiElement: null` is never overridden by an object found under another key.
//   5. The handler never leaves an empty bubble when a lone card is refused later.
//
// Run:  npx tsx tests/chat-lone-card-keeps-prose.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loneCard, hasCardType, firstCard } from '../src/utils/confirm-card-reply';
import { parseModelJson, splitProseAndCard, stripCodeFences } from '../src/utils/model-json';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// What parseStructuredReply does first, step for step (chat-orchestrator.ts).
const lone = (raw: string) => loneCard(stripCodeFences(raw), parseModelJson<Record<string, unknown>>(raw));

const siteCard = { type: 'site_changes', changes: [{ page: 'home', field: 'headline', value: 'Hello' }] };
const proseThenCard = `I've drafted the new headline for your home page. Have a look below.\n\n${JSON.stringify(siteCard)}`;

check('prose then a card: NOT a lone card, and the split keeps the prose', () => {
    assert.ok(parseModelJson(proseThenCard), 'parseModelJson does find the object (why the old check fired)');
    assert.equal(lone(proseThenCard), null);
    const split = splitProseAndCard(proseThenCard);
    assert.ok(split, 'splitProseAndCard handles it');
    assert.match(split!.prose, /drafted the new headline/);
    assert.equal(split!.card.type, 'site_changes');
});

check('prose then a fenced card: NOT a lone card', () => {
    const raw = `Here's the change:\n\`\`\`json\n${JSON.stringify(siteCard)}\n\`\`\``;
    assert.equal(lone(raw), null);
});

check('a card on its own is kept: bare, fenced, and with a raw newline in a string', () => {
    const card = { type: 'meeting_action_proposal', action: 'add_email', recordId: 920, email: 'x@y.com' };
    assert.deepEqual(lone(JSON.stringify(card)), card);
    assert.deepEqual(lone('```json\n' + JSON.stringify(card, null, 2) + '\n```'), card);
    const withNewline = '{"type":"meeting_action_proposal","note":"line one\nline two","recordId":920}';
    assert.equal(lone(withNewline)?.type, 'meeting_action_proposal');
});

check('two objects, or an envelope, are not a lone card', () => {
    assert.equal(lone(`${JSON.stringify(siteCard)} and also ${JSON.stringify(siteCard)}`), null);
    assert.equal(lone(JSON.stringify({ reply: 'hi', uiElement: siteCard })), null);
    assert.equal(lone(JSON.stringify({ type: 'site_changes', uiElement: null })), null);
});

check('generic shapes are not cards', () => {
    assert.equal(lone(JSON.stringify({ type: 'text', text: 'hello' })), null);
    assert.equal(lone(JSON.stringify({ type: 'message', content: 'x' })), null);
    assert.equal(lone(JSON.stringify({ type: 'site_changes' })), null, 'a type and nothing else');
    assert.equal(hasCardType({ type: 'blog_action_proposal', id: 1 }), true);
    assert.equal(hasCardType({ type: '  ', id: 1 }), false);
});

check('explicit uiElement: null is never overridden by an object under another key', () => {
    const card = { type: 'meeting_action_proposal', recordId: 1 };
    assert.deepEqual(firstCard({ reply: 'No card this time.', uiElement: null, card }), { card: null, extra: 0 });
    assert.deepEqual(firstCard({ reply: 'Here it is.', card }), { card, extra: 0 }, 'without uiElement the search still runs');
    assert.deepEqual(firstCard({ reply: 'x', note: { type: 'text', body: 'y' } }), { card: null, extra: 0 });
});

check('handler: a refused lone card falls back to the retry line and keeps a hidden row', () => {
    const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
    const a = orch.indexOf('if (uiElement && !content.trim()) content = CARD_ONLY_REPLY;');
    const b = orch.indexOf('if (!uiElement && !content.trim()) {', a);
    assert.ok(a > 0 && b > a);
    const block = orch.slice(b, b + 700);
    assert.ok(block.includes('content = STRUCTURED_REPLY_FALLBACK;'));
    assert.ok(block.includes('sentUiElement: parsed.uiElement, raw'));
    assert.ok(block.includes('(a card sent on its own was refused)'));
});

console.log(`\n${passed} passed`);
