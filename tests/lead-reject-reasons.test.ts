// tests/lead-reject-reasons.test.ts
// Rejecting a discovered lead records WHY — the targeting half of the feedback loop.
//
// The invariants mirror tests/template-feedback.test.ts, because the failure modes are the same:
//
//   1. LEAD_REJECT_REASONS is declared in THREE places (src/config/lead-reject-reasons.ts,
//      db/schema.ts check(), db/lead-reject-feedback.sql). recordLeadRejection() swallows its
//      errors by contract, so a value added in one place only becomes a CHECK violation inside a
//      module that logs and returns null. Nothing surfaces; evidence just silently stops.
//
//   2. One writer, so the closed vocabulary has one place to be enforced.
//
//   3. ⚠️ The strip must not claim the rejection teaches anything. No code reads these rows to
//      change targeting yet, and UI copy that says otherwise is a promise the system does not
//      keep — the same class of bug as a chat reply claiming it saved a draft it never wrote.
//
// No database: pure-function and cross-file-consistency checks.
// Run:  npx tsx tests/lead-reject-reasons.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LEAD_REJECT_REASONS, LEAD_REJECT_REASON_LABELS, LEAD_REJECT_REASONS_FOR_TARGETING,
    DOMAIN_EXCLUSION_REASONS, isLeadRejectReason,
} from '../src/config/lead-reject-reasons';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Pull the quoted values out of a CHECK-constraint style `IN (...)` list. */
function inListValues(text: string, after: string): string[] {
    const start = text.indexOf(after);
    assert.ok(start !== -1, `could not find "${after}"`);
    const open = text.indexOf('IN (', start);
    const close = text.indexOf(')', open);
    return [...text.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

// ── 1. Vocabulary integrity, across all three declarations ───────────────────

check('LEAD_REJECT_REASON_LABELS covers exactly the vocabulary', () => {
    assert.deepEqual(Object.keys(LEAD_REJECT_REASON_LABELS).sort(), [...LEAD_REJECT_REASONS].sort());
    for (const [k, v] of Object.entries(LEAD_REJECT_REASON_LABELS)) {
        assert.ok(v && v.trim(), `${k} has an empty label`);
    }
});

check('the SQL CHECK constraint lists exactly LEAD_REJECT_REASONS', () => {
    const sql = read('db/lead-reject-feedback.sql');
    const values = inListValues(sql, 'ADD CONSTRAINT lead_reject_feedback_reason_check');
    assert.deepEqual(
        values.sort(), [...LEAD_REJECT_REASONS].sort(),
        'db/lead-reject-feedback.sql has drifted from src/config/lead-reject-reasons.ts',
    );
});

check('db/schema.ts check() lists exactly LEAD_REJECT_REASONS', () => {
    const values = inListValues(read('db/schema.ts'), 'lead_reject_feedback_reason_check');
    assert.deepEqual(
        values.sort(), [...LEAD_REJECT_REASONS].sort(),
        'db/schema.ts has drifted — a later drizzle-kit push would revert the real constraint',
    );
});

check('isLeadRejectReason accepts the vocabulary and nothing else', () => {
    for (const r of LEAD_REJECT_REASONS) assert.ok(isLeadRejectReason(r), `rejected ${r}`);
    for (const junk of ['', 'COMPETITOR', 'competitor ', null, undefined, 7, {}, ['competitor']]) {
        assert.ok(!isLeadRejectReason(junk), `accepted ${JSON.stringify(junk)}`);
    }
});

// ── 2. Which reasons mean what ───────────────────────────────────────────────

check('`other` is captured but never counted toward targeting', () => {
    assert.ok((LEAD_REJECT_REASONS as readonly string[]).includes('other'), 'the escape hatch must exist');
    assert.ok(
        !LEAD_REJECT_REASONS_FOR_TARGETING.includes('other' as never),
        '`other` is a bucket, not a signal',
    );
});

check('reasons that are not targeting faults stay out of the targeting set', () => {
    // Each is a real fact about the lead, but none is a fault in WHO the search looked for:
    // they belong to suppression, scoring and enrichment respectively. Clustering on them would
    // retarget a search to fix a problem living somewhere else entirely.
    for (const r of ['existing_customer', 'no_buying_signal', 'bad_contact'] as const) {
        assert.ok((LEAD_REJECT_REASONS as readonly string[]).includes(r), `${r} should still be offerable`);
        assert.ok(!LEAD_REJECT_REASONS_FOR_TARGETING.includes(r), `${r} must not drive retargeting`);
    }
});

check('only permanent disqualifiers offer a domain block', () => {
    for (const r of DOMAIN_EXCLUSION_REASONS) {
        assert.ok((LEAD_REJECT_REASONS as readonly string[]).includes(r), `${r} is not in the vocabulary`);
    }
    // "Too small" is a property of the company TODAY. Blocking that domain forever would quietly
    // delete a prospect who grows into the profile, and a one-click quick action is not a decision
    // the user is making knowingly.
    for (const r of ['too_small', 'too_large', 'no_buying_signal', 'wrong_industry'] as const) {
        assert.ok(!DOMAIN_EXCLUSION_REASONS.includes(r), `${r} must not offer a permanent domain block`);
    }
});

// ── 3. Single writer + the observer contract ─────────────────────────────────

check('lead_reject_feedback has exactly one writer', () => {
    for (const f of ['netlify/functions/lead-generation.ts', 'netlify/functions/assistant-records.ts']) {
        assert.ok(
            !/insert\s*\(\s*leadRejectFeedback/.test(read(f)),
            `${f} inserts into leadRejectFeedback directly — route through recordLeadRejection()`,
        );
    }
    const util = read('src/utils/lead-reject-feedback.ts');
    assert.equal(
        (util.match(/insert\(leadRejectFeedback\)/g) ?? []).length, 1,
        'src/utils/lead-reject-feedback.ts should contain the single insert',
    );
});

check('recordLeadRejection never throws', () => {
    const util = read('src/utils/lead-reject-feedback.ts');
    const fn = util.slice(util.indexOf('export async function recordLeadRejection'));
    assert.ok(/try\s*{/.test(fn) && /catch\s*\(/.test(fn), 'must swallow — the rejection already committed');
    assert.ok(/return EMPTY/.test(fn), 'failure must resolve, so a feedback error cannot fail a rejection');
});

check('the endpoint scopes the write to a LEAD owned by this tenant', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const action = src.slice(src.indexOf("if (action === 'record_reject_feedback')"));
    const guard = action.slice(0, action.indexOf('recordLeadRejection'));
    assert.ok(/organisationId, orgId/.test(guard), 'missing the tenant check');
    assert.ok(/recordType, 'lead'/.test(guard),
        'assistant_records is shared by six roles — a rejected invoice says nothing about targeting');
});

// ── 4. The strip promises only what the system does ──────────────────────────

check('the reject strip does not claim the rejection teaches the assistant', () => {
    const src = read('assistants.js');
    const start = src.indexOf('function _rqShowRejectReasonStrip');
    assert.ok(start !== -1, 'the strip is missing');
    const fn = src.slice(start, src.indexOf('function _rqOfferDomainExclusion'));
    // Only the rendered copy matters; the comments above the function explain exactly why.
    const copy = fn.replace(/\/\/.*$/gm, '');
    for (const claim of [/teach/i, /learn/i, /next time/i, /improve/i]) {
        assert.ok(!claim.test(copy),
            `the strip claims learning that no code performs yet (${claim}) — build the proposer first`);
    }
});

check('the strip appears after the reject, never as a gate in front of it', () => {
    const src = read('assistants.js');
    // The pending marker is set inside the reject branch and only rendered once the PATCH has
    // resolved and the queue re-rendered. If the strip were awaited before the PATCH, a reviewer
    // could not clear a lead without categorising it.
    assert.ok(/_rqPendingReject = \{/.test(src), 'the reject branch must queue the strip, not show it');
    const after = src.indexOf('_rqShowRejectReasonStrip();');
    const render = src.indexOf('await _detailRqRenderGroups(_detailRqCurrentStatus);');
    assert.ok(after > render && render !== -1, 'the strip must be shown after the queue re-renders');
});

check('a failed reject clears the pending strip', () => {
    const src = read('assistants.js');
    const catchBlock = src.slice(src.indexOf('buttons.forEach((b) => { b.disabled = false; });'));
    assert.ok(/_rqPendingReject = null/.test(catchBlock.slice(0, 800)),
        'left set, the strip would surface on whatever the user did NEXT');
});

console.log(`\n${passed} checks passed.`);
