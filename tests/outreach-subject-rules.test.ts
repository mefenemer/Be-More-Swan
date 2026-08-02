// tests/outreach-subject-rules.test.ts
// Every AI-generated outreach subject line must carry OUTREACH_SUBJECT_RULES.
//
// This exists because a real staging send produced "Clarification Needed: Your Be More Swan
// Account" to a stranger — an invented account relationship plus manufactured urgency, i.e. the
// exact shape of a phishing subject. The cause was not one bad prompt: FOUR separate seams generate
// a subject, only one carried any subject guidance at all, and a bad opener propagates because the
// follow-up inherits it as "Re: <opener>". A rule added to one seam and not the others is the
// failure mode, so this asserts the shared constant reaches all four.
//
// Static source analysis on purpose — an LLM round trip would make this slow and flaky, and the
// thing that actually regresses is a seam quietly dropping the injection.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTREACH_SUBJECT_RULES } from '../src/constants/outreach-subject';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nOutreach subject-line rules\n');

// The four seams that ask a model for a subject line, and the import specifier each must use.
const SEAMS: Array<{ file: string; specifier: string; label: string }> = [
    { file: 'netlify/functions/lead-generation.ts', specifier: '../../src/constants/outreach-subject', label: 'manual lead scoring + send-time generation' },
    { file: 'src/lib/discovery-scoring.ts', specifier: '../constants/outreach-subject', label: 'discovery scoring' },
    { file: 'netlify/functions/process-sequence-sends.ts', specifier: '../../src/constants/outreach-subject', label: 'sequence follow-up drafting' },
];

for (const seam of SEAMS) {
    check(`${seam.label} imports the shared rules`, () => {
        const src = read(seam.file);
        assert.match(
            src,
            new RegExp(`import\\s*\\{[^}]*OUTREACH_SUBJECT_RULES[^}]*\\}\\s*from\\s*'${seam.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
            `${seam.file} must import OUTREACH_SUBJECT_RULES from '${seam.specifier}'`,
        );
    });
}

check('lead-generation.ts injects the rules into BOTH of its prompts', () => {
    // One seam scores a manual lead and emits an outreachDraft; the other generates at send time
    // when no draft was stored. The real send used the second — usedStoredDraft: false.
    const uses = read('netlify/functions/lead-generation.ts').match(/\$\{OUTREACH_SUBJECT_RULES\}/g) ?? [];
    assert.strictEqual(uses.length, 2, `expected 2 interpolations, found ${uses.length}`);
});

for (const seam of SEAMS.filter((s) => s.file !== 'netlify/functions/lead-generation.ts')) {
    check(`${seam.label} interpolates the rules into its prompt`, () => {
        assert.ok(read(seam.file).includes('${OUTREACH_SUBJECT_RULES}'), `${seam.file} imports the rules but never interpolates them`);
    });
}

check('the rules ban inventing an account or prior relationship', () => {
    const r = OUTREACH_SUBJECT_RULES.toLowerCase();
    for (const phrase of ['account', 'invoice', 'support ticket', 'stranger']) {
        assert.ok(r.includes(phrase), `expected the rules to address "${phrase}"`);
    }
});

check('the rules ban the specific phrases that shipped', () => {
    // "Clarification Needed" is the one that actually went out; the rest are the same pattern.
    for (const phrase of ['Clarification Needed', 'Action Required', 'Urgent', 'Final Notice', 'Your Account']) {
        assert.ok(OUTREACH_SUBJECT_RULES.includes(phrase), `expected "${phrase}" to be named as banned`);
    }
});

check('the rules ban a faked Re:/Fwd: on a first email', () => {
    assert.match(OUTREACH_SUBJECT_RULES, /"Re:"/, 'expected an explicit rule about the "Re:" prefix');
    assert.match(OUTREACH_SUBJECT_RULES, /Fwd:/, 'expected an explicit rule about the "Fwd:" prefix');
});

check('the follow-up seam still allows Re: on a genuine thread', () => {
    // The shared rules forbid a FAKE Re:. A follow-up in a thread we really sent is not fake, and
    // over-correcting here would break client-side threading for the whole sequence.
    const src = read('netlify/functions/process-sequence-sends.ts');
    assert.match(src, /thread genuinely exists/i, 'the follow-up prompt must state that "Re:" is honest here');
});

check('the follow-up seam refuses to inherit a rule-breaking subject', () => {
    // Otherwise one bad opener contaminates every step: subject = `Re: ${originalSubject}`.
    assert.match(read('netlify/functions/process-sequence-sends.ts'), /do not inherit a bad subject/i);
});

// ── The decline channel ────────────────────────────────────────────────────────────────────────
// Tightening the rules made a new failure reachable: told to write cold outreach to a lead whose
// own scoring says "internal test account — do not contact", the model correctly concluded it
// should not write one, and put that conclusion in the subject and body ("Not sending this email").
// Both would have been emailed verbatim. A refusal needs somewhere to go that is not the email.

check('both generators offer an explicit decline channel', () => {
    for (const f of ['netlify/functions/lead-generation.ts', 'netlify/functions/process-sequence-sends.ts']) {
        assert.match(read(f), /\{ "decline": "<one short line saying why>" \}/, `${f} must give the model a decline channel`);
    }
});

check('a declined send returns sent:false, not a sent email', () => {
    const src = read('netlify/functions/lead-generation.ts');
    assert.match(src, /reason: 'generator_declined'/, 'the send path must surface the refusal as a reason');
    // The guard must require an ABSENT body: a response carrying both a decline and a real draft
    // should still send, otherwise a stray field silently suppresses legitimate outreach.
    assert.match(src, /if \(declined && !str\(gen\.body, 4000\)\)/, 'the decline guard must also require an empty body');
});

check('a declined follow-up routes into the existing failure path', () => {
    const src = read('netlify/functions/process-sequence-sends.ts');
    const i = src.indexOf('parsed?.decline');
    assert.ok(i > 0, 'draftFollowUp must handle a decline');
    // Returning null is what reaches handleSendFailure — the same path as an unusable draft.
    assert.match(src.slice(i, i + 400), /return null;/, 'a decline must return null so the step does not send');
});

check('the UI explains a declined send instead of a bare "Lead approved"', () => {
    assert.match(read('assistants.js'), /generator_declined/, 'assistants.js must handle the generator_declined reason');
});

console.log(`\n${passed} checks passed\n`);
