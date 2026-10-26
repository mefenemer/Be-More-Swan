// tests/mentor-chat-review-fixes.test.ts
// Fixes from reviewing a long Business Mentor chat on prod (2026-10-26):
//   - "The Digital Employee" — an ARCHIVED product — showed in the Mentor's Products & Services list, so it
//     told the owner they sold three plans; every other assistant only ever reads active rows.
//   - The Mentor drafted a "Who is NOT a customer?" over the 200-character limit it was never told, and the
//     card was refused.
//   - A three-line email signature showed on one line in the card.
//   - After the owner corrected the signature, the OLD card (wrong name) could still be saved over the new.
//   - The Email signature placeholder, shown to every customer, carried a real name.
//
// Run:  npx tsx tests/mentor-chat-review-fixes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderSetupFields } from '../src/utils/setup-field';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('Business Mentor: chat review fixes');

test('the Mentor reads ACTIVE products only, in the business\'s order', () => {
    const snap = read('src/utils/mentor-snapshot.ts');
    const at = snap.indexOf('.from(orgProducts)');
    assert.ok(at !== -1);
    const q = snap.slice(at, at + 250);
    assert.ok(q.includes("eq(orgProducts.status, 'active')"), 'archived products leak into the list');
    assert.ok(q.includes('asc(orgProducts.sortOrder)'));
});

test('a text answer tells the model its length limit', () => {
    const lines = renderSetupFields('lead_qualifier', {}).join('\n');
    assert.match(lines, /"Who is NOT a customer\?": now "Not answered"; text, at most 200 characters/);
    assert.match(lines, /"Email signature": now "Not answered"; text, at most 2000 characters/);
});

test('the card keeps a multi-line answer\'s lines', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    const card = reg.slice(reg.indexOf("register('setup_field_proposal'"), reg.indexOf('function retireOlderSetupCards'));
    assert.ok(card.includes('font-semibold text-gray-900 whitespace-pre-line'), '"Change to" keeps line breaks');
});

test('a newer card for the same answer retires the older one, on screen and in the database', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('setup_field_proposal', (ui, esc) => retireOlderSetupCards(mentorCard("));
    const fn = reg.slice(reg.indexOf('function retireOlderSetupCards'), reg.indexOf('function retireOlderSetupCards') + 1600);
    assert.ok(fn.includes('const sig = `${ui.assistantId}:${ui.key}`'));
    assert.ok(fn.includes('if (otherId < id) retire(other)') && fn.includes('if (newest > id) retire(el)'), 'newest wins, whatever the order');
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('if (proposalId) await supersedeSetupFieldProposals(db, orgId, { id: proposalId, assistantId: card.assistantId, key: card.key });'));
    const props = read('src/utils/mentor-proposals.ts');
    const sup = props.slice(props.indexOf('export async function supersedeSetupFieldProposals'), props.indexOf('/** "Bring back"'));
    for (const s of ["eq(mentorProposals.kind, 'setup_field')", "eq(mentorProposals.status, 'shown')", 'eq(mentorProposals.targetAssistantId, keep.assistantId)', "->> 'key' = ${keep.key}", '<> ${keep.id}']) {
        assert.ok(sup.includes(s), s);
    }
});

test('no real name in the Email signature placeholder', () => {
    const schemas = read('src/public/assistant-onboarding-schemas.js');
    const at = schemas.indexOf("key: 'outreachSignature'");
    assert.ok(at !== -1);
    assert.ok(!/Fenemer|Be More Swan|bemoreswan/i.test(schemas.slice(at, at + 400)));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
