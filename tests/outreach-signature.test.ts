// tests/outreach-signature.test.ts
// The Lead Generator's email signature (2026-10-01): plain text, added in code at every send site,
// and — while set — the drafts stop signing off so nothing is signed twice.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendSignature, normaliseSignature, signatureFromContext } from '../src/utils/outreach-signature';
import { senderIdentityBlock } from '../src/config/sender-identity';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('a signature is cleaned to plain, bounded lines', () => {
    assert.strictEqual(normaliseSignature('\n\n  Mark\r\nFounder\u0007\n\n\n\nAcme  \n\n'), '  Mark\nFounder\n\nAcme');
    assert.ok(normaliseSignature(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')).split('\n').length <= 10);
    assert.strictEqual(normaliseSignature(42), '');
    assert.strictEqual(signatureFromContext({ outreachSignature: '  ' }), '');
});

check('appended once, below the message', () => {
    assert.strictEqual(appendSignature('Hi Jo,\n\nWorth a call?\n', 'Mark\nAcme'), 'Hi Jo,\n\nWorth a call?\n\nMark\nAcme');
    assert.strictEqual(appendSignature('Worth a call?\n\nMark\nAcme', 'Mark\nAcme'), 'Worth a call?\n\nMark\nAcme', 'already there → not twice');
    assert.strictEqual(appendSignature('Worth a call?', ''), 'Worth a call?');
});

check('with a signature, the drafts are told NOT to sign off', () => {
    const on = senderIdentityBlock({ businessName: 'Acme', signature: 'Mark\nAcme' });
    assert.match(on, /do NOT add a sign-off/);
    assert.ok(!/sign off as Acme/.test(on));
    const off = senderIdentityBlock({ businessName: 'Acme' });
    assert.match(off, /sign off as Acme and no one else/, 'no signature → unchanged behaviour');
});

check('every outreach send site adds it, before the compliance footer', () => {
    const lg = read('netlify/functions/lead-generation.ts');
    assert.match(lg, /appendOutreachFooter\(appendSignature\(bodyText, signatureFromContext\(assistant\.onboardingContext\)\), footer\)/);
    const seq = read('netlify/functions/process-sequence-sends.ts');
    assert.match(seq, /appendOutreachFooter\(appendSignature\(draft\.body, sender\.signature \|\| ''\), footer\)/);
    assert.match(seq, /loadSenderIdentity\(db, row\.organisation_id, row\.ai_assistant_id\)/, 'follow-ups know the signature too');
    const th = read('netlify/functions/lead-threads.ts');
    assert.match(th, /body: appendSignature\(replyBody, signatureFromContext\(assistant\.onboardingContext\)\)/);
});

check('the drafting prompts get the sending assistant, so they know a signature is set', () => {
    assert.match(read('netlify/functions/lead-generation.ts'), /loadSenderIdentity\(db, orgId, assistant\.id\)/);
    assert.match(read('netlify/functions/process-discovery-jobs.ts'), /loadSenderIdentity\(db, job\.organisation_id, campaign\.aiAssistantId\)/);
});

check('the setting exists, says it is plain text, and the review card shows it', () => {
    const schema = read('src/public/assistant-onboarding-schemas.js');
    const lq = schema.slice(landmark(schema, 'lead_qualifier: ['), landmark(schema, 'accounts_receivable_clerk: ['));
    assert.match(lq, /key: 'outreachSignature'/);
    assert.match(lq, /Plain text, exactly as you type it/);
    assert.match(read('assistants.js'), /function _rqSignatureNote\(\)/);
    assert.match(read('netlify/functions/lead-generation.ts'), /signature: signatureFromContext\(assistant\.onboardingContext\) \|\| null/);
});

console.log(`\n${passed} checks passed.`);
