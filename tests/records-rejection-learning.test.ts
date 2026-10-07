// tests/records-rejection-learning.test.ts
// Tier 1 Support, Meeting Note Taker and the AR Clerk learn from a rejection:
//   reject (assistants.js, optional note) → assistant-records.ts PATCH `feedback`
//   → content_rules row (origin 'rejection_feedback') → chat-orchestrator.ts reads it every turn
//   via src/utils/assistant-rules-prompt.ts.
//
// These roles produce records ONLY through chat, and before this the chat prompt never opened
// content_rules, so their Assistant Rules and any rejection note reached nothing. No network, no DB.
//
// Run:  npx tsx tests/records-rejection-learning.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRulesBlock, RULE_READING_ROLES, FEEDBACK_RECORD_TYPES } from '../src/utils/assistant-rules-prompt';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (p: string) => read(p).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

console.log('formatRulesBlock');
check('no rules → no block (the prompt is unchanged)', () => {
    assert.equal(formatRulesBlock([]), null);
    assert.equal(formatRulesBlock([{ ruleText: '   ', origin: 'manual' }]), null);
});
check('each rule is one line, and feedback rules say where they came from', () => {
    const b = formatRulesBlock([
        { ruleText: 'Never promise a refund', origin: 'rejection_feedback' },
        { ruleText: 'Sign off as\n  the Support Team', origin: 'manual' },
    ])!;
    assert.match(b, /^RULES FROM YOUR USER/);
    assert.ok(b.includes('- Never promise a refund (from feedback on something you produced that they rejected)'));
    assert.ok(b.includes('- Sign off as the Support Team\n') || b.endsWith('- Sign off as the Support Team'));
    assert.ok(b.includes('the rule wins'));
});
check('the block is capped, keeping the newest rules (they come first)', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ruleText: `rule number ${i} `.repeat(5), origin: 'manual' }));
    const b = formatRulesBlock(many)!;
    assert.ok(b.length < 4500, `block is ${b.length} chars`);
    assert.ok(b.includes('rule number 0 '));
    assert.ok(!b.includes('rule number 199 '));
});

console.log('scope');
check('exactly the three chat-only roles read rules in chat', () => {
    assert.deepEqual([...RULE_READING_ROLES].sort(), ['accounts_receivable_clerk', 'meeting_note_taker', 'tier1_support_agent']);
});
check('leads are NOT a feedback record type (they keep their own reasons)', () => {
    assert.ok(!FEEDBACK_RECORD_TYPES.has('lead'));
    assert.deepEqual([...FEEDBACK_RECORD_TYPES].sort(), ['invoice', 'meeting', 'ticket']);
});
check('the UI nouns mirror FEEDBACK_RECORD_TYPES', () => {
    const js = read('assistants.js');
    const m = js.match(/const _RQ_FEEDBACK_NOUNS = \{([^}]*)\}/);
    assert.ok(m, '_RQ_FEEDBACK_NOUNS not found');
    const keys = [...m![1].matchAll(/(\w+):/g)].map(x => x[1]).sort();
    assert.deepEqual(keys, [...FEEDBACK_RECORD_TYPES].sort());
});

console.log('wiring');
check('chat reads the rules for those roles, appended to the role prompt', () => {
    const src = code('netlify/functions/chat-orchestrator.ts');
    assert.ok(src.includes('RULE_READING_ROLES.has(assistantRow.roleKey)'));
    assert.ok(src.includes('loadAssistantRulesBlock(db, { assistantId: session.aiAssistantId, organisationId: orgId })'));
    assert.ok(src.indexOf('const promptWithRules') < src.indexOf('const system = buildSystemPrompt('));
});
check('the reject saves the feedback AFTER the record update commits, and only for feedback types', () => {
    const src = code('netlify/functions/assistant-records.ts');
    assert.ok(src.includes("next === 'rejected' && feedbackText && prev && FEEDBACK_RECORD_TYPES.has(prev.recordType)"));
    const patchTail = src.slice(src.indexOf('const [row] = await db.update(assistantRecords)'));
    assert.ok(patchTail.indexOf('if (!row)') < patchTail.indexOf('db.insert(contentRules)'));
    assert.ok(src.includes("origin: 'rejection_feedback'"));
});
check('the UI asks before rejecting, lets a blank answer just reject, and cancel abort', () => {
    const js = read('assistants.js');
    const branch = js.slice(js.indexOf("else if (action === 'reject') {"), js.indexOf('_rqPendingReject = { recordId'));
    assert.ok(branch.includes('await window.promptModal('));
    assert.ok(branch.includes('if (answer === null) return;'));
    assert.ok(branch.includes('if (answer.trim()) patch.feedback = answer.trim();'));
    assert.ok(!/required:\s*true/.test(branch), 'the note must stay optional');
});
check('Learned Directives shows for the chat roles, without the social-only Tuning button', () => {
    const js = read('assistants.js');
    assert.ok(js.includes("return (rq.kind || 'posts') === 'posts' || _rulesReachChat();"));
    assert.ok(js.includes("tuneBtn.classList.toggle('hidden', viaChat)"));
    assert.ok(read('assistant-detail.html').includes('id="btn-start-tuning"'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
