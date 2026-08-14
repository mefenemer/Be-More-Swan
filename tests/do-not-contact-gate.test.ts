// tests/do-not-contact-gate.test.ts
// A lead the qualification pass says must not be emailed must not be emailed.
//
// This is a real incident, not a hypothetical: assistant_records #173 on staging carried
// suggestedNextStep = "Do not contact. Remove from qualified leads pipeline. Flag as internal
// testing account." — and was emailed anyway, then enrolled in a 3-step cadence. Nothing read that
// field. The drafter, handed a record describing an internal account and told to write cold
// outreach, invented an account pretext to reconcile the contradiction.
//
// Drives the REAL evaluateDoNotContact() so the rule is exercised rather than restated, and asserts
// statically that BOTH send paths consult it — the gate is worthless if only the first one does.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDoNotContact } from '../src/config/do-not-contact';
import { SEQUENCE_HALT_REASONS } from '../src/config/outreach-sequences';
import { EVENT_TYPES } from '../src/config/revenue-events';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nDo-not-contact gate\n');

// ── The rule ───────────────────────────────────────────────────────────────────────────────────

check('the structured flag blocks', () => {
    const v = evaluateDoNotContact({ doNotContact: true, doNotContactReason: 'Internal test account.' });
    assert.strictEqual(v.blocked, true);
    assert.strictEqual(v.source, 'flag');
    assert.strictEqual(v.reason, 'Internal test account.');
});

check('an explicit false is honoured over stale prose', () => {
    // A re-score that clears the flag must win. Otherwise a lead can never be un-blocked, because
    // the old suggestedNextStep text lives on in the same blob.
    const v = evaluateDoNotContact({ doNotContact: false, suggestedNextStep: 'Do not contact.' });
    assert.strictEqual(v.blocked, false, 'an explicit doNotContact:false must beat the legacy text');
});

check('the flag falls back to suggestedNextStep when no reason is given', () => {
    const v = evaluateDoNotContact({ doNotContact: true, suggestedNextStep: 'Do not contact. Competitor.' });
    assert.strictEqual(v.blocked, true);
    assert.match(v.reason ?? '', /Competitor/);
});

check('a flagged lead with neither reason still gets a usable message', () => {
    const v = evaluateDoNotContact({ doNotContact: true });
    assert.strictEqual(v.blocked, true);
    assert.ok((v.reason ?? '').length > 0, 'the toast would otherwise read "...flagged do-not-contact: "');
});

// ── The legacy backstop ────────────────────────────────────────────────────────────────────────
// Records scored before the flag existed are still live and still sendable. #173 is one of them,
// and it is currently mid-cadence — so this path, not the flag, is what actually stops it.

check('the exact text from record #173 blocks', () => {
    const v = evaluateDoNotContact({
        suggestedNextStep: 'Do not contact. Remove from qualified leads pipeline. Flag as internal testing account.',
    });
    assert.strictEqual(v.blocked, true, 'the record that caused this work must be blocked');
    assert.strictEqual(v.source, 'text');
});

check('common phrasings of the same instruction block', () => {
    for (const s of [
        "Don't contact this lead.",
        'Do not reach out — existing customer.',
        'Never email this contact.',
        'Do not pursue: competitor.',
        "Don't reach out to them again.",
    ]) {
        assert.strictEqual(evaluateDoNotContact({ suggestedNextStep: s }).blocked, true, `should block: ${s}`);
    }
});

check('ordinary next steps are NOT blocked', () => {
    // Over-matching silently kills legitimate outreach, which is the worse failure — it looks like
    // nothing happened. These all mention contact and must pass.
    for (const s of [
        'Contact the practice manager to arrange a walkthrough.',
        'Email an introduction and offer a 15-minute call.',
        'Reach out to the head of operations this week.',
        'Do not delay — this lead is time-sensitive, email today.',
        'Contact via LinkedIn if the email bounces.',
        '',
    ]) {
        assert.strictEqual(evaluateDoNotContact({ suggestedNextStep: s }).blocked, false, `should NOT block: ${s}`);
    }
});

check('junk input is not blocked', () => {
    for (const v of [null, undefined, 'a string', 42, []]) {
        assert.strictEqual(evaluateDoNotContact(v).blocked, false, `should not block: ${JSON.stringify(v)}`);
    }
});

// ── Both send paths enforce it ─────────────────────────────────────────────────────────────────

check('send_outreach consults the gate', () => {
    const src = read('netlify/functions/lead-generation.ts');
    assert.match(src, /evaluateDoNotContact\(data\)/, 'the send path must evaluate the rule');
    assert.match(src, /reason: 'do_not_contact'/, 'it must return a distinguishable reason');
});

check('the gate runs before generation and before the thread is opened', () => {
    // Order matters: a block that fires after openLeadThread() leaves a thread and a reply alias
    // for an email that was never sent, and after generation it has already cost a model call.
    const src = read('netlify/functions/lead-generation.ts');
    const gate = src.indexOf('evaluateDoNotContact(data)');
    assert.ok(gate > 0, 'gate not found');
    for (const later of ['openLeadThread(', 'send_outreach_gen', 'checkSuppression(']) {
        assert.ok(landmark(src, later) > gate, `the gate must run before ${later}`);
    }
});

check('the sequence worker consults the gate too', () => {
    // Without this, an enrolment created before the gate existed keeps sending on schedule — the
    // send-path gate never runs again for a cadence already in flight.
    const src = read('netlify/functions/process-sequence-sends.ts');
    assert.match(src, /evaluateDoNotContact\(rec\.data\)/, 'the worker must evaluate the rule per step');
    assert.match(src, /haltEnrolment\(db, ref, 'do_not_contact'/, 'a blocked lead must halt the cadence');
});

check('the worker re-reads the record rather than trusting enrolment time', () => {
    const src = read('netlify/functions/process-sequence-sends.ts');
    assert.match(src, /data: assistantRecords\.data/, 'the liveness query must also select data');
});

// ── The halt reason is a real value everywhere ─────────────────────────────────────────────────

check("'do_not_contact' is in the halt vocabulary", () => {
    assert.ok((SEQUENCE_HALT_REASONS as readonly string[]).includes('do_not_contact'));
});

check('the DB constraint allows it in BOTH the base schema and a migration', () => {
    // The base file creates the constraint under IF NOT EXISTS, so it only helps a fresh database.
    // Existing envs need the migration — without it the halt UPDATE raises a check violation and
    // the enrolment stays active, which is the exact failure the gate exists to prevent.
    assert.match(read('db/outreach-sequences.sql'), /'record_closed','do_not_contact','manual'/, 'base schema not widened');
    const mig = read('db/sequence-halt-do-not-contact.sql');
    assert.match(mig, /DROP CONSTRAINT sequence_enrolments_halt_reason_check/, 'migration must drop the old constraint');
    assert.match(mig, /do_not_contact/, 'migration must add the new value');
});

check('the UI explains a do-not-contact block', () => {
    assert.match(read('assistants.js'), /'do_not_contact'/, 'assistants.js must handle the reason');
});

// ── The override, for a mis-scored lead ────────────────────────────────────────────────────────
// Persisted on the record, not passed per-send: two paths enforce this gate, and a per-send bypass
// would send the opener, enrol a cadence, then halt it at step 2 when the worker re-checked.

const OVERRIDE = { at: '2026-08-02T12:00:00.000Z', by: '7', reason: 'Known prospect, shares our domain by coincidence.' };

check('a valid override releases the block', () => {
    const v = evaluateDoNotContact({ doNotContact: true, doNotContactReason: 'Internal account.', doNotContactOverride: OVERRIDE });
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.overridden, true, 'an override must be distinguishable from a gate that never fired');
    assert.strictEqual(v.override?.reason, OVERRIDE.reason);
    assert.strictEqual(v.reason, 'Internal account.', 'the original verdict must survive for logging');
});

check('an override releases the legacy text block too', () => {
    const v = evaluateDoNotContact({ suggestedNextStep: 'Do not contact. Internal testing account.', doNotContactOverride: OVERRIDE });
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.overridden, true);
    assert.strictEqual(v.source, 'text');
});

check('an override without a reason is ignored', () => {
    // The reason IS the authorisation. Accepting a blank one would let an empty object bypass.
    for (const bad of [{}, { at: OVERRIDE.at, by: '7' }, { at: OVERRIDE.at, by: '7', reason: '   ' }, { reason: 'x', by: '7' }, true, 'yes']) {
        const v = evaluateDoNotContact({ doNotContact: true, doNotContactOverride: bad });
        assert.strictEqual(v.blocked, true, `should stay blocked for override: ${JSON.stringify(bad)}`);
    }
});

check('an override on an unblocked lead is inert', () => {
    // It must not act as a standing pre-authorisation for a verdict a LATER re-score would make.
    const v = evaluateDoNotContact({ doNotContact: false, doNotContactOverride: OVERRIDE });
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.overridden, false, 'nothing was overridden — no block was raised');
});

check('the override action demands a substantial reason', () => {
    const src = read('netlify/functions/lead-generation.ts');
    assert.match(src, /action === 'override_do_not_contact'/, 'the override action must exist');
    assert.match(src, /reason\.length < 10/, 'a too-short reason must be rejected server-side');
});

check('the override action refuses a lead that is not blocked', () => {
    assert.match(
        read('netlify/functions/lead-generation.ts'),
        /if \(!current\.blocked && !current\.overridden\)/,
        'overriding an unflagged lead would create a standing pre-authorisation',
    );
});

check('an override is written to the ledger as its own event', () => {
    // Not a flavour of lead_approved: "how often is the gate bypassed?" must be a GROUP BY.
    assert.ok((EVENT_TYPES as readonly string[]).includes('do_not_contact_overridden'));
    assert.match(read('netlify/functions/lead-generation.ts'), /recordEvent\(db, 'do_not_contact_overridden'/);
});

check('both send paths log a bypass rather than proceeding silently', () => {
    for (const f of ['netlify/functions/lead-generation.ts', 'netlify/functions/process-sequence-sends.ts']) {
        assert.match(read(f), /dnc\.overridden/, `${f} must notice that it is proceeding past a raised gate`);
    }
});

check('the UI requires confirm AND a typed reason before overriding', () => {
    const src = read('assistants.js');
    assert.match(src, /action: 'override_do_not_contact'/, 'the UI must call the override action');
    assert.match(src, /why\.trim\(\)\.length >= 10/, 'the UI must not send without a usable reason');
});

console.log(`\n${passed} checks passed\n`);
