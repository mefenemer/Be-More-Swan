// tests/lead-retention.test.ts
// The 30-day retention clock on a lead, and the Deleted section it moves leads into.
//
// WHY THIS EXISTS. This is the only automatic, irreversible thing that happens to a user's leads
// without them touching anything. Everything else in the Lead Generator waits for a click. That
// makes a whole class of ordinary drift unusually expensive here:
//
//   1. THE COUNTDOWN DISAGREEING WITH THE SWEEP. The user reads "3 days left" and the job runs
//      tonight. Two implementations of "30 days from when?" is all it takes, so there is exactly
//      one — updated_at, on both sides — and §1 holds it there.
//   2. THE SWEEP WIDENING. It collects the two states the UI draws a countdown on. If it ever
//      collects 'approved' or 'scheduled' it would be deleting leads whose outreach has ALREADY
//      GONE to a real person, with no warning anywhere on screen, because those columns show no
//      countdown by design. §2.
//   3. IT BECOMING A REAL DELETE. The point of the feature is that the verdict is KEPT — a hard
//      delete severs discovered_leads.assistant_record_id and lets a second campaign re-find and
//      re-mail the same company. §3.
//   4. THE GRAVEYARD LEAKING INTO LIVE VIEWS. Every existing caller of assistant-records asked a
//      question about actionable leads and none of them knew this state was coming, so the
//      endpoint has to default to hiding it. §4.
//
// No database: source-consistency checks plus real execution of the generated browser mirror.
// Run:  npx tsx tests/lead-retention.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';
import {
    LEAD_RETENTION_DAYS, RETENTION_REASONS, RETENTION_REASON_LABELS, RETENTION_REASON_NOTES,
    retentionReasonFor, retentionDaysRemaining, retentionCountdownLabel, retentionUrgency,
    isRetentionDeleted,
} from '../src/config/lead-retention';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const SWEEP = read('netlify/functions/lead-retention-sweep.ts');
const RECORDS = read('netlify/functions/assistant-records.ts');
const LEADGEN = read('netlify/functions/lead-generation.ts');
const HUB = read('src/components/assistant-data-hub.js');
const DETAIL = read('assistants.js');
const REGISTRY = read('src/components/assistant-dashboard-registry.js');
const THREADS = read('src/components/assistant-lead-threads.js');
const INBOX = read('src/components/assistant-signal-inbox.js');
const GENERATED = read('src/generated/platform-constants.js');
const TOML = read('netlify.toml');

// The send-back action, bounded by its true neighbours. ⚠️ Anchor on the action that IMMEDIATELY
// follows it — a later anchor silently swallows whatever gets inserted between, which is exactly
// how lead-look-again.test.ts started counting this action's writes as look_again's.
const SEND_BACK = LEADGEN.slice(
    landmark(LEADGEN, "if (action === 'send_back_for_enrichment')"),
    landmark(LEADGEN, "if (action === 'set_outcome')"),
);

console.log('\n──── 1. one clock, read the same way on both sides ────');

check('the sweep and the browser both read updated_at, and nothing else', () => {
    // The strongest available guarantee that the countdown cannot drift from the job: there is no
    // expression on either side to drift. If a dedicated stamp is ever reintroduced it must land in
    // BOTH places in the same commit — and this check should then compare the two expressions
    // rather than assert their absence.
    assert.match(SWEEP, /const clockSql = sql\.raw\('updated_at'\)/,
        'the sweep no longer keys off updated_at alone — the browser countdown must move with it');
    const cfg = read('src/config/lead-retention.ts');
    const fn = cfg.slice(landmark(cfg, 'export function retentionClockStart'), landmark(cfg, '\n}', landmark(cfg, 'export function retentionClockStart')));
    assert.ok(!/retention\b.*\[|RETENTION_CLOCK/.test(fn),
        'retentionClockStart reads something other than the updatedAt it is passed — the sweep does not');
});

check('the countdown rounds UP, so a lead still on screen never reads zero', () => {
    const sixHoursLeft = new Date(Date.now() - (LEAD_RETENTION_DAYS * 86400000) + 6 * 3600000).toISOString();
    assert.strictEqual(retentionDaysRemaining(sixHoursLeft), 1,
        'a lead with hours left must read "1 day left" — a 0 beside a row that is still actionable reads as a bug');
    const overdue = new Date(Date.now() - (LEAD_RETENTION_DAYS + 1) * 86400000).toISOString();
    assert.strictEqual(retentionDaysRemaining(overdue), 0, 'a lead past its window must read 0, not a negative');
    assert.strictEqual(retentionCountdownLabel(0), 'Due for deletion');
    assert.strictEqual(retentionCountdownLabel(1), '1 day left', 'the singular must not read "1 days left"');
    assert.strictEqual(retentionDaysRemaining(null), null, 'no clock must render nothing, never NaN');
    assert.strictEqual(retentionDaysRemaining('not a date'), null, 'an unparseable stamp must not render NaN');
});

check('urgency shouts for a week, not for an afternoon', () => {
    // The thresholds are generous on purpose: this countdown ends in something the user cannot undo.
    assert.strictEqual(retentionUrgency(30), 'low');
    assert.strictEqual(retentionUrgency(7), 'soon');
    assert.strictEqual(retentionUrgency(3), 'urgent');
    assert.strictEqual(retentionUrgency(0), 'urgent');
    assert.strictEqual(retentionUrgency(null), 'none');
});

console.log('\n──── 2. the sweep collects only what the UI warns about ────');

check('only pending_approval and rejected are collected', () => {
    const fn = SWEEP.slice(landmark(SWEEP, 'async function collect'), landmark(SWEEP, '\n}', landmark(SWEEP, 'async function collect')));
    assert.match(fn, /eq\(assistantRecords\.approvalStatus, 'pending_approval'\)/, 'the Review column is not collected');
    assert.match(fn, /eq\(assistantRecords\.approvalStatus, 'rejected'\)/, 'the Archived column is not collected');
    // ⚠️ The load-bearing half. On this role 'scheduled' means the email has ALREADY been sent and
    // what is scheduled is the chase reminder — sweeping it would delete the record of a live
    // conversation, and no countdown is drawn on that column to warn anyone.
    assert.ok(!/'approved'|'scheduled'/.test(fn),
        'the sweep now collects approved or scheduled leads. Those columns show NO countdown, so this '
        + 'would delete leads whose outreach has already gone to a real person with no warning at all.');
});

check('the countdown is drawn on exactly the states the sweep collects', () => {
    // The other direction of the same rule: a countdown on a column that is never swept is a threat
    // the system does not carry out.
    const cell = HUB.slice(landmark(HUB, 'function retentionCell'), landmark(HUB, '\n  }', landmark(HUB, 'function retentionCell')));
    assert.match(cell, /pending_approval/, 'the table column stopped counting down pending leads');
    assert.match(cell, /rejected/, 'the table column stopped counting down rejected leads');
    assert.ok(!/'approved'|'scheduled'/.test(cell), 'the table column counts down a state that is never swept');

    const chip = DETAIL.slice(landmark(DETAIL, 'function _rqRetentionChip'), landmark(DETAIL, '\n}', landmark(DETAIL, 'function _rqRetentionChip')));
    assert.match(chip, /statusKey !== 'review' && statusKey !== 'archived'/,
        'the Outreach card chip is drawn on a column the sweep does not collect');
});

check('every reason the sweep can assign has a label AND a note', () => {
    // The section exists to explain itself; a row with no sentence is a lead that vanished.
    for (const r of RETENTION_REASONS) {
        assert.ok(RETENTION_REASON_LABELS[r]?.trim(), `reason ${r} has no label`);
        assert.ok(RETENTION_REASON_NOTES[r]?.trim(), `reason ${r} has no explanatory note`);
    }
});

check('do_not_contact outranks every other reason', () => {
    // The one verdict that must survive a user later deciding to pursue the company anyway.
    assert.strictEqual(
        retentionReasonFor({ doNotContact: true, enrichAttemptedAt: 'x' }, 'rejected', true),
        'do_not_contact');
    assert.strictEqual(retentionReasonFor({}, 'rejected', false), 'rejected',
        'an explicit rejection outranks a missing address — the user decision is the stronger fact');
    assert.strictEqual(retentionReasonFor({ enrichAttemptedAt: 'x' }, 'pending_approval', false), 'enrichment_failed');
    assert.strictEqual(retentionReasonFor({}, 'pending_approval', false), 'not_contactable',
        '"we tried and found nothing" and "we never tried" are different facts with different remedies');
    assert.strictEqual(retentionReasonFor({}, 'pending_approval', true), 'unreviewed');
});

console.log('\n──── 3. it MOVES leads; it never deletes them ────');

check('the sweep issues no delete, and leaves discovered_leads alone', () => {
    assert.ok(!/\.delete\(/.test(SWEEP),
        'the retention sweep now deletes rows. It must not: destroying the record destroys the only '
        + 'copy of the verdict, and the dedupe index is per-campaign, so a second search re-finds '
        + 'and re-mails the same company.');
    assert.ok(!/discoveredLeads/.test(SWEEP),
        'the sweep touches discovered_leads. It must not — severing that link is what orphans a '
        + "lead's provenance, exactly as the manual delete path does.");
});

check('the approval status is preserved through the move', () => {
    // "rejected, then dropped" and "never reviewed, then dropped" are different facts, and the
    // targeting feedback wants both. Overwriting the column would destroy half the story.
    const fn = SWEEP.slice(landmark(SWEEP, 'async function markDeleted'), landmark(SWEEP, '\n}', landmark(SWEEP, 'async function markDeleted')));
    assert.ok(!/approvalStatus:/.test(fn), 'the sweep overwrites approval_status — the reason it was dropped loses its context');
    assert.match(fn, /jsonb_set/, 'the stamp must be a targeted jsonb_set, not a wholesale rewrite of data');
});

check('the stamp is merged, never a wholesale rewrite of data', () => {
    // `data` holds the scoring card, the outreach draft, the enrichment stamps and the deal
    // outcome. A read-modify-write races every other writer of this row.
    const fn = SWEEP.slice(landmark(SWEEP, 'async function markDeleted'), landmark(SWEEP, '\n}', landmark(SWEEP, 'async function markDeleted')));
    assert.match(fn, /COALESCE\(\$\{assistantRecords\.data\} -> /,
        'the retention object must merge into whatever is already there, or a restarted clock is lost');
});

check('the sweep is registered as a cron', () => {
    assert.match(TOML, /\[functions\.lead-retention-sweep\]/, 'the sweep is not scheduled — it would never run');
    assert.match(TOML, /\[functions\.lead-retention-sweep\]\s*\n\s*schedule = "[^"]+"/, 'the sweep has no schedule line');
});

console.log('\n──── 4. the graveyard never leaks into a live view ────');

check('the records endpoint hides moved leads by DEFAULT', () => {
    // Every existing caller asked a question about actionable leads and none of them knew this
    // state was coming. Defaulting to 'all' would leave a moved lead in the column it was just
    // swept out of.
    assert.match(RECORDS, /const retentionParam = String\(event\.queryStringParameters\?\.retention \|\| 'live'\)/,
        "the retention filter no longer defaults to 'live' — moved leads would reappear in Outreach");
    assert.match(RECORDS, /retentionMode === 'live'\s*\n?\s*\? sql`\$\{deletedAtSql\} IS NULL`/,
        "'live' must exclude rows carrying a deletedAt stamp");
});

check('the Enrichment table and the Deleted section read separate lists', () => {
    // One array holding two populations would need all nine of its readers (table, filters,
    // groups, counts, selection, paging, CSV, deep-link focus, bulk actions) to remember which
    // one they meant.
    assert.match(HUB, /async function fetchDeletedRecords/, 'the Deleted section has no fetch of its own');
    assert.match(HUB, /retention=deleted/, 'the Deleted section does not ask for the moved leads');
    assert.match(HUB, /deletedRecords: \[\]/, 'moved leads are not held apart from state.records');
});

check('the tab count describes the live table only', () => {
    const fn = HUB.slice(landmark(HUB, 'function updateTabCount'), landmark(HUB, '\n  }', landmark(HUB, 'function updateTabCount')));
    assert.match(fn, /state\.records\.length/,
        'the tab count must come from the live records — counting the graveyard would put a number '
        + 'on the tab that nothing on screen adds up to');
    assert.ok(!/deletedRecords/.test(fn), 'the tab count includes moved leads');
});

console.log('\n──── 5. send back for enrichment ────');

check('it clears the retention verdict and un-rejects the lead', () => {
    assert.match(SEND_BACK, /- 'deletedAt' - 'reason'/,
        'the retention verdict is not cleared — the lead would stay in the Deleted section');
    assert.match(SEND_BACK, /'returnedAt'/, 'nothing records that a human rescued this lead');
    assert.match(SEND_BACK, /rec\.approvalStatus === 'rejected' \? \{ approvalStatus: 'pending_approval' \}/,
        'a rejected lead sent back stays rejected — it would re-enter Archived and be swept again '
        + 'in 30 days having never been reconsidered');
});

check('it does NOT clear a do-not-contact flag', () => {
    // That verdict has its own audited override (override_do_not_contact) which records who did it.
    assert.ok(!/doNotContact/.test(SEND_BACK.replace(/\/\/[^\n]*/g, '')),
        'send_back_for_enrichment touches the do-not-contact flag. Clearing it here would bypass '
        + 'the audited override that exists precisely to record who made that decision.');
});

check('it actually enriches, rather than clearing a stamp and waiting', () => {
    // The distinction from `look_again`, and the entire reason both exist. A lead reaches the
    // Deleted section BECAUSE 30 days of waiting produced nothing; offering it more waiting is the
    // same dead end in a new coat.
    assert.match(SEND_BACK, /await enrichOneLead\(db, \{/,
        'the action no longer runs an enrichment pass — it is "Look again" with a new label');
    assert.match(SEND_BACK, /looked: false/,
        'a lead with no domain must say plainly that nothing was looked up, not report an enrichment that never ran');
});

check('enrichment has ONE writer, shared by the worker and the on-demand path', () => {
    // Two writers of enrichAttemptedAt / contactEmail / emailKind across two tables that must
    // agree is how the Searches aggregate and the Enrichment table start contradicting each other.
    const shared = read('src/utils/lead-enrichment.ts');
    assert.match(shared, /export async function recordEnrichment/, 'the shared writer is gone');
    const worker = read('netlify/functions/process-discovery-jobs.ts');
    assert.ok(!/async function recordEnrichment/.test(worker),
        'the worker has its own copy of recordEnrichment again — one write path, per the notify.ts rule');
    assert.match(worker, /import \{ recordEnrichment \} from '\.\.\/\.\.\/src\/utils\/lead-enrichment'/,
        'the worker no longer imports the shared writer');
});

check('the on-demand path reaches leads the worker never could', () => {
    // enrichBatch selects FROM discovered_leads, so a CSV-imported or hand-added lead had never
    // been enriched by anything in the product's history.
    const shared = read('src/utils/lead-enrichment.ts');
    assert.match(shared, /leadId: number \| null/, 'the shared writer cannot handle a lead with no discovery row');
    assert.match(SEND_BACK, /lead\?\.domain \|\| recordSite/,
        'the domain must fall back to the record itself, or imported leads stay unreachable');
});

console.log('\n──── 6. one count format across the four tabs ────');

check('all four tabs print their count through the shared formatter', () => {
    assert.match(REGISTRY, /function setTabCount/, 'the shared tab-count formatter is gone');
    for (const [name, src, id] of [
        ['Searches', INBOX, 'signals-tab-label'],
        ['Enrichment', HUB, 'datahub-tab-label'],
        ['Conversations', THREADS, 'conversations-tab-label'],
        ['Outreach', DETAIL, 'review-queue-tab-label'],
    ] as Array<[string, string, string]>) {
        assert.ok(src.includes(`setTabCount(\n      '${id}'`) || src.includes(`setTabCount('${id}'`),
            `the ${name} tab no longer formats its count through AssistantDashboardRegistry.setTabCount — `
            + 'the four tabs drift apart the moment one of them formats its own');
    }
});

check('a zero count is suppressed, not printed', () => {
    // An empty tab says so in its own body; "Enrichment (0)" reads as a counter that failed to load.
    const fn = REGISTRY.slice(landmark(REGISTRY, 'function setTabCount'), landmark(REGISTRY, '\n  }', landmark(REGISTRY, 'function setTabCount')));
    assert.match(fn, /n > 0/, 'setTabCount no longer suppresses (0)');
    assert.match(fn, /Number\.isFinite/, 'a missing count must leave the bare label, not print "(NaN)"');
});

check('the Outreach columns all get a count, not just the open one', () => {
    // Records queues used to set only the badge of the column being looked at, so a lead moving
    // from Review to Approved left the only number on screen and arrived somewhere blank.
    assert.match(DETAIL, /async function _detailRqRefreshRecordCounts/, 'the records-queue counter is gone');
    const fn = DETAIL.slice(
        landmark(DETAIL, 'async function _detailRqRefreshRecordCounts'),
        landmark(DETAIL, '\n}', landmark(DETAIL, 'async function _detailRqRefreshRecordCounts')),
    );
    for (const col of ['review', 'approved', 'scheduled', 'archived']) {
        assert.ok(fn.includes(`_detailRqSetColumnBadge('${col}'`), `the ${col} column badge is not set`);
    }
    assert.match(fn, /deliverable=1/,
        'the Review count must use the same deliverable filter the column renders, or the badge '
        + 'contradicts the list beneath it');
});

console.log('\n──── 7. the browser mirror is the same code the server runs ────');

check('the generated mirror exposes the retention API the UI calls', () => {
    assert.match(GENERATED, /window\.LeadRetention = \{/, 'the retention mirror was not generated');
    for (const key of ['isDeleted', 'reasonOf', 'daysRemaining', 'countdownLabel', 'urgency', 'NOTICE', 'DELETED_NOTICE', 'REASON_LABELS']) {
        assert.ok(GENERATED.includes(`${key}:`), `window.LeadRetention.${key} is missing — the UI calls it`);
    }
});

check('the mirror actually runs, and agrees with the server module', () => {
    // Executed, not scanned: these functions are emitted via .toString(), so a free variable the
    // generator forgot to re-declare is a ReferenceError that no source scan would catch.
    const w: Record<string, any> = {};
    new Function('window', GENERATED)(w);
    const R = w.LeadRetention;
    assert.strictEqual(R.DAYS, LEAD_RETENTION_DAYS, 'the mirrored window differs from the server constant');

    const iso = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
    for (const age of [0, 12, 23, 27, 29, 31]) {
        assert.strictEqual(R.daysRemaining(iso(age)), retentionDaysRemaining(iso(age)),
            `the browser and the server disagree about a lead ${age} days old`);
    }
    assert.strictEqual(R.isDeleted({ retention: { deletedAt: iso(1) } }), true);
    assert.strictEqual(R.isDeleted({ retention: { returnedAt: iso(1) } }), false,
        'a lead sent back keeps its retention object and must read as LIVE');
    assert.strictEqual(isRetentionDeleted({ retention: { returnedAt: iso(1) } }), false,
        'the server module must agree with the mirror on the same shape');
    assert.strictEqual(R.reasonOf({ retention: { deletedAt: iso(1), reason: 'enrichment_failed' } }), 'enrichment_failed');
});

check('the notice states all four facts before a countdown is shown', () => {
    const w: Record<string, any> = {};
    new Function('window', GENERATED)(w);
    const notice: string = w.LeadRetention.NOTICE;
    assert.match(notice, new RegExp(String(LEAD_RETENTION_DAYS)), 'the notice does not say how long');
    assert.match(notice, /automatically/i, 'the notice does not say it happens by itself');
    assert.match(notice, /cannot be undone/i, 'the notice does not say the move is irreversible');
    assert.match(notice, /send it back for enrichment/i, 'the notice does not name the one way out');
    // ⚠️ Must NOT claim permanent deletion. The lead is retained, and overstating it would make the
    // Deleted section that follows look like a bug.
    assert.ok(!/permanently delet/i.test(notice),
        'the notice claims permanent deletion — the lead is kept, and saying otherwise makes the '
        + 'Deleted section read as a malfunction');
});

console.log(`\n${passed} checks passed.\n`);
