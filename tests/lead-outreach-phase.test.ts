// tests/lead-outreach-phase.test.ts
// Which step of the outreach journey a lead is at — ONE function decides it, for the staged
// Outreach tab, its counts and lead-threads.ts `board`. docs/lead-outreach-restructure-plan.md.
//
// Three things are pinned:
//   1. the precedence, case by case — every edge the plan names has one answer;
//   2. the BROWSER copy (stringified into platform-constants.js) gives the same answers, and runs
//      at all — tsx's keepNames wraps nested functions in `__name(...)`, which the browser lacks;
//   3. `board` really is built on this function, scoped to the tenant AND the assistant, and keeps
//      leads that have no thread.
//
// Run:  npx tsx tests/lead-outreach-phase.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { landmark } from './landmark';
import {
    LEAD_OUTREACH_PHASES, LEAD_OUTREACH_PHASE_LABELS, LEAD_OUTREACH_GROUPS, LEAD_OUTREACH_GROUP_LABELS,
    leadOutreachPhase, type LeadOutreachPhaseInput,
} from '../src/config/lead-outreach-phase';
import { SEQUENCE_HALT_REASONS } from '../src/config/outreach-sequences';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const SENT = { outreachSentAt: '2026-10-01T09:00:00.000Z', outreachSentVia: 'google' };

// [description, input, expected phase, expected group, expected needsAttention]
const CASES: Array<[string, LeadOutreachPhaseInput, string, string, boolean]> = [
    ['a pending lead is waiting for approval',
        { approvalStatus: 'pending_approval', data: {} }, 'to_approve', 'review', false],
    ['approved but not sent (no inbox) is the user\'s to send',
        { approvalStatus: 'approved', data: { outreachDraftedAt: '2026-10-01' } }, 'to_approve', 'send_yourself', false],
    ['scheduled with no send stamp is still unsent',
        { approvalStatus: 'scheduled', data: {} }, 'to_approve', 'send_yourself', false],
    ['marked sent by hand, no thread → contacted outside the app',
        { approvalStatus: 'scheduled', data: { outreachSentAt: '2026-10-01', outreachSentVia: 'manual' } }, 'following_up', 'outside_app', false],
    ['sent from the app with the plan running',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'active' } }, 'following_up', 'chasing', false],
    ['sent from the app with follow-ups switched off',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: null }, 'following_up', 'no_follow_ups', false],
    ['a running plan that keeps failing to send needs attention',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'active', lastError: '401 from Gmail' } }, 'following_up', 'chasing', true],
    ['a plan stopped by a disconnected mailbox stays in front of the user, flagged',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'halted', haltReason: 'not_connected' } }, 'following_up', 'chasing', true],
    ['a plan stopped by repeated send failures is flagged too',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'halted', haltReason: 'send_failed' } }, 'following_up', 'chasing', true],
    ['the whole plan ran with no reply',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'completed', haltReason: 'max_steps' } }, 'finished', 'no_reply', false],
    ['the user stopped the plan',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'halted', haltReason: 'manual' } }, 'finished', 'no_reply', false],
    ['suppressed mid-plan counts as opted out',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'halted', haltReason: 'suppressed' } }, 'finished', 'opted_out', false],
    ['a stalled thread is over',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'stalled', enrolment: null }, 'finished', 'no_reply', false],
    ['they replied',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'replied', enrolment: { state: 'halted', haltReason: 'replied' } }, 'replied', 'replied', false],
    ['they signed up through the offer link — a yes, so a person looks',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'halted', haltReason: 'signed_up' } }, 'replied', 'replied', false],
    ['they replied asking to be left alone (thread closed)',
        { approvalStatus: 'scheduled', data: SENT, threadState: 'closed', enrolment: { state: 'halted', haltReason: 'replied' } }, 'finished', 'opted_out', false],
    ['a recorded win beats a live reply',
        { approvalStatus: 'scheduled', data: { ...SENT, dealOutcome: { outcome: 'won' } }, threadState: 'replied' }, 'finished', 'won', false],
    ['a win on the phone while chasers were running is finished, not following up',
        { approvalStatus: 'scheduled', data: { ...SENT, dealOutcome: { outcome: 'won' } }, threadState: 'open', enrolment: { state: 'active' } }, 'finished', 'won', false],
    ['a loss is finished',
        { approvalStatus: 'scheduled', data: { ...SENT, dealOutcome: { outcome: 'lost' } }, threadState: 'replied' }, 'finished', 'lost', false],
    ['an unknown outcome is still decided, never dropped',
        { approvalStatus: 'scheduled', data: { dealOutcome: { outcome: 'something_new' } } }, 'finished', 'disqualified', false],
    ['rejected wins over everything',
        { approvalStatus: 'rejected', data: { ...SENT, dealOutcome: { outcome: 'won' } }, threadState: 'replied' }, 'archived', 'archived', false],
    ['garbage data does not throw',
        { approvalStatus: 'approved', data: ['not', 'an', 'object'] }, 'to_approve', 'send_yourself', false],
    ['a thread whose lead record was deleted still places (no approval status)',
        { approvalStatus: null, data: null, threadState: 'open', enrolment: { state: 'active' } }, 'following_up', 'chasing', false],
];

type PhaseFn = (i: LeadOutreachPhaseInput) => { phase: string; group: string; needsAttention: boolean };

function runCases(fn: PhaseFn, where: string): void {
    for (const [name, input, phase, group, attention] of CASES) {
        const got = fn(input);
        assert.deepStrictEqual(
            { phase: got.phase, group: got.group, needsAttention: got.needsAttention },
            { phase, group, needsAttention: attention },
            `${where}: ${name}`,
        );
    }
}

// ── 1. the precedence ───────────────────────────────────────────────────────

check('every case in the plan places where the plan says', () => runCases(leadOutreachPhase, 'server'));

check('every phase and group it can return has a label', () => {
    for (const p of LEAD_OUTREACH_PHASES) assert.ok(LEAD_OUTREACH_PHASE_LABELS[p], `no label for phase ${p}`);
    for (const g of LEAD_OUTREACH_GROUPS) assert.ok(LEAD_OUTREACH_GROUP_LABELS[g], `no label for group ${g}`);
    for (const [, input] of CASES) {
        const r = leadOutreachPhase(input);
        assert.ok((LEAD_OUTREACH_PHASES as readonly string[]).includes(r.phase), `unknown phase ${r.phase}`);
        assert.ok((LEAD_OUTREACH_GROUPS as readonly string[]).includes(r.group), `unknown group ${r.group}`);
    }
});

check('every halt reason lands somewhere a sent lead can be seen', () => {
    // A halt reason added to the vocabulary must not drop a lead out of the board.
    for (const reason of SEQUENCE_HALT_REASONS) {
        const r = leadOutreachPhase({ approvalStatus: 'scheduled', data: SENT, threadState: 'open', enrolment: { state: 'halted', haltReason: reason } });
        assert.ok(['following_up', 'replied', 'finished'].includes(r.phase), `halt '${reason}' placed a sent lead in ${r.phase}`);
    }
});

// ── 2. the browser copy ─────────────────────────────────────────────────────

const CONSTANTS = read('src/generated/platform-constants.js');

check('the generated browser copy carries no keepNames helper', () => {
    // `__name` exists under tsx and not in the browser: one nested function in the source and the
    // stringified copy throws a ReferenceError on its first call.
    assert.ok(!CONSTANTS.includes('__name('), 'platform-constants.js references __name — a nested function leaked into a stringified helper');
});

check('the browser copy gives the same answer for every case', () => {
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(CONSTANTS, sandbox);
    const P = sandbox.window.LeadOutreachPhase as { of: PhaseFn; phases: string[]; groupLabels: Record<string, string> } | undefined;
    assert.ok(P && typeof P.of === 'function', 'window.LeadOutreachPhase.of is missing — run npm run gen:constants');
    runCases(P.of, 'browser');
    assert.deepStrictEqual([...P.phases], [...LEAD_OUTREACH_PHASES]);
    assert.deepStrictEqual({ ...P.groupLabels }, { ...LEAD_OUTREACH_GROUP_LABELS });
});

// ── 3. the board ────────────────────────────────────────────────────────────

const API = read('netlify/functions/lead-threads.ts');
const BOARD = API.slice(landmark(API, "if (action === 'board')"), landmark(API, '// ── calendar'));

check('board places every row through leadOutreachPhase', () => {
    const calls = BOARD.match(/leadOutreachPhase\(/g) || [];
    assert.strictEqual(calls.length, 2, `both row kinds (thread / record-only) must be placed by leadOutreachPhase (found ${calls.length})`);
    assert.ok(!/phase: '(to_approve|following_up|replied|finished|archived)'/.test(BOARD),
        'board must not assign a phase by hand');
});

check('board is scoped to the tenant AND the assistant, on both sources', () => {
    for (const scope of [
        'eq(leadThreads.organisationId, orgId)', 'eq(leadThreads.aiAssistantId, assistantId)',
        'eq(assistantRecords.organisationId, orgId)', 'eq(assistantRecords.aiAssistantId, assistantId)',
        "eq(assistantRecords.recordType, 'lead')",
    ]) assert.ok(BOARD.includes(scope), `board is missing ${scope}`);
});

check('board keeps leads that have no thread (marked sent by hand, or not sent yet)', () => {
    assert.ok(/inArray\(assistantRecords\.approvalStatus, \['approved', 'scheduled'\]\)/.test(BOARD),
        'board must read approved/scheduled lead records, not only threads');
    assert.ok(BOARD.includes('!seenRecords.has(r.id)'), 'record-only rows must exclude leads that already have a thread');
    assert.ok(BOARD.includes('threadState: null'), 'a record-only row is placed with no thread');
});

check('board says when it stopped short', () => {
    assert.ok(BOARD.includes('BOARD_MAX + 1') && /truncated:/.test(BOARD),
        'board must read one past its cap and report truncated — the tab filters client-side');
});

check('board never returns the enrolment error text', () => {
    // lastError is read to flag "needs attention"; the raw provider message stays server-side.
    assert.ok(!/lastError:\s*e\./.test(BOARD) && !/\blastError\b/.test(BOARD.replace(/\/\/.*$/gm, '')),
        'board must not put lastError on a row');
});

console.log(`\n${passed} checks passed.`);
