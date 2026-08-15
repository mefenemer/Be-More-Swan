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
import { landmark } from './landmark';
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
    const open = landmark(text, 'IN (', start);
    const close = landmark(text, ')', open);
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
    const fn = util.slice(landmark(util, 'export async function recordLeadRejection'));
    assert.ok(/try\s*{/.test(fn) && /catch\s*\(/.test(fn), 'must swallow — the rejection already committed');
    assert.ok(/return EMPTY/.test(fn), 'failure must resolve, so a feedback error cannot fail a rejection');
});

check('the endpoint scopes the write to a LEAD owned by this tenant', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const action = src.slice(landmark(src, "if (action === 'record_reject_feedback')"));
    const guard = action.slice(0, landmark(action, 'recordLeadRejection'));
    assert.ok(/organisationId, orgId/.test(guard), 'missing the tenant check');
    assert.ok(/recordType, 'lead'/.test(guard),
        'assistant_records is shared by six roles — a rejected invoice says nothing about targeting');
});

// ── 4. The strip promises only what the system does ──────────────────────────

check('the reject strip does not claim the rejection teaches the assistant', () => {
    const src = read('assistants.js');
    const start = src.indexOf('function _rqShowRejectReasonStrip');
    assert.ok(start !== -1, 'the strip is missing');
    const fn = src.slice(start, landmark(src, 'function _rqOfferDomainExclusion'));
    // Only the rendered copy matters; the comments above the function explain exactly why.
    const copy = fn.replace(/\/\/.*$/gm, '');
    for (const claim of [/teach/i, /learn/i, /next time/i, /improve/i]) {
        assert.ok(!claim.test(copy),
            `the strip claims learning that no code performs yet (${claim}) — build the proposer first`);
    }
});

// The Leads tab now offers Reject too (assistant-data-hub.js rejectReasonStrip), because that is
// where a user actually reads a lead in full. It is a SECOND copy of the strip above — deliberately
// duplicated, since the Review Queue's version anchors to a card that doesn't exist on that screen
// — so the honesty rule has to be pinned in both places or it only holds in one.
// ⚠️ Retargeted 2026-08-15. The Leads tab's Reject button and its `rejectReasonStrip` are gone —
// Delete performs the rejection now, and asks for the reason in ITS confirmation. The honesty rule
// did not move with it by accident, so it is asserted against the strip that inherited the job.
check('the Leads-tab delete strip makes the same limited promise', () => {
    const src = read('src/components/assistant-data-hub.js');
    const start = src.indexOf('function deleteReasonStrip');
    assert.ok(start !== -1, 'the Leads-tab reason strip is missing');
    const fn = src.slice(start, landmark(src, '// ── Rejecting a lead'));
    const copy = fn.replace(/\/\/.*$/gm, '');
    for (const claim of [/teach/i, /learn/i, /next time/i, /improve/i]) {
        assert.ok(!claim.test(copy),
            `the Leads-tab strip claims learning the user cannot count on (${claim}) — the cluster `
            + 'proposer is gated on the strategy_agent plan feature, which is default OFF');
    }
});

// ── 5. The Profile ▸ Rules read-back makes the same limited promise ──────────
// The capture strips are honest about what a click does; this panel shows the accumulated
// rejections back, so it is the surface most likely to imply the assistant has learned something.
// Same rule. (It used to sit INSIDE "Learned Directives"; issue #131 promoted it to its own card
// because that panel is now hidden for records-kind roles — see the nesting check below.)
check('the lead-rejection panel does not claim the rejections taught the assistant', () => {
    const src = read('assistants.js');
    const start = src.indexOf('window._renderLeadRejectionEvidence = async function');
    assert.ok(start !== -1, 'the lead-rejection panel is missing');
    const fn = src.slice(start, landmark(src, 'window._toggleDirective', start));
    const copy = fn.replace(/\/\/.*$/gm, '');
    for (const claim of [/teach/i, /learn/i, /next time/i, /improve/i]) {
        assert.ok(!claim.test(copy),
            `the panel claims learning the user cannot count on (${claim}) — the cluster proposer `
            + 'is gated on the strategy_agent plan feature, which is default OFF');
    }
});

// A failed fetch must not render as "nothing recorded". That inversion is the exact complaint the
// panel exists to answer — a reviewer who cannot tell "captured but unshown" from "never saved".
check('the lead-rejection panel distinguishes no-data from a failed read', () => {
    const src = read('assistants.js');
    const start = landmark(src, 'window._renderLeadRejectionEvidence = async function');
    const fn = src.slice(start, landmark(src, 'window._toggleDirective', start));
    const guard = fn.indexOf('!Array.isArray(payload.reasons)');
    const empty = fn.indexOf('!payload.reasons.length');
    assert.ok(guard !== -1 && empty !== -1 && guard < empty,
        'the failed-read guard must come before the empty-state branch, or an error reads as "none"');
});

// ── 5b. The evidence panel must outlive the panel it used to live in ─────────
// content_rules reach a model only via compiled blueprint §4, and blueprint-prompt.ts has exactly
// two callers — process-content-jobs.ts and the admin smoke test. So Learned Directives is hidden
// for records-kind roles (issue #131). The lead-rejection evidence was nested INSIDE that card,
// which would have hidden the Lead Generator's only rejection surface along with it — the exact
// "an afternoon of categorising showed up nowhere" complaint the panel exists to answer.
check('the lead-rejection card is a sibling of Learned Directives, not nested inside it', () => {
    const html = read('assistant-detail.html');
    const lead = html.indexOf('id="card-lead-rejections"');
    const learned = html.indexOf('id="card-learned-directives"');
    assert.ok(lead !== -1, 'the lead-rejection card is missing');
    assert.ok(learned !== -1, 'the Learned Directives card lost its id — the gate cannot find it');
    assert.ok(lead < learned, 'the lead-rejection card must come BEFORE Learned Directives');
    assert.ok(
        html.slice(lead, learned).includes('id="runbook-lead-rejections"'),
        'the evidence host must sit in its own card — nested in Learned Directives it inherits that '
        + "card's gate and vanishes for the only role that populates it",
    );
});

check('Learned Directives is gated on the queue kind, not shown to every role', () => {
    const src = read('assistants.js');
    const start = src.indexOf('window._renderRunbookDirectives = async function');
    assert.ok(start !== -1, 'the directives renderer is missing');
    const fn = src.slice(start, landmark(src, 'window._renderLeadRejectionEvidence', start));
    assert.ok(/_rulesSteerThisAssistant\(\)/.test(fn), 'the gate predicate is gone');
    assert.ok(/card-learned-directives/.test(fn), 'the renderer no longer hides the card itself');
    assert.ok(/if \(!steers\) return;/.test(fn),
        'without the early return the panel still fetches and renders rules nothing reads');
});

check('the gate predicate is the review-queue kind', () => {
    const src = read('assistants.js');
    const start = src.indexOf('function _rulesSteerThisAssistant');
    assert.ok(start !== -1, 'the predicate is missing');
    const fn = src.slice(start, start + 300);
    assert.ok(/_detailReviewQueue/.test(fn) && /'posts'/.test(fn),
        "must key off reviewQueue.kind === 'posts' — the roles whose drafting worker reads §4");
});

// The green "Changes apply to everything this assistant does from now on" is true for social and
// blog and false everywhere else. It must stay a role-dependent string, not markup.
check('the Assistant Rules scope note does not hard-code the steering claim', () => {
    const src = read('assistants.js');
    const start = src.indexOf('function _applyAssistantRulesScope');
    assert.ok(start !== -1, 'the scope note is no longer applied per role');
    const fn = src.slice(start, landmark(src, '\nwindow._renderRunbookDirectives', start));
    const recordsBranch = fn.slice(landmark(fn, 'note.classList.remove(...EMERALD)'));
    assert.ok(
        !/everything this assistant does/.test(recordsBranch),
        'the records-kind copy repeats the claim that made a Lead Generator look like it obeyed '
        + 'rules no pipeline of its reads',
    );
    assert.ok(/won't change what it does today/.test(recordsBranch),
        'the records-kind copy must say plainly that the rules do not steer this assistant');
});

// Aggregates are the point of a closed vocabulary — but `other` is a bucket, not a signal, and the
// server must scope every read to one tenant AND one assistant.
check('the reject-feedback read is scoped to the org and the assistant', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const start = src.indexOf("if (action === 'list_reject_feedback')");
    assert.ok(start !== -1, 'the list_reject_feedback action is missing');
    const branch = src.slice(start, start + 2000);
    assert.ok(/eq\(leadRejectFeedback\.organisationId, orgId\)/.test(branch), 'not tenant-scoped');
    assert.ok(/eq\(leadRejectFeedback\.aiAssistantId, assistant\.id\)/.test(branch), 'not assistant-scoped');
    assert.ok(/appliedToTarget/.test(branch),
        'without the applied count the panel cannot tell evidence from an applied change');
});

// Same reason as the Review Queue's ordering test, checked in the other file: the reason is an
// annotation on a decision already made. If the strip were built BEFORE the PATCH resolved, a
// failed reject would leave the user categorising a lead that is still pending.
// ⚠️ The Leads tab now asks BEFORE, not after. Its Reject button is gone and Delete owns the
// capture, which confirms up front — so the property to defend flipped: instead of "no strip until
// the write succeeds", it is "no write until the strip is answered", plus "a failed write leaves
// the strip usable rather than pretending it worked".
check('the Leads-tab strip is answered before anything is written', () => {
    const src = read('src/components/assistant-data-hub.js');
    const start = src.indexOf("buttons.push({ label: 'Delete'");
    assert.ok(start !== -1, 'the Leads-tab Delete button is missing');
    const run = src.slice(start, landmark(src, '}});', start));
    assert.ok(/state\.hub\.recordType === 'lead'/.test(run) && /deleteReasonStrip\(record\)/.test(run),
        'pressing Delete on a lead must open the strip rather than deleting immediately');
    assert.ok(/return;/.test(run.slice(0, landmark(run, 'await deleteRecord'))),
        'the lead branch must return before the unconditional delete below it');

    const strip = src.slice(landmark(src, 'function deleteReasonStrip'), landmark(src, '// ── Rejecting a lead'));
    assert.ok(landmark(strip, 'strip.innerHTML') < landmark(strip, 'deleteRecord('),
        'the delete runs before the confirmation is even drawn');
    assert.ok(/b\.disabled = false/.test(strip),
        'a failed delete must leave the buttons usable — a dead strip over an undeleted lead reads '
        + 'as success');
});

check('the strip appears after the reject, never as a gate in front of it', () => {
    const src = handlerBody();
    // The pending marker is set inside the reject branch and only rendered once the PATCH has
    // resolved and the queue re-rendered. If the strip were awaited before the PATCH, a reviewer
    // could not clear a lead without categorising it.
    assert.ok(/_rqPendingReject = \{/.test(src), 'the reject branch must queue the strip, not show it');
    const after = landmark(src, '_rqShowRejectReasonStrip();');
    const render = src.indexOf('await _detailRqRenderGroups(_detailRqCurrentStatus);');
    assert.ok(after > render && render !== -1, 'the strip must be shown after the queue re-renders');
});

/**
 * The body of `_detailRqRecordAct` — the GENERIC record-action handler these two checks are about.
 *
 * Both used to scan the whole file with indexOf, which silently means "the first occurrence
 * anywhere". That held until the Campaign Assistant added its own approve/reject handlers, which
 * legitimately contain the same `buttons.forEach(… disabled = false …)` and
 * `await _detailRqRenderGroups(…)` lines — the anchors then resolved into a DIFFERENT function and
 * the checks stopped describing the handler they exist to protect. Scoped explicitly so a third
 * handler cannot quietly re-point them again.
 */
function handlerBody(): string {
    const src = read('assistants.js');
    const start = src.indexOf('window._detailRqRecordAct = async function');
    assert.notStrictEqual(start, -1, 'The generic record-action handler was renamed — update this anchor.');
    // Ends at the next top-level `window.` assignment, which is the following section's entry point.
    const end = src.indexOf('\nconst _RQ_BLOG_STATUS', start);
    assert.notStrictEqual(end, -1, 'The marker after the record-action handler moved — update this anchor.');
    return src.slice(start, end);
}

check('a failed reject clears the pending strip', () => {
    const src = handlerBody();
    const catchBlock = src.slice(landmark(src, 'buttons.forEach((b) => { b.disabled = false; });'));
    assert.ok(/_rqPendingReject = null/.test(catchBlock.slice(0, 800)),
        'left set, the strip would surface on whatever the user did NEXT');
});

console.log(`\n${passed} checks passed.`);
