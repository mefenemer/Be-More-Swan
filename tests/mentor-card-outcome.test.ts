// tests/mentor-card-outcome.test.ts
// The Business Mentor sees what the user did with each card it drew (src/utils/mentor-card-outcome.ts).
// Staging 2026-10-26: after "Remove this" worked, the next reply said there had been no product to
// remove — it saw the empty list but not the click.
//
// Run:  npx tsx tests/mentor-card-outcome.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cardOutcomeLine, cleanCardOutcome } from '../src/utils/mentor-card-outcome';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('Mentor card outcomes');

test('the request: a real message id and a known outcome; the note is trimmed and capped', () => {
    assert.deepStrictEqual(cleanCardOutcome({ messageId: '12', outcome: 'applied', note: '  Removed.  ' }), { ok: true, messageId: 12, status: 'applied', note: 'Removed.' });
    assert.ok(!cleanCardOutcome({ messageId: 0, outcome: 'applied' }).ok);
    assert.ok(!cleanCardOutcome({ messageId: 3, outcome: 'maybe' }).ok);
    const long = cleanCardOutcome({ messageId: 3, outcome: 'failed', note: 'x'.repeat(900) });
    assert.ok(long.ok && long.note!.length === 300);
});

test('the line the model reads: applied, failed, Not now, dismissed, unanswered — and none without a card', () => {
    const card = { type: 'mentor_products_remove', summary: 'Remove "TEST — remove me"' };
    assert.match(cardOutcomeLine({ ...card, outcome: { status: 'applied', note: 'Removed from Products & Services.' } })!, /clicked it and it was saved \(Removed from Products & Services\.\)\. That change has been made\./);
    assert.match(cardOutcomeLine({ ...card, outcome: { status: 'failed', note: 'HTTP 500' } })!, /failed \(HTTP 500\), so nothing changed/);
    assert.match(cardOutcomeLine({ ...card, outcome: { status: 'not_now', note: null } })!, /"Not now", so nothing changed/);
    assert.match(cardOutcomeLine({ ...card, answered: 'dismissed' })!, /dismissed it/);
    assert.match(cardOutcomeLine(card)!, /has not answered it yet/);
    assert.strictEqual(cardOutcomeLine(null), null);
    assert.strictEqual(cardOutcomeLine({ hubLink: {} }), null);
});

test('the write: this user\'s own chat in this workspace, an assistant reply with a card', () => {
    const src = read('src/utils/mentor-card-outcome.ts');
    for (const cond of ['s.organisation_id = ${orgId}', 's.user_id = ${userId}', "m.role = 'assistant'", "jsonb_typeof(m.ui_element_json) = 'object'"]) assert.ok(src.includes(cond), cond);
    const mentor = read('netlify/functions/mentor.ts');
    assert.match(mentor, /body\.action === 'card_outcome'\) \{[\s\S]{0,200}recordCardOutcome\(db, orgId, ctx\.userId, c\)/);
});

test('the Mentor route adds the line under each earlier reply that carried a card', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /route === ROUTES\.business_mentor && m\.role === 'assistant' && cardOutcomeLine\(m\.uiElementJson\)/);
});

test('every click on a Mentor card reports what happened, and the chat saves it on the card\'s message', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    for (const call of ["outcome('not_now')", "outcome('dismissed', reason)", "outcome('failed', error)", "outcome('applied', message || doneText)"]) assert.ok(reg.includes(call), call);
    const sess = read('src/components/chat-session.js');
    assert.ok(sess.includes("addEventListener('mentor:cardOutcome', onMentorCardOutcome)") && sess.includes("removeEventListener('mentor:cardOutcome', onMentorCardOutcome)"));
    assert.ok(sess.includes('row.dataset.chatMessageId = String(message.id)'));
    assert.match(sess, /action: 'card_outcome', messageId/);
    assert.ok(sess.includes('showSavedCardOutcome(card, uiElement.outcome)'), 'a reloaded chat shows the saved result, not the buttons');
});

console.log(`\n${passed}/${total} passed`);
