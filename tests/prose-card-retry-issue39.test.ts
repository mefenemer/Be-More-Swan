// tests/prose-card-retry-issue39.test.ts
// Issue #39 (prod 2026-11-11, org 41, Website Assistant session 114): "a site picture card was missing
// twice in a row". Every [card-dropped] row that day said 'reply was prose, not JSON' — the model wrote
// "The card below…" as plain text with no envelope, so no card could be drawn. Such a reply is now asked
// for once more, as JSON (chat-orchestrator.ts). The replies below are the real ones from prod.
//
// Run:  npx tsx tests/prose-card-retry-issue39.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CARD_FORMAT_RETRY, proseReplyLostItsCard } from '../src/utils/confirm-card-reply';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');
const prose = (raw: string) => ({ content: raw.trim(), uiElement: null });

console.log('Prose that points at a card it never sent is asked for again (#39)');
check('the prod replies are retried', () => {
    for (const raw of [
        'The card below gives you options for a picture in the "Unmatched experience and proven results" section on your About Us page. I\'ve set it to open My Content so you can use one of your own.',
        'The card below opens My Content so you can pick one of your own pictures for the "Unmatched experience and proven results" section on your About Us page, or switch to a free stock photo or an AI-made one (1 task).',
        'The card below centres the "About this session" heading on your Online reflection post training page. Press its button to add it to your draft.',
    ]) assert.strictEqual(proseReplyLostItsCard(raw, prose(raw)), true, raw);
});
check('a reply that carries a card is left alone', () => {
    const raw = '{"reply":"The card below…","uiElement":{"type":"site_picture"}}';
    assert.strictEqual(proseReplyLostItsCard(raw, { content: 'The card below…', uiElement: { type: 'site_picture' } }), false);
});
check('a broken JSON attempt is not prose (it has its own fallback)', () => {
    const raw = '{"reply": "The card below opens My Content", "uiElement": {"type": "site_pic';
    assert.strictEqual(proseReplyLostItsCard(raw, prose('Sorry — something went wrong')), false);
});
check('plain answers and offers are not retried', () => {
    for (const raw of [
        'Your home page has a hero, three text sections and a contact form.',
        'I can put a card here whenever you’re ready.',
        'Tell me which section and I’ll put it on a card for you to approve.',
    ]) assert.strictEqual(proseReplyLostItsCard(raw, prose(raw)), false, raw);
});
check('the retry asks for the envelope and allows no card', () => {
    assert.ok(CARD_FORMAT_RETRY.includes('"uiElement"'));
    assert.ok(CARD_FORMAT_RETRY.includes('"uiElement": null'));
});

console.log('The orchestrator wiring');
const src = read('netlify/functions/chat-orchestrator.ts');
check('retries only structured routes, with time to spare, once', () => {
    assert.ok(src.includes('route.parseResponse === parseStructuredReply && Date.now() - replyStartedAt < 10_000 && proseReplyLostItsCard(raw, parsed)'));
    assert.ok(src.includes('{ timeout: 10_000, maxRetries: 0 }'));
    assert.strictEqual(src.split('CARD_FORMAT_RETRY').length - 1, 2, 'imported once, used once');
});
check('the retry is kept only when it brings a card', () => {
    assert.ok(src.includes('if (reparsed.uiElement) { raw = again; parsed = reparsed; }'));
});
check('the dropped-card row names the route, not [object Object]', () => {
    assert.ok(!src.includes('route: String(route)'));
    assert.ok(src.includes("droppedCardRecord({ route: assistantRow.roleKey && ROUTES[assistantRow.roleKey] ? assistantRow.roleKey : 'default',"));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
