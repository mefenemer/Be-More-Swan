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
    resolveLeadRecipient, hasOutreachDraft, isLeadDeliverable,
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
    assert.ok(/\.\.\.\(deliverableOnly \? \[deliverableWhere\] : \[\]\)/.test(RECORDS),
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

check('the Leads tab offers Approve alongside Reject', () => {
    // Matched loosely on the label: this button carries a `primary: true` flag now (it is the one
    // decision the panel exists for, and five identical ghost buttons gave the reader no way in),
    // and a landmark pinned to the exact argument order failed on a styling change that could not
    // affect what the button does.
    assert.ok(/label: 'Approve'/.test(HUB), 'the Approve triage action is gone');
    assert.ok(/record\.approvalStatus !== 'approved'/.test(HUB),
        'Approve should hide once a lead is already approved');
});

check('approving from the Leads tab PATCHes only, and never calls the sender', () => {
    // ⚠️ Anchored on the PUSH, not on the bare label — nextStepGuidance() also carries
    // "label: 'Approve'" (it offers Approve as the next-step button), and a slice starting there
    // swallows the whole action bar, including the "Look again" call to lead-generation. The
    // assertion then fails while the handler it names is perfectly correct.
    const start = landmark(HUB, "buttons.push({ label: 'Approve'");
    const block = HUB.slice(start, landmark(HUB, "label: 'Reject'", start));
    assert.ok(/approvalStatus: 'approved'/.test(block), 'the PATCH no longer sets approved');
    assert.ok(!/lead-generation/.test(block) && !/send_outreach/.test(block),
        'the Leads tab must NOT send — approving here is the targeting decision, not the email');
    assert.ok(/Nothing has been sent/.test(block),
        'say what did not happen: users who learned Review sends will assume this did too');
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
