// tests/chat-card-list.test.ts
// A reply that carries several cards keeps the first one, instead of losing them all in silence.
//
// WHY THIS EXISTS. Prod 2026-11-07, org 40, Business Mentor: asked to make three changes, the model
// sent them together. Every card check reads ONE object, so the list matched no card type and was
// dropped with nothing said — six replies in a row said "the card is below" over no card, and the
// ticket the user asked for about it vanished the same way. The token counts showed the cards had
// been written. Two of those replies ("The card is below this time") also slipped past the
// missing-card note.
//
// Run:  npx tsx tests/chat-card-list.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { firstCard, missingCardReply, MORE_CARDS_NOTE, NO_CARD_NOTE } from '../src/utils/confirm-card-reply';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

console.log('\nOne card, however it was sent');

check('a single card is kept as it is', () => {
    assert.deepStrictEqual(firstCard({ reply: 'x', uiElement: { type: 'mentor_support_request' } }), { card: { type: 'mentor_support_request' }, extra: 0 });
});

check('a list keeps its first card and counts the rest', () => {
    const r = firstCard({ reply: 'x', uiElement: [{ type: 'setup_field_proposal' }, { type: 'mentor_products' }, { type: 'strategy_proposal' }] });
    assert.deepStrictEqual(r, { card: { type: 'setup_field_proposal' }, extra: 2 });
});

check('cards under "uiElements" or "cards" are found too', () => {
    assert.deepStrictEqual(firstCard({ reply: 'x', uiElements: [{ type: 'a' }] }).card, { type: 'a' });
    assert.deepStrictEqual(firstCard({ reply: 'x', cards: { type: 'b' } }).card, { type: 'b' });
});

check('no card, null, or a list of nothing is no card', () => {
    assert.deepStrictEqual(firstCard({ reply: 'x' }), { card: null, extra: 0 });
    assert.deepStrictEqual(firstCard({ reply: 'x', uiElement: null }), { card: null, extra: 0 });
    assert.deepStrictEqual(firstCard({ reply: 'x', uiElement: [null, 'text'] }), { card: null, extra: 0 });
});

check('the structured parser uses it, and says when cards were left for later', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    const fn = src.slice(src.indexOf('function parseStructuredReply('), src.indexOf('function parseStructuredReply(') + 1200);
    assert.ok(fn.includes('firstCard(parsed)'));
    assert.ok(fn.includes('MORE_CARDS_NOTE'));
    assert.ok(MORE_CARDS_NOTE.includes('one card at a time'));
});

check('the Mentor is told one card object, never a list', () => {
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('uiElement is ONE card object, never a list'));
});

console.log('\nA reply that points at a missing card says so');

check('"the card is below this time" with no card gets the note', () => {
    for (const reply of ['Sorry about that. The card is below this time.', 'This time the card really is below.']) {
        assert.ok(missingCardReply(reply, false).endsWith(NO_CARD_NOTE), reply);
        assert.strictEqual(missingCardReply(reply, true), reply);
    }
});

console.log(`\n${passed} of ${total} passed\n`);
if (passed !== total) process.exit(1);
