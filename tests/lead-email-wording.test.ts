// tests/lead-email-wording.test.ts
// The Lead Generator's chat reads its emails' WORDING, not just their subjects (prod 2026-11-10, org 40:
// it described its settings and made up example closing questions, then admitted it could only see
// subject lines). src/utils/lead-email-wording.ts + the leads snapshot in chat-orchestrator.ts.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    LEAD_EMAIL_BODY_MAX, LEAD_EMAIL_WORDING_BUDGET, LEAD_EMAIL_WORDING_RULE, quoteLeadEmails, type LeadEmailLine,
} from '../src/utils/lead-email-wording';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const email = (id: number, body: string, extra: Partial<LeadEmailLine> = {}): LeadEmailLine => ({
    id, title: `Library ${id}`, where: 'To approve › Waiting for your approval', to: 'info@library.example', subject: `Subject ${id}`, body, ...extra,
});

check('each email is quoted word for word under its subject', () => {
    const r = quoteLeadEmails([email(2897, 'Hello there,\nWould a short talk on retirement help your patrons?\nAngela')], LEAD_EMAIL_WORDING_BUDGET);
    assert.ok(r.text.includes('- #2897 Library 2897 (To approve › Waiting for your approval, to info@library.example) — subject: "Subject 2897"'));
    assert.ok(r.text.includes('    > Would a short talk on retirement help your patrons?'));
    assert.ok(r.text.includes('    > Angela'));
});
check('a sent email says when it went', () => {
    const r = quoteLeadEmails([email(1, 'Hi', { where: 'Following up', sentAt: '2026-11-09T10:00:00.000Z' })], 1000);
    assert.ok(r.text.includes('(Following up, sent 2026-11-09, to'));
});
check('a long email is cut and marked', () => {
    const r = quoteLeadEmails([email(1, 'x'.repeat(LEAD_EMAIL_BODY_MAX + 500))], LEAD_EMAIL_WORDING_BUDGET);
    assert.ok(r.text.includes('[…]'));
    assert.ok(r.text.length < LEAD_EMAIL_BODY_MAX + 300);
});
check('once the budget is spent, the rest say their wording is left out, never blank', () => {
    const r = quoteLeadEmails([email(1, 'a'.repeat(900)), email(2, 'b'.repeat(900)), email(3, 'short')], 1000);
    assert.ok(r.text.includes('aaaa'));
    assert.ok(!r.text.includes('bbbb'));
    assert.ok(r.text.includes('- #2 Library 2'));
    assert.ok(r.text.includes('wording left out to keep this message short — never guess it'));
    assert.ok(!r.text.includes('> short'), 'nothing after the budget runs out, so the order stays honest');
    assert.strictEqual(r.left, 0);
});
check('the budget carries from the waiting list to the sent list', () => {
    const a = quoteLeadEmails([email(1, 'a'.repeat(100))], 500);
    assert.ok(a.left > 0 && a.left < 500);
    const b = quoteLeadEmails([email(2, 'b'.repeat(a.left + 10))], a.left);
    assert.ok(b.text.includes('wording left out'));
});
check('the rule says to answer from the wording and never invent examples', () => {
    assert.ok(LEAD_EMAIL_WORDING_RULE.includes('never make up example lines'));
    assert.ok(LEAD_EMAIL_WORDING_RULE.includes('Only first emails are shown here, not follow-ups.'));
});

const ORCH = readFileSync(path.join(process.cwd(), 'netlify/functions/chat-orchestrator.ts'), 'utf8');
check('the leads snapshot quotes waiting AND sent emails and carries the rule', () => {
    assert.ok(ORCH.includes('const waitingQuoted = quoteLeadEmails(waitingLines, wordingBudget);'));
    assert.ok(ORCH.includes('FIRST EMAILS ALREADY SENT (newest ${sentLines.length}, exactly as sent)'));
    assert.ok(ORCH.includes("eq(assistantRecords.approvalStatus, 'scheduled'),"));
    assert.ok(/\$\{outreachList\}\n\$\{sentList\}\n\n\$\{LEAD_EMAIL_WORDING_RULE\}/.test(ORCH));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
