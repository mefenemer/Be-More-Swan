// tests/lead-assistant-step.test.ts
// "Ask <name> to …" on a lead's suggested next step — from the lead panel, from ticked leads in the
// All leads table, and from chat (owner, 2026-11-03).
//
// WHY THIS EXISTS. The three surfaces read ONE rule (src/config/lead-recipient.ts leadAssistantStep,
// stringified into the browser as window.LeadAssistantStep), decided from the lead's STATE, never
// from the model's sentence. These pin the rule's order, that sending is never one of its steps, and
// that each surface is wired to it.
//
// Run:  npx tsx tests/lead-assistant-step.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { leadAssistantStep, LEAD_NEXT_STEP_BULK_MAX } from '../src/config/lead-recipient';
import { leadActionFromUiElement } from '../src/utils/chat-lead-action';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8');

const draft = { to: 'ops@acme.test', subject: 'Hi', body: 'Hello there' };

check('an unresearched lead: the assistant researches it — even with no address, since research looks for one', () => {
    assert.strictEqual(leadAssistantStep('pending_approval', {}).step, 'research');
    assert.strictEqual(leadAssistantStep('pending_approval', { contactEmail: 'a@b.test' }).step, 'research');
});

check('a researched lead with an address, not yet in Outreach: the assistant moves it there', () => {
    assert.strictEqual(leadAssistantStep('pending_approval', { intel: { x: 1 }, contactEmail: 'a@b.test', outreachStage: 'triage' }).step, 'move_to_outreach');
});

check('a researched lead with no address is the user’s — research already ran and found none', () => {
    const r = leadAssistantStep('pending_approval', { intel: { x: 1 } });
    assert.strictEqual(r.step, null);
    assert.match(r.whyNot || '', /address/i);
});

check('already in Outreach ▸ Review: reading and approving the email is the user’s — sending is never a step', () => {
    const r = leadAssistantStep('pending_approval', { intel: { x: 1 }, outreachDraft: draft });
    assert.strictEqual(r.step, null);
    assert.strictEqual(leadAssistantStep('approved', { intel: { x: 1 }, outreachDraft: draft }).step, null);
});

check('terminal states offer nothing, ahead of research', () => {
    assert.strictEqual(leadAssistantStep('pending_approval', { erasedAt: '2026-11-01' }).step, null);
    assert.strictEqual(leadAssistantStep('rejected', {}).step, null);
    assert.strictEqual(leadAssistantStep('scheduled', {}).step, null);
    assert.strictEqual(leadAssistantStep('pending_approval', { outreachSentAt: '2026-11-01' }).step, null);
    assert.strictEqual(leadAssistantStep('pending_approval', { dealOutcome: { outcome: 'won' } }).step, null);
});

check('the chat parses next_step for one lead or many', () => {
    assert.deepStrictEqual(leadActionFromUiElement({ type: 'lead_action_proposal', action: 'next_step', recordId: '#12' })?.recordIds, [12]);
    assert.deepStrictEqual(leadActionFromUiElement({ type: 'lead_action_proposal', action: 'next_step', recordIds: ['#3', 4, 4] })?.recordIds, [3, 4]);
    assert.strictEqual(leadActionFromUiElement({ type: 'lead_action_proposal', action: 'next_step' }), null);
});

check('the browser runs the SAME rule, and the bulk cap travels with it', () => {
    const gen = read('src/generated/platform-constants.js');
    assert.ok(gen.includes('window.LeadAssistantStep'), 'regenerate: npm run gen:constants');
    assert.ok(gen.includes(`BULK_MAX: ${LEAD_NEXT_STEP_BULK_MAX}`));
});

check('the All leads table offers it in bulk, and the chat can action it', () => {
    const hub = read('src/components/assistant-data-hub.js');
    assert.ok(hub.includes('data-hub-bulknext') && hub.includes('function bulkNextStepStrip'));
    assert.ok(/LAS\.of\(r\.approvalStatus/.test(hub), 'the bulk strip must read the shared rule');
    const chat = read('src/components/chat-session.js');
    assert.ok(chat.includes("d.action === 'next_step'"));
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("ui.action === 'next_step'"));
});

console.log(`\n${passed} of ${total} checks passed.`);
if (passed !== total) process.exit(1);
