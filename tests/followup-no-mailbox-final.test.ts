// tests/followup-no-mailbox-final.test.ts
// PR #695 review fixes (2026-11-17):
//   1. "No mailbox" is FINAL for a meeting job: process-scenario-jobs.ts must not count it as an error,
//      or the whole job re-queues and the custom webhook (no once-guard) POSTs again on every attempt.
//   2. "Send the follow-up now" refuses when the follow-up recipe is switched off for the assistant.
//   3. The catalog seed no longer promises a Be More Swan address.
//
// Run:  npx tsx tests/followup-no-mailbox-final.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isNoMailboxResult } from '../src/utils/meeting-followup-send';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(p, 'utf8');

check('isNoMailboxResult: only a 409 with code no_mailbox', () => {
    assert.equal(isNoMailboxResult(409, { code: 'no_mailbox', error: 'x' }), true);
    assert.equal(isNoMailboxResult(409, { code: 'other' }), false);
    assert.equal(isNoMailboxResult(502, { code: 'no_mailbox' }), false, 'a refused send stays retryable');
    assert.equal(isNoMailboxResult(409, null), false);
    assert.equal(isNoMailboxResult(409, 'no_mailbox'), false);
});

check('sync-action still answers no mailbox with 409 + code no_mailbox (the contract the runner reads)', () => {
    const sa = read('netlify/functions/sync-action.ts');
    assert.ok(sa.includes("return json(409, { error: err.message, code: err.code });"));
    assert.ok(read('src/utils/meeting-followup-send.ts').includes("readonly code = 'no_mailbox';"));
});

const jobs = read('netlify/functions/process-scenario-jobs.ts');

check('job runner skips no-mailbox BEFORE pushing an error', () => {
    const i = jobs.indexOf('if (isNoMailboxResult(result.statusCode, body)) {');
    const j = jobs.indexOf('errors.push(`${scenario.scenarioKey}: ${body.error ?? result.statusCode}`);');
    assert.ok(i > 0 && j > 0 && i < j);
    assert.ok(jobs.slice(i, j).includes('continue;'));
});

check('job runner still releases the claim on no mailbox (so "Send the follow-up now" can send later)', () => {
    assert.ok(jobs.includes('if (once) await finishMeetingHandoff(db, job.organisationId, Number(subject.recordId), scenario.actionType, result.statusCode < 400);'));
});

const rec = read('netlify/functions/assistant-records.ts');

check('Send the follow-up now: refuses when the recipe is off, after the mailbox check, before queueing', () => {
    const a = rec.indexOf("if (!(await connectedMailbox(db, orgId))) return json(409, { error: NO_MAILBOX_MESSAGE, code: 'no_mailbox' });");
    const b = rec.indexOf("if (!followupOn) return json(409, { error: FOLLOWUP_OFF_MESSAGE, code: 'followup_off' });");
    const c = rec.indexOf("await enqueueHandoffOnApproval(db, orgId, m, ['email_meeting_followup']);");
    assert.ok(a > 0 && b > a && c > b);
    const q = rec.slice(a, b);
    for (const s of ['eq(activeScenarios.organisationId, orgId)', 'eq(activeScenarios.assistantId, m.aiAssistantId)',
        'eq(activeScenarios.isEnabled, true)', "eq(integrationScenarios.actionType, 'email_meeting_followup')"]) {
        assert.ok(q.includes(s), s);
    }
});

check('the Inbox shows the server\'s refusal text', () => {
    assert.ok(read('assistants.js').includes("if (!res.ok) throw new Error(data.error || 'The follow-up couldn’t be sent. Please try again.');"));
});

check('catalog seed no longer promises a Be More Swan address', () => {
    const seed = read('db/seed-catalog.ts');
    const i = seed.indexOf("scenarioKey: 'email_meeting_followup'");
    const block = seed.slice(i, seed.indexOf('}', i));
    assert.ok(!/from Be More Swan/.test(block));
    assert.ok(block.includes('from your own connected Gmail or Outlook'));
});

console.log(`\n${passed} passed`);
