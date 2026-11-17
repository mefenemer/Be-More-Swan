// Minute Taker run B (staging 2026-11-17): the deployed chat lost its add-email card three ways — a card sent on
// its own (read as a broken reply), a card under a key the server didn't look at, and an empty reply.
// Run: npx tsx tests/chat-bare-card-empty-reply.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firstCard } from '../src/utils/confirm-card-reply';

const card = { type: 'meeting_action_proposal', action: 'add_email', recordId: 920, attendeeName: 'Cara Singh', email: 'x@y.com' };

// 1. A card under another key is found — only when it is a card, and only when there is one.
assert.deepEqual(firstCard({ reply: 'Here it is.', card }), { card, extra: 0 });
assert.deepEqual(firstCard({ reply: 'Here it is.', meeting_action_proposal: card }), { card, extra: 0 });
assert.deepEqual(firstCard({ reply: 'x', meta: { note: 'no type' } }), { card: null, extra: 0 }, 'an object with no type is not a card');
assert.deepEqual(firstCard({ reply: 'x', a: card, b: { ...card, recordId: 1 } }), { card: null, extra: 0 }, 'two unkeyed cards: neither is guessed');
assert.deepEqual(firstCard({ reply: 'x', uiElement: card, other: { type: 'z' } }), { card, extra: 0 }, 'uiElement still wins');

// 2. The orchestrator: a bare card is kept, an empty reply is said and recorded, a card is never wordless.
const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
const parse = orch.slice(orch.indexOf('function parseStructuredReply('), orch.indexOf('function parseStructuredReply(') + 2000);
assert.ok(parse.includes('const lone = loneCard(stripped, parsed);'));
assert.ok(parse.indexOf('loneCard(stripped, parsed)') < parse.indexOf('looksLikeStructuredAttempt('), 'checked before the "broken reply" fallback');
assert.ok(orch.includes('const emptyReply = !raw.trim();') && orch.includes('content = EMPTY_REPLY_FALLBACK;'));
assert.ok(orch.includes('if (!droppedCard && emptyReply) {') && orch.includes('stop_reason=${String(response.stop_reason)}'), 'the stop reason is kept in the hidden row');
assert.ok(orch.includes('if (uiElement && !content.trim()) content = CARD_ONLY_REPLY;'));
console.log('chat-bare-card-empty-reply: all checks passed');
