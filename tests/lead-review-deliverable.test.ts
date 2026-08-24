// tests/lead-review-deliverable.test.ts
// The Review Queue holds EMAILS awaiting sign-off, not every lead the last search found.
//
// ── What this defends ────────────────────────────────────────────────────────
// A prod search returned 15 leads and the Review tab showed 15, because every promoted lead is
// inserted `pending_approval` and Review IS that slice. But outreach is email-only, enrichment
// attempts hot/warm leads only and hits roughly one in three, and cold leads carry no draft at
// all — so a queue promising "read this email and send it" was mostly stocked with leads that
// have nothing to read and nowhere to send. Review now filters to leads that are DELIVERABLE:
// a resolvable recipient AND a drafted body.
//
// ⚠️ THE INVARIANTS WORTH DEFENDING:
//
//   1. One definition of "who does this go to". The precedence outreachDraft.to → contactEmail →
//      lead.email decides three separate things: which leads reach the queue (SQL), which address
//      is printed above the Approve button (browser), and where the mail actually goes
//      (send_outreach). They were hand-copied. If they ever disagree, the user approves an email
//      addressed to one stranger and it is delivered to another — the worst bug this product can
//      have. src/config/lead-recipient.ts is now the only copy, and the browser's is GENERATED.
//
//   2. The filter is Review-only and opt-in. Applied to the Approved/Scheduled columns it would
//      hide leads that were approved before they had an address; applied by default it would
//      silently change every other record type's hub.
//
//   3. Approving from the Leads tab must not send. That tab is the TRIAGE decision ("is this
//      company worth pursuing"), taken at volume on leads that mostly cannot be emailed. The send
//      lives in Review, behind a button that says so.
//
// No database and no DOM: the browser components are IIFEs with no exports, so their logic is
// read as source and re-evaluated here, in the same style as tests/lead-contact-column.test.ts.
// Run:  npx tsx tests/lead-review-deliverable.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    LEAD_RECIPIENT_PATHS, LEAD_RECIPIENT_SQL_PATHS, LEAD_DRAFT_BODY_SQL_PATH,
    resolveLeadRecipient, hasOutreachDraft, isLeadDeliverable, isInOutreachReview,
} from '../src/config/lead-recipient';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const RECORDS = read('netlify/functions/assistant-records.ts');
const ASSISTANTS = read('assistants.js');
const HUB = read('src/components/assistant-data-hub.js');
const GENERATED = read('src/generated/platform-constants.js');

// ── 1. The predicate itself ──────────────────────────────────────────────────

check('recipient precedence is draft.to → contactEmail → lead.email', () => {
    assert.equal(resolveLeadRecipient({
        outreachDraft: { to: 'first@x.com' }, contactEmail: 'second@x.com', lead: { email: 'third@x.com' },
    }), 'first@x.com');
    assert.equal(resolveLeadRecipient({
        outreachDraft: { to: null }, contactEmail: 'second@x.com', lead: { email: 'third@x.com' },
    }), 'second@x.com');
    assert.equal(resolveLeadRecipient({ lead: { email: 'third@x.com' } }), 'third@x.com');
    assert.equal(resolveLeadRecipient({}), null);
});

check('a blank or whitespace address falls THROUGH rather than reading as reachable', () => {
    // The scorer routinely writes `to: ''` or `to: null`; enrichment fills contactEmail later.
    // Returning '' here would make an unreachable lead look deliverable and stock the queue with it.
    assert.equal(resolveLeadRecipient({ outreachDraft: { to: '' }, contactEmail: 'real@x.com' }), 'real@x.com');
    assert.equal(resolveLeadRecipient({ outreachDraft: { to: '   ' }, contactEmail: 'real@x.com' }), 'real@x.com');
    assert.equal(resolveLeadRecipient({ outreachDraft: { to: '  spaced@x.com  ' } }), 'spaced@x.com');
    assert.equal(resolveLeadRecipient({ contactEmail: '   ' }), null);
});

check('resolution survives junk shapes without throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, [], { outreachDraft: 'not an object' }, { lead: null }]) {
        assert.doesNotThrow(() => resolveLeadRecipient(junk));
        assert.equal(resolveLeadRecipient(junk), null);
    }
});

check('a cold lead carries no draft, so it is not deliverable even with an address', () => {
    // discovery-scoring.ts writes outreachDraft: null for cold leads and for doNotContact. That is
    // a fact about the LEAD, not a missing feature — such a lead belongs in Leads, not in a queue
    // that promises an email to read.
    assert.equal(hasOutreachDraft({ outreachDraft: null }), false);
    assert.equal(hasOutreachDraft({ outreachDraft: { subject: 'Hi', body: '   ' } }), false);
    assert.equal(hasOutreachDraft({ outreachDraft: { subject: 'Hi', body: 'Hello there' } }), true);
    assert.equal(isLeadDeliverable({ contactEmail: 'real@x.com', outreachDraft: null }), false);
});

check('deliverable requires BOTH halves', () => {
    assert.equal(isLeadDeliverable({ outreachDraft: { to: 'a@x.com', body: 'hi' } }), true);
    assert.equal(isLeadDeliverable({ outreachDraft: { body: 'hi' } }), false, 'draft but no recipient');
    assert.equal(isLeadDeliverable({ contactEmail: 'a@x.com' }), false, 'recipient but no draft');
    assert.equal(isLeadDeliverable({}), false);
});

// ── 2. The SQL mirror ────────────────────────────────────────────────────────

check('SQL paths are DERIVED from the precedence array, not typed out beside it', () => {
    assert.deepEqual([...LEAD_RECIPIENT_SQL_PATHS], LEAD_RECIPIENT_PATHS.map((p) => `{${p.join(',')}}`),
        'the SQL paths have been hand-written — add a recipient source and the filter would miss it');
    assert.equal(LEAD_DRAFT_BODY_SQL_PATH, '{outreachDraft,body}');
});

check('the GET filter builds its COALESCE from the shared paths', () => {
    assert.ok(/LEAD_RECIPIENT_SQL_PATHS/.test(RECORDS) && /LEAD_DRAFT_BODY_SQL_PATH/.test(RECORDS),
        'assistant-records.ts no longer imports the shared paths — the SQL has forked from the UI');
    assert.ok(/COALESCE\(\$\{recipientSql\}\) IS NOT NULL/.test(RECORDS),
        'the recipient half of the predicate is gone');
    assert.ok(/NULLIF\(BTRIM\(/.test(RECORDS),
        'blank addresses must be nulled in SQL too, or a `to: ""` row passes the filter');
});

check('the filter is opt-in and additive', () => {
    assert.ok(/deliverable === '1'/.test(RECORDS), 'the param is no longer read');
    // ⚠️ Still spread — the shape is what matters, not which predicate it carries. Leads now get
    // the stage-aware form (see 'the server column honours the stage in BOTH directions'); every
    // other record type gets the bare deliverability filter it always had.
    assert.ok(/\.\.\.\(deliverableOnly \? \[[^\]]*deliverableWhere\] : \[\]\)/.test(RECORDS),
        'the predicate must spread in only when asked — always-on would change every hub tab');
});

// ── 3. The client mirror is generated, never retyped ─────────────────────────

check('the browser copy of the precedence is generated from the real functions', () => {
    assert.ok(/window\.LeadRecipient = \{/.test(GENERATED),
        'window.LeadRecipient is missing — run npm run gen:constants');
    // The stringified function must be the REAL one: its body has to reference the shared path
    // array rather than a retyped chain of ||, which is exactly the drift this replaced.
    const fn = GENERATED.slice(landmark(GENERATED, 'var resolveLeadRecipient'), landmark(GENERATED, 'var hasOutreachDraft'));
    assert.ok(/LEAD_RECIPIENT_PATHS/.test(fn),
        'the emitted resolver no longer walks the shared paths — it has been reimplemented by hand');
    // ⚠️ DERIVED from the config, never hardcoded here. A literal expectation would still pass
    // when someone edits the precedence and forgets to regenerate — which is the entire failure
    // this file exists to catch.
    assert.ok(GENERATED.includes(`var LEAD_RECIPIENT_PATHS = ${JSON.stringify(LEAD_RECIPIENT_PATHS)}`),
        'the emitted paths disagree with src/config/lead-recipient.ts — run npm run gen:constants');
});

check('the generated resolver behaves identically to the server one', () => {
    // Evaluate the emitted browser code and run BOTH implementations over the same fixtures. This
    // is the check that actually catches a stale generated file.
    const decls = GENERATED.slice(landmark(GENERATED, 'var LEAD_RECIPIENT_PATHS'), landmark(GENERATED, 'window.LeadRecipient'));
    // eslint-disable-next-line no-new-func
    const browser = new Function(`${decls}\nreturn { resolveLeadRecipient, isLeadDeliverable };`)() as {
        resolveLeadRecipient: (d: unknown) => string | null;
        isLeadDeliverable: (d: unknown) => boolean;
    };
    const fixtures: unknown[] = [
        // ⚠️ First fixture carries EVERY source at once. Without it the two implementations agree
        // even when their precedence has been reordered, because each remaining fixture has only
        // one candidate address — a reordering is invisible until two of them compete.
        { outreachDraft: { to: 'a@x.com', body: 'hi' }, contactEmail: 'b@x.com', lead: { email: 'c@x.com' } },
        { contactEmail: 'b@x.com', lead: { email: 'c@x.com' }, outreachDraft: { body: 'hi' } },
        { outreachDraft: { to: 'a@x.com', body: 'hi' } },
        { outreachDraft: { to: '', body: 'hi' }, contactEmail: 'b@x.com' },
        { contactEmail: '  c@x.com  ', outreachDraft: { body: 'hi' } },
        { lead: { email: 'd@x.com' }, outreachDraft: { body: 'hi' } },
        { outreachDraft: null, contactEmail: 'e@x.com' },
        {}, null, 'junk',
    ];
    for (const f of fixtures) {
        assert.equal(browser.resolveLeadRecipient(f), resolveLeadRecipient(f),
            `browser and server resolve differently for ${JSON.stringify(f)} — regenerate constants`);
        assert.equal(browser.isLeadDeliverable(f), isLeadDeliverable(f),
            `browser and server disagree on deliverability for ${JSON.stringify(f)}`);
    }
});

check('the generated stage predicate behaves identically to the server one', () => {
    // Same shape as the check above, and the same reason: this is what catches a stale mirror. The
    // stage decides which SURFACE a lead is on, so a fork here shows the user a button that says
    // it moved a lead into a column the column itself disagrees about.
    // ⚠️ TWO slices, each stopping at its `window.` assignment. One slice spanning both blocks
    // swallows `window.LeadRecipient = {...}` in between, and there is no window in node.
    const decls = GENERATED.slice(landmark(GENERATED, 'var LEAD_RECIPIENT_PATHS'), landmark(GENERATED, 'window.LeadRecipient'))
        + GENERATED.slice(landmark(GENERATED, 'var leadOutreachStage'), landmark(GENERATED, 'window.LeadOutreachStage'));
    // eslint-disable-next-line no-new-func
    const browser = new Function(`${decls}\nreturn { isInOutreachReview };`)() as {
        isInOutreachReview: (d: unknown) => boolean;
    };
    const draft = { outreachDraft: { to: 'a@x.com', body: 'hi' } };
    const fixtures: unknown[] = [
        // ⚠️ The two that matter are the OVERRIDES, and each has to contradict deliverability or it
        // proves nothing: a promoted lead with nothing to send, and a held-back lead with a perfect
        // draft. Agreeing on the easy cases is what a fork looks like from the outside.
        { ...draft, outreachStage: 'triage' },
        { outreachStage: 'review' },
        { contactEmail: 'b@x.com', outreachStage: 'review' },
        { ...draft, outreachStage: 'review' },
        { ...draft, outreachStage: '  triage  ' },
        { ...draft, outreachStage: 'nonsense' },   // retired value → the automatic behaviour, never an empty column
        { ...draft, outreachStage: 42 },
        { ...draft, outreachStage: null },
        draft, {}, null, 'junk',
    ];
    for (const f of fixtures) {
        assert.equal(browser.isInOutreachReview(f), isInOutreachReview(f),
            `browser and server disagree on the review column for ${JSON.stringify(f)} — regenerate constants`);
    }
    // And the overrides actually override, in both directions — otherwise the loop above passes on
    // two implementations that are identically wrong.
    assert.equal(isInOutreachReview({ ...draft, outreachStage: 'triage' }), false,
        'a lead held back for more work is still shown in the review column');
    assert.equal(isInOutreachReview({ outreachStage: 'review' }), true,
        'a lead a human promoted by name is dropped by the deliverability filter anyway');
});

check('the Review Queue recipient line reads the shared resolver, not its own chain', () => {
    const fn = ASSISTANTS.slice(landmark(ASSISTANTS, 'function _rqRecipient'), landmark(ASSISTANTS, 'function _detailRqRecordCard'));
    assert.ok(/LR\.resolve\(d\)/.test(fn), '_rqRecipient no longer uses window.LeadRecipient');
    assert.ok(!/d\.outreachDraft && d\.outreachDraft\.to\) \|\| d\.contactEmail/.test(fn),
        'the hand-copied precedence is back in _rqRecipient — it will drift from the sender again');
    assert.ok(/Couldn’t read the recipient/.test(fn),
        'a failed constants load must SAY so: silence reads as "no recipient" beside a button that sends');
});

// ── 4. Review filters; the other columns must not ────────────────────────────

check('only the lead Review column asks for deliverable leads', () => {
    const fn = ASSISTANTS.slice(landmark(ASSISTANTS, 'async function _detailRqRenderRecords'), landmark(ASSISTANTS, 'window._detailRqRecordAct'));
    assert.ok(/const deliverableOnly = recordType === 'lead' && statusKey === 'review'/.test(fn),
        'the filter is no longer scoped to leads awaiting review');
    assert.ok(/deliverableOnly \? '&deliverable=1' : ''/.test(fn),
        'the query param is not conditional — approved/scheduled leads would be hidden too');
});

check('an empty lead Review column explains where the leads went', () => {
    // Shipping the filter without this converts a full-looking queue into a bare "nothing awaiting
    // your review" beside a search that just filed fifteen leads, which reads as a bug.
    const fn = ASSISTANTS.slice(landmark(ASSISTANTS, 'async function _detailRqRenderRecords'), landmark(ASSISTANTS, 'window._detailRqRecordAct'));
    // The tab is called "Enrichment" now (registry hubTab.label). This assertion is the reason
    // the empty state exists at all — a lead Review column is normally empty, and saying only
    // "nothing awaiting your review" beside a search that just filed fifteen leads reads as a bug.
    // It has to name where they actually went, so it has to track the rename.
    assert.ok(/they’re in the Enrichment tab/.test(fn),
        'the filtered empty state no longer points at the Enrichment tab');
});

// ── 5. Triage in the Leads tab does not send ─────────────────────────────────

check('the Leads tab moves a lead ON, and hides the button once it has', () => {
    // Anchored on the action KEY, not the label: the label is `Move to ${reviewTabLabel()}` so it
    // tracks a role's rename of the tab, and a landmark pinned to the rendered words would fail on
    // a rename that cannot affect what the button does.
    assert.ok(/key: 'move-to-outreach'/.test(HUB), 'the triage action is gone');
    // TWO gates, and both must be here.
    //   • isPastApprovalGate — the rule was `approvalStatus !== 'approved'`, which missed SENT
    //     leads: a successful send rests at 'scheduled', so every contacted lead was still offered
    //     the button. It lives in one helper so the footer and the bar cannot apply different
    //     versions of it (tests/lead-panel-actions.test.ts pins what the gate accepts).
    //   • isInOutreachReview — added 2026-08-24 with the move itself. Without it the panel offers
    //     to move a lead into the column it is already sitting in.
    assert.ok(/if \(!isPastApprovalGate\(record\) && !isInOutreachReview\(record\)\) \{/.test(HUB),
        'the move should hide once a lead is through the gate OR already in the review column');
});

check('moving from the Leads tab lands in REVIEW, PATCHes only, and never sends', () => {
    // ⚠️ THIS IS THE BYPASS CHECK. The button wrote `approvalStatus: 'approved'`, which put the
    // lead in the Outreach tab's Approved column having never passed through the column whose
    // whole job is a human reading the email before it goes to a stranger. Its own status line
    // said the drafted email was "waiting for you in the Review tab", and it was not.
    //
    // ⚠️ Anchored on the PUSH, not on a bare label — nextStepGuidance() carries the same words for
    // the next-step button, and a slice starting there swallows the whole action bar including the
    // "Look again" call to lead-generation, failing while the handler it names is correct.
    // ⚠️ Sliced to the DELETE push: Reject left this tab on 2026-08-15 (Delete performs the
    // rejection now), so Delete is the next push in the bar.
    // ⚠️ `key: 'move-to-outreach'` ALONE is not unique — nextStepGuidance() offers the same key
    // for the footer button it promotes, it appears first in the file, and a slice starting there
    // swallows the whole action bar. `primary: true` is only on the push.
    const start = landmark(HUB, "primary: true, key: 'move-to-outreach'");
    const block = HUB.slice(start, landmark(HUB, "buttons.push({ label: 'Delete'", start));
    assert.ok(/approvalStatus: 'pending_approval'/.test(block),
        'the PATCH sets a state other than pending_approval — anything else skips the review column');
    assert.ok(!/approvalStatus: 'approved'/.test(block),
        'the move approves the lead again, which is the bypass this check exists for');
    // The status alone does not move it: Enrichment and the review column SHARE
    // `pending_approval`, and the column additionally filters on a readable email. The stage is
    // what carries a draft-less lead across, so without it the button moves nothing at all.
    assert.ok(/outreachStage: 'review'/.test(block),
        'the move does not stamp the outreach stage, so a lead with no draft goes nowhere');
    assert.ok(!/lead-generation/.test(block) && !/send_outreach/.test(block),
        'the Leads tab must NOT send — this is the targeting decision, not the email');
    assert.ok(/Nothing has been sent/.test(block),
        'say what did not happen: users who learned Review sends will assume this did too');
});

check('the server column honours the stage in BOTH directions', () => {
    // The browser predicate and the SQL are two copies of one three-way decision, and they are
    // read by things that must agree: the column's contents, its badge count, and the buttons that
    // claim to have moved a lead into or out of it.
    const cfg = read('src/config/lead-recipient.ts');
    assert.ok(/export function isInOutreachReview/.test(cfg), 'the shared predicate is gone');
    assert.ok(/if \(stage === 'review'\) return true;/.test(cfg)
        && /if \(stage === 'triage'\) return false;/.test(cfg)
        && /return isLeadDeliverable\(data\);/.test(cfg),
        'the predicate no longer resolves stage → stage → deliverability, in that order');

    const records = read('netlify/functions/assistant-records.ts');
    assert.ok(/WHEN \$\{stageSql\} = 'review' THEN TRUE/.test(records)
        && /WHEN \$\{stageSql\} = 'triage' THEN FALSE/.test(records)
        && /ELSE \(\$\{deliverableWhere\}\)/.test(records),
        'the SQL filter forked from the browser predicate — the badge and the list will disagree');
    // ⚠️ Leads only. Both other record types pass ?deliverable=1 through the same param and carry
    // no stage; reading one there would be a jsonb probe for a key nothing writes.
    assert.ok(/recordType === 'lead' \? inOutreachReviewWhere : deliverableWhere/.test(records),
        'the stage-aware filter is applied to record types that have no stage');

    // The mirror the browser actually loads. isInOutreachReview closes over isLeadDeliverable, and
    // the two must be emitted as BARE names into one scope — an import between config modules is
    // rewritten by esbuild into a bundler local that does not exist in the browser, so the copy
    // throws on the first lead it is asked about.
    const gen = read('src/generated/platform-constants.js');
    assert.ok(/var isInOutreachReview = function/.test(gen), 'the stage predicate is missing from the client mirror');
    assert.ok(!/import_lead_recipient\./.test(gen),
        'the mirror references a bundler-local import that does not exist in the browser');
});

check('the send still lives in the Review Queue, gated on the lead record type', () => {
    assert.ok(/action === 'approve' && \(window\._detailReviewQueue \|\| \{\}\)\.recordType === 'lead'/.test(ASSISTANTS),
        'the Review Queue approve path no longer triggers send_outreach — approving would silently do nothing');
});

// ── 6. The lead count stops overstating a re-run ─────────────────────────────

check('both campaign endpoints report the latest run separately from the total', () => {
    for (const p of ['netlify/functions/signal-inbox.ts', 'netlify/functions/discovery-campaigns.ts']) {
        const src = read(p);
        assert.ok(/latestRunLeadsFound/.test(src), `${p} no longer reports the latest run's count`);
        const sub = src.slice(landmark(src, 'latestRunLeadsFound'));
        assert.ok(/ORDER BY j\.created_at DESC, j\.id DESC LIMIT 1/.test(sub.slice(0, 400)),
            `${p}: the latest-job subquery needs the id tiebreaker or it can pick a different job from its neighbours`);
    }
});

check('a re-run that deduped to nothing does not read as a fresh haul', () => {
    // leads_found counts only newly INSERTED domains (onConflictDoNothing on campaign+domain), so
    // a repeat run of the same campaign banks 0 while the cumulative total stands still. The card
    // used to print the total alone, so that re-run reported "15 leads found".
    const CARDS = read('src/components/assistant-discovery-campaigns.js');
    const fn = CARDS.slice(landmark(CARDS, 'function leadCountLine'), landmark(CARDS, 'function body()'));
    assert.ok(/No new leads on the last run/.test(fn),
        'a zero-yield re-run must say so rather than restating the campaign total');
    assert.ok(/latest === total/.test(fn),
        'a first run should not read "15 this run · 15 in total" — say it once');
});

check('a running search says "this run", never "the last run"', () => {
    const INBOX = read('src/components/assistant-signal-inbox.js');
    const start = INBOX.indexOf('function searchState');
    assert.ok(start !== -1, 'searchState() is gone — the Searches chip no longer derives its state');
    const body = INBOX.slice(start, landmark(INBOX, '\n  }', landmark(INBOX, 'return { chip:', start)));

    // `total` is reused by the in-flight lines ("Filing what it found…", "Searching the web…"), so
    // the count phrase has to know whether a run is happening NOW. If `started` were computed
    // after it, a live run would report its climbing count as "the last run".
    const iStarted = body.indexOf('const started =');
    const iRunLabel = body.indexOf('const runLabel =');
    assert.ok(iStarted !== -1 && iRunLabel !== -1, 'started/runLabel are gone from searchState');
    assert.ok(iStarted < iRunLabel,
        '`started` must be computed BEFORE the count line, or an in-flight run is labelled "the last run"');
    assert.ok(/Nothing new yet this run/.test(body),
        'a run still in flight must not report "no new companies" as a finished result');
});

console.log(`\n${passed} checks passed.`);
