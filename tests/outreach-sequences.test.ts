// tests/outreach-sequences.test.ts
// Phase 2b of docs/lead-generator-revenue-engine-plan.md §5.2 — the outreach sequence engine.
//
// The engine sends email to strangers, unattended, from a tenant's own mailbox. Four properties
// are safety-critical and every one of them is asserted below:
//
//   1. A REPLY HALTS THE CADENCE. Phase 2a's reply detection is 2b's stop condition. A follow-up
//      landing after someone has already answered is the worst thing this system can do, so the
//      thread's state is re-read immediately before every send — including after the drafting call,
//      which takes seconds during which a reply can arrive.
//   2. NO DOUBLE SENDS. One enrolment per thread, a lease on claim, and a (thread, step)
//      idempotency check for the window where a send succeeds but its bookkeeping fails.
//   3. SUPPRESSION IS CHECKED, AND FAILS CLOSED. The list has been populated since the Integration
//      Scenario Library shipped and was never read until now.
//   4. THE VOCABULARIES MATCH THE DATABASE. A halt reason that violates its CHECK constraint does
//      not merely fail to save — it leaves an ACTIVE enrolment that keeps sending.
//
// No database: the cadence maths is pure, the write helpers go through a fake, and the worker's
// ordering guarantees are asserted against its source (the same technique tests/lead-threads.test.ts
// uses for the inbound branch).
// Run:  npx tsx tests/outreach-sequences.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SEQUENCE_STATES, SEQUENCE_HALT_REASONS, DEFAULT_SEQUENCE_STEPS,
    MAX_STEPS_PER_ENROLMENT, MAX_SENDS_PER_ORG_PER_DAY, MAX_ENROLMENTS_PER_ORG_PER_DAY,
    MAX_SEND_ATTEMPTS, WORKER_BUDGET_MS, SEQUENCE_TEMPLATE_PREFIX,
    sequenceTemplateVersion, isHaltReason, isSequenceState,
} from '../src/config/outreach-sequences';
import { EVENT_TYPES, TERMINAL_EVENT_TYPES } from '../src/config/revenue-events';
import { addDays, startOfUtcDay } from '../src/utils/outreach-sequences';
import { emailDomain, checkSuppression } from '../src/utils/suppression';
import { landmark } from './landmark';

let passed = 0;
const checks: Array<Promise<void>> = [];

function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
function checkAsync(name: string, fn: () => Promise<void>): void {
    checks.push(fn().then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; },
    ));
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqlText = readFileSync(join(root, 'db/outreach-sequences.sql'), 'utf8');
const schemaText = readFileSync(join(root, 'db/schema.ts'), 'utf8');
const workerText = readFileSync(join(root, 'netlify/functions/process-sequence-sends.ts'), 'utf8');
const helpersText = readFileSync(join(root, 'src/utils/outreach-sequences.ts'), 'utf8');
const inboundText = readFileSync(join(root, 'netlify/functions/inbound-email.ts'), 'utf8');
const leadGenText = readFileSync(join(root, 'netlify/functions/lead-generation.ts'), 'utf8');

// ── 1. Vocabulary sync: config ↔ SQL ↔ schema.ts ─────────────────────────────
// Three places declare these. If they drift, an enrolment that should halt cannot be written —
// and a halt that fails to save leaves an ACTIVE row that keeps sending.

check('every halt reason is in the SQL CHECK constraint', () => {
    const m = sqlText.match(/halt_reason\s+IS\s+NULL\s+OR\s+halt_reason\s+IN\s*\(([\s\S]*?)\)/i);
    assert.ok(m, 'could not locate the halt_reason CHECK in db/outreach-sequences.sql');
    for (const r of SEQUENCE_HALT_REASONS) {
        assert.ok(m![1].includes(`'${r}'`), `SQL halt_reason CHECK is missing '${r}'`);
    }
});

check('every enrolment state is in the SQL CHECK constraint', () => {
    const m = sqlText.match(/CHECK\s*\(state\s+IN\s*\(([^)]*)\)/i);
    assert.ok(m, 'could not locate the state CHECK in db/outreach-sequences.sql');
    for (const s of SEQUENCE_STATES) {
        assert.ok(m![1].includes(`'${s}'`), `SQL state CHECK is missing '${s}'`);
    }
});

check('db/schema.ts check() constraints match (drizzle-kit push must not revert the DDL)', () => {
    const block = schemaText.slice(landmark(schemaText, 'sequenceEnrolments = pgTable'));
    const stateCheck = block.slice(landmark(block, 'sequence_enrolments_state_check'));
    for (const s of SEQUENCE_STATES) {
        assert.ok(stateCheck.slice(0, 300).includes(`'${s}'`), `schema.ts state check is missing '${s}'`);
    }
    const haltCheck = block.slice(landmark(block, 'sequence_enrolments_halt_reason_check'));
    for (const r of SEQUENCE_HALT_REASONS) {
        assert.ok(haltCheck.slice(0, 600).includes(`'${r}'`), `schema.ts halt_reason check is missing '${r}'`);
    }
});

check('the anti-double-send unique index exists in BOTH schema.ts and the SQL', () => {
    assert.ok(sqlText.includes('sequence_enrolments_thread_uidx'), 'SQL is missing the unique index on lead_thread_id');
    assert.ok(/CREATE UNIQUE INDEX[^;]*sequence_enrolments_thread_uidx/i.test(sqlText), 'the thread index must be UNIQUE');
    assert.ok(schemaText.includes('sequence_enrolments_thread_uidx'), 'schema.ts is missing the unique index');
    assert.ok(
        /uniqueIndex\("sequence_enrolments_thread_uidx"\)/.test(schemaText),
        'schema.ts declares the thread index as non-unique — double enrolment becomes possible',
    );
});

check('the guards narrow correctly and reject junk', () => {
    assert.equal(isHaltReason('replied'), true);
    assert.equal(isHaltReason('because'), false);
    assert.equal(isHaltReason(null), false);
    assert.equal(isSequenceState('active'), true);
    assert.equal(isSequenceState('paused'), false);
});

// ── 2. Ledger vocabulary ─────────────────────────────────────────────────────

check('the three sequence events are registered and NON-terminal', () => {
    for (const t of ['sequence_enrolled', 'sequence_halted', 'sequence_completed']) {
        assert.ok((EVENT_TYPES as readonly string[]).includes(t), `${t} missing from EVENT_TYPES`);
        assert.ok(
            !(TERMINAL_EVENT_TYPES as readonly string[]).includes(t),
            `${t} must not be terminal — outcome is non-NULL on exactly the three deal_* events, and the partial index depends on it`,
        );
    }
});

check('a follow-up is counted as outreach_sent, not a separate event type', () => {
    // "How many emails did we send this lead?" must not require unioning two event types.
    assert.ok(workerText.includes("recordEvent(db, 'outreach_sent'"), 'the worker must emit outreach_sent for a follow-up');
    assert.ok(workerText.includes('sequenceStep: step.stepNumber'), 'the step number must ride in the payload');
    assert.ok(
        !(EVENT_TYPES as readonly string[]).includes('follow_up_sent'),
        'a separate follow_up_sent event would split the send count across two types',
    );
});

// ── 3. Cadence maths ─────────────────────────────────────────────────────────

check('addDays preserves the time of day and does NOT skip weekends', () => {
    // A Friday. chaseDate() in lead-generation.ts nudges off weekends because a human has to
    // action it; a sequence send needs nobody present, and shifting would pile a tenant's whole
    // cadence onto Monday morning.
    const friday = new Date('2026-08-07T14:30:00.000Z');
    assert.equal(friday.getUTCDay(), 5, 'fixture must be a Friday');
    const out = addDays(friday, 1);
    assert.equal(out.toISOString(), '2026-08-08T14:30:00.000Z');
    assert.equal(out.getUTCDay(), 6, 'a Saturday send must stay on Saturday');
});

check('addDays crosses month and year boundaries', () => {
    assert.equal(addDays(new Date('2026-12-30T09:00:00.000Z'), 3).toISOString(), '2027-01-02T09:00:00.000Z');
    assert.equal(addDays(new Date('2026-01-31T09:00:00.000Z'), 1).toISOString(), '2026-02-01T09:00:00.000Z');
});

check('startOfUtcDay is UTC midnight, not local midnight', () => {
    const d = startOfUtcDay(new Date('2026-08-02T23:45:00.000Z'));
    assert.equal(d.toISOString(), '2026-08-02T00:00:00.000Z');
});

check('the default cadence lands on 3 / 10 / 17 days after the opener', () => {
    let cumulative = 0;
    const schedule = DEFAULT_SEQUENCE_STEPS.map((s) => (cumulative += s.delayDays));
    assert.deepEqual(schedule, [3, 10, 17], 'delayDays counts from the PREVIOUS send, not from enrolment');
});

check('the default cadence is well-formed and de-escalating', () => {
    const numbers = DEFAULT_SEQUENCE_STEPS.map((s) => s.stepNumber);
    assert.deepEqual(numbers, [1, 2, 3], 'step numbers must be 1-based and contiguous');
    for (const s of DEFAULT_SEQUENCE_STEPS) {
        assert.ok(s.delayDays >= 0, 'a negative delay would make a step immediately due forever');
        assert.ok(s.bodyPrompt.trim().length > 0, 'body_prompt is NOT NULL');
    }
    const last = DEFAULT_SEQUENCE_STEPS[DEFAULT_SEQUENCE_STEPS.length - 1];
    assert.ok(
        /last email|not follow up again/i.test(last.bodyPrompt),
        'the cadence must end on a break-up note — a sequence with no exit reads as harassment',
    );
});

check('the hard step ceiling actually bounds the shipped cadence', () => {
    assert.ok(
        MAX_STEPS_PER_ENROLMENT >= DEFAULT_SEQUENCE_STEPS.length,
        'the ceiling must not silently truncate the default cadence',
    );
    assert.ok(MAX_STEPS_PER_ENROLMENT <= 10, 'a ceiling this high is not a ceiling');
    assert.ok(MAX_SEND_ATTEMPTS >= 1 && MAX_SEND_ATTEMPTS <= 5);
    assert.ok(MAX_SENDS_PER_ORG_PER_DAY > 0 && MAX_ENROLMENTS_PER_ORG_PER_DAY > 0);
    assert.ok(WORKER_BUDGET_MS < 26_000, 'the budget must leave headroom under Netlify\'s ~26s ceiling');
});

check('the template version is stable and matches the LIKE the daily cap counts with', () => {
    assert.equal(sequenceTemplateVersion(7, 2), 'seq:7:2');
    assert.equal(SEQUENCE_TEMPLATE_PREFIX, 'seq');
    // sequenceSendsToday counts outbound messages by this prefix. If the two drift, the per-org
    // daily ceiling silently stops counting and the cap disappears.
    assert.ok(
        helpersText.includes("LIKE 'seq:%'"),
        'sequenceSendsToday must match the prefix sequenceTemplateVersion emits',
    );
});

// ── 4. The reply halt — the invariant the whole phase rests on ───────────────

check('the worker re-reads thread state and refuses anything that is not open', () => {
    assert.ok(workerText.includes('threadState(db, row.lead_thread_id)'), 'the worker must re-read the thread state');
    assert.ok(
        workerText.includes("tState !== 'open'"),
        'the gate must be "is it still open?", not "is it replied?" — closed and missing threads must not send either',
    );
});

check('thread state is re-checked AFTER drafting, not only before', () => {
    // Drafting is an LLM round trip measured in seconds. A reply arriving in that window would
    // otherwise be missed and the follow-up would go out anyway.
    const draftAt = workerText.indexOf('draft = await draftFollowUp');
    const sendAt = workerText.indexOf('sendGmailMessage(db, row.organisation_id, outgoing)');
    const recheckAt = workerText.indexOf("await threadState(db, row.lead_thread_id) !== 'open'");
    assert.ok(draftAt > 0 && sendAt > 0, 'fixture: could not locate the draft and send calls');
    assert.ok(recheckAt > 0, 'there is no post-draft re-check of the thread state');
    assert.ok(recheckAt > draftAt, 'the re-check must come AFTER the drafting call');
    assert.ok(recheckAt < sendAt, 'the re-check must come BEFORE the send');
});

check('inbound replies halt running enrolments at the same moment the thread flips', () => {
    assert.ok(
        inboundText.includes('haltEnrolmentsForThread(db, thread.id)'),
        'the inbound reply branch must close any running cadence',
    );
    const recordAt = inboundText.indexOf('recordInboundMessage(db, thread.id');
    const haltAt = landmark(inboundText, 'haltEnrolmentsForThread(db, thread.id)');
    assert.ok(recordAt > 0 && haltAt > recordAt, 'the halt must follow the state flip, not precede it');
});

check('haltEnrolmentsForThread only touches ACTIVE enrolments', () => {
    const fn = helpersText.slice(landmark(helpersText, 'export async function haltEnrolmentsForThread'));
    assert.ok(
        fn.includes("eq(sequenceEnrolments.state, 'active')"),
        're-halting a completed enrolment would emit a duplicate ledger event on every reply',
    );
});

// ── 5. No double sends ───────────────────────────────────────────────────────

check('claiming leases the row so overlapping invocations cannot both send it', () => {
    assert.ok(workerText.includes('FOR UPDATE SKIP LOCKED'), 'the claim must skip rows another worker holds');
    assert.ok(
        /SET next_send_at = now\(\) \+ interval '\$\{LEASE_MINUTES\} minutes'/.test(workerText),
        'the claim must push next_send_at forward — statement-level locks do not survive the invocation',
    );
});

check('a (thread, step) idempotency check guards the succeeded-send-failed-bookkeeping window', () => {
    assert.ok(workerText.includes('alreadySent(db, row.lead_thread_id, templateVersion)'), 'missing idempotency check');
    const idemAt = workerText.indexOf('if (await alreadySent(');
    const sendAt = landmark(workerText, 'sendGmailMessage(db, row.organisation_id, outgoing)');
    assert.ok(idemAt > 0 && idemAt < sendAt, 'the idempotency check must precede the send');
});

check('enrolment relies on the unique index rather than a read-then-write race', () => {
    const fn = helpersText.slice(landmark(helpersText, 'export async function enrolInSequence'));
    assert.ok(
        fn.includes('onConflictDoNothing({ target: sequenceEnrolments.leadThreadId })'),
        'a SELECT-then-INSERT would let two concurrent approvals both enrol the same thread',
    );
});

check('enrolment happens on a confirmed send, never on a UI action', () => {
    const sendAt = leadGenText.indexOf('if (provider === \'microsoft\') await sendOutlookMessage');
    const enrolAt = landmark(leadGenText, 'await enrolInSequence(db, {');
    assert.ok(sendAt > 0 && enrolAt > sendAt, 'enrolInSequence must be called only after the email actually went out');
});

// ── 6. Termination leaves nothing sendable ───────────────────────────────────

check('every terminal transition clears next_send_at', () => {
    // The worker claims on (state, next_send_at). A terminal row that keeps a live timestamp is a
    // row that can still be claimed and sent.
    const halt = helpersText.slice(landmark(helpersText, 'export async function haltEnrolment'));
    assert.ok(halt.includes('nextSendAt: null'), 'haltEnrolment must clear next_send_at');
    const advance = helpersText.slice(landmark(helpersText, 'export async function advanceEnrolment'));
    const completion = advance.slice(landmark(advance, "state: 'completed'"), landmark(advance, "state: 'completed'") + 200);
    assert.ok(completion.includes('nextSendAt: null'), 'completing a cadence must clear next_send_at');
});

check('an unknown halt reason degrades to manual instead of failing the write', () => {
    // A rejected INSERT would leave the enrolment ACTIVE — the failure mode is "keeps sending",
    // so the vocabulary violation must never be allowed to abort the halt.
    const fn = helpersText.slice(landmark(helpersText, 'export async function haltEnrolment'));
    assert.ok(fn.includes('reason = \'manual\''), 'an out-of-vocabulary reason must fall back, not throw');
});

check('the daily-cap read fails CLOSED', () => {
    const fn = helpersText.slice(landmark(helpersText, 'export async function sequenceSendsToday'));
    assert.ok(
        fn.includes('Number.MAX_SAFE_INTEGER'),
        'a failed count must not read as zero — that would silently remove the daily ceiling',
    );
});

// ── 7. Suppression ───────────────────────────────────────────────────────────

check('emailDomain normalises the way suppression-sync writes domains', () => {
    assert.equal(emailDomain('Someone@WWW.Acme.co.uk'), 'acme.co.uk');
    assert.equal(emailDomain('a.b+tag@sub.acme.io'), 'sub.acme.io');
    assert.equal(emailDomain('  person@acme.com  '), 'acme.com');
    assert.equal(emailDomain('not-an-address'), null, 'no @ means nothing to check');
    assert.equal(emailDomain('person@localhost'), null, 'a hostname with no dot is not a domain');
    assert.equal(emailDomain(null), null);
    assert.equal(emailDomain(''), null);
});

/** Minimal chainable drizzle stand-in for the single-select shape checkSuppression uses. */
function fakeSelectDb(behaviour: () => unknown[]) {
    const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(behaviour()),
    };
    return { select: () => chain } as never;
}

checkAsync('a suppressed domain is reported with its reason', async () => {
    const db = fakeSelectDb(() => [{ reason: 'existing_customer' }]);
    const v = await checkSuppression(db, 1, 'buyer@acme.com');
    assert.equal(v.suppressed, true);
    assert.equal(v.reason, 'existing_customer');
});

checkAsync('an unlisted domain is not suppressed', async () => {
    const db = fakeSelectDb(() => []);
    const v = await checkSuppression(db, 1, 'buyer@acme.com');
    assert.equal(v.suppressed, false);
});

checkAsync('a lookup FAILURE is treated as suppressed (fail closed)', async () => {
    // Skipping a send costs one delayed email. Sending to a suppressed domain emails a tenant's
    // own customer as a cold prospect. Those are not symmetric.
    const db = fakeSelectDb(() => { throw Object.assign(new Error('connection lost'), { code: '08006' }); });
    const v = await checkSuppression(db, 1, 'buyer@acme.com');
    assert.equal(v.suppressed, true, 'an unknown verdict must block the send');
    assert.equal(v.unknown, true, 'the caller must be able to tell a real hit from a fail-closed guess');
});

checkAsync('a MISSING suppression_list table is treated as empty, not as blocking', async () => {
    // On an environment where the table was never created there is no list to violate, and failing
    // closed would block every send in the product rather than protecting anyone.
    const db = fakeSelectDb(() => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); });
    const v = await checkSuppression(db, 1, 'buyer@acme.com');
    assert.equal(v.suppressed, false);
});

checkAsync('an address with no parseable domain is not blocked', async () => {
    let queried = false;
    const db = fakeSelectDb(() => { queried = true; return []; });
    const v = await checkSuppression(db, 1, 'garbage');
    assert.equal(v.suppressed, false);
    assert.equal(queried, false, 'there is nothing to look up');
});

check('the worker checks suppression per send, not once at enrolment', () => {
    assert.ok(
        workerText.includes('checkSuppression(db, row.organisation_id, recipient)'),
        'the worker must check suppression itself',
    );
    const fn = helpersText.slice(landmark(helpersText, 'export async function enrolInSequence'));
    assert.ok(
        !fn.includes('checkSuppression'),
        'checking only at enrolment would miss a domain added days into the cadence',
    );
});

check('a fail-closed suppression verdict defers the send instead of halting the cadence', () => {
    // A transient lookup failure is not evidence that the prospect should never be contacted.
    assert.ok(
        /if \(suppression\.unknown\) return 'skipped'/.test(workerText),
        'an unknown verdict must retry next tick, not permanently halt the enrolment',
    );
});

check('the opening email now checks suppression too', () => {
    // suppression_list was written from tenants' CRMs and never read — this path could cold-email
    // an org's own existing customers.
    assert.ok(leadGenText.includes('await checkSuppression(db, orgId, recipient)'), 'send_outreach must check suppression');
    const suppAt = leadGenText.indexOf('await checkSuppression(db, orgId, recipient)');
    const sendAt = landmark(leadGenText, 'if (provider === \'microsoft\') await sendOutlookMessage');
    assert.ok(suppAt > 0 && suppAt < sendAt, 'the check must precede the send');
});

// ── 8. Migration hygiene ─────────────────────────────────────────────────────

check('the migration is idempotent throughout', () => {
    const creates = sqlText.match(/CREATE TABLE(?! IF NOT EXISTS)/gi);
    assert.equal(creates, null, 'every CREATE TABLE must be IF NOT EXISTS — this file is applied by hand');
    const indexes = sqlText.match(/CREATE (?:UNIQUE )?INDEX(?! IF NOT EXISTS)/gi);
    assert.equal(indexes, null, 'every CREATE INDEX must be IF NOT EXISTS');
    assert.ok(sqlText.includes('IF NOT EXISTS (SELECT 1 FROM pg_constraint'), 'constraints must be guarded');
});

check('the worker degrades quietly when the migration has not been applied', () => {
    assert.ok(workerText.includes("code === '42P01'"), 'a missing table must be handled, not thrown');
    assert.ok(
        workerText.includes('apply db/outreach-sequences.sql'),
        'the log line must name the migration — a silent no-op looks exactly like "nothing due"',
    );
});

// No top-level await: tsx transforms these files to CJS, where it is a syntax error.
void Promise.all(checks).then(() => {
    console.log(`\n${passed} checks passed`);
});
