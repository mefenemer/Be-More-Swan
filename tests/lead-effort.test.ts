// tests/lead-effort.test.ts
//
// The Lead Generator's "Effort Saved / Money Saved" strip — the arithmetic, and the two switches
// that decide whether the strip appears at all.
//
// ── Why the switches get their own checks ────────────────────────────────────
// This role carries BOTH `modules.hasImpactRoi: false` and `roiSource: 'lead'`, and the pair looks
// contradictory to anyone reading it cold. It is not: hasImpactRoi gates the POST-based fetch (and
// the "Content by platform" breakdown), which is structurally zero for an assistant that publishes
// nothing; roiSource re-reveals the strip alone and points it at the ledger-backed endpoint.
// "Simplifying" that to hasImpactRoi: true is the obvious-looking change, and it silently restores
// the exact bug the strip was added to fix — the post endpoint returns zeroes and the strip hides
// itself again. These checks make that revert fail loudly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLeadEffort, emptyLeadEffort, EFFORT_ITEMS } from '../src/utils/lead-effort';
import { DEFAULT_TIME_MULTIPLIERS } from '../src/utils/platform-config';

const root = join(import.meta.dirname, '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    }
}

console.log('\n──── the effort model ────');

check('hours are the sum of every counted item at its own rate', () => {
    const e = buildLeadEffort(
        { lead_discovered: 20, lead_enriched: 10, outreach_sent: 12, reply_received: 3 },
        DEFAULT_TIME_MULTIPLIERS,
        null,
    );
    // 20×3 + 10×3 + 12×5 + 3×2 = 60 + 30 + 60 + 6 = 156 minutes = 2.6h
    assert.equal(e.hoursSaved, 2.6);
    assert.equal(e.items, 45);
    assert.equal(e.hasData, true);
});

check('the workings are ordered by weight, so the headline can be explained', () => {
    const e = buildLeadEffort(
        { lead_discovered: 20, outreach_sent: 12 },
        DEFAULT_TIME_MULTIPLIERS,
        null,
    );
    // 20×3 = 60 beats 12×5 = 60 only on a tie; make it unambiguous.
    const heavier = buildLeadEffort({ lead_discovered: 30, outreach_sent: 12 }, DEFAULT_TIME_MULTIPLIERS, null);
    assert.equal(heavier.breakdown[0].eventType, 'lead_discovered');
    assert.ok(e.breakdown.every((b, i) => i === 0 || e.breakdown[i - 1].minutes >= b.minutes));
});

check('an event with no rows contributes nothing and does not appear in the workings', () => {
    const e = buildLeadEffort({ lead_discovered: 5, outreach_sent: 0 }, DEFAULT_TIME_MULTIPLIERS, null);
    assert.equal(e.breakdown.length, 1);
    assert.equal(e.breakdown[0].eventType, 'lead_discovered');
});

check('the unit is singular for one and plural for the rest', () => {
    assert.equal(buildLeadEffort({ lead_discovered: 1 }, DEFAULT_TIME_MULTIPLIERS, null).breakdown[0].label,
        'company researched');
    assert.equal(buildLeadEffort({ lead_discovered: 2 }, DEFAULT_TIME_MULTIPLIERS, null).breakdown[0].label,
        'companies researched');
});

check('money is BLANK without a rate — never £0', () => {
    // ⚠️ "£0 saved" beside twelve hours of work is a verdict on the assistant, produced entirely by
    // an empty field in Settings. The card must say "set your hourly rate", not "nothing".
    for (const rate of [null, 0, NaN]) {
        const e = buildLeadEffort({ outreach_sent: 100 }, DEFAULT_TIME_MULTIPLIERS, rate as number | null);
        assert.equal(e.gbpSaved, null, `a rate of ${rate} must not produce a money figure`);
        assert.equal(e.hourlyRateSet, false);
    }
    const withRate = buildLeadEffort({ outreach_sent: 12 }, DEFAULT_TIME_MULTIPLIERS, 45);
    assert.equal(withRate.hoursSaved, 1);
    assert.equal(withRate.gbpSaved, 45);
    assert.equal(withRate.hourlyRateSet, true);
});

check('nothing measured reads as hasData:false, so the strip stays hidden', () => {
    assert.equal(buildLeadEffort({}, DEFAULT_TIME_MULTIPLIERS, 45).hasData, false);
    assert.equal(emptyLeadEffort().hasData, false);
    // Same keys either way — no caller should have to special-case the empty shape.
    assert.deepEqual(
        Object.keys(emptyLeadEffort()).sort(),
        Object.keys(buildLeadEffort({ outreach_sent: 1 }, DEFAULT_TIME_MULTIPLIERS, 1)).sort(),
    );
});

check('the multipliers come from platform config, never from a constant invented here', () => {
    // An operator retuning GAMIFICATION_TIME_MULTIPLIERS must retune this strip with everything
    // else. A hardcoded minute figure in lead-effort.ts is how the dashboard hero and this strip
    // start quoting different hours for the same work.
    const text = src('src/utils/lead-effort.ts');
    for (const item of EFFORT_ITEMS) {
        assert.ok(item.multiplier in DEFAULT_TIME_MULTIPLIERS,
            `${item.eventType} names ${item.multiplier}, which is not a platform multiplier`);
    }
    assert.ok(!/minutesEach:\s*\d/.test(text), 'a minutes figure is hardcoded instead of read from the multipliers');
});

check('every counted event is one the ledger actually writes', () => {
    // A kind of work nobody records is a kind of work that silently contributes zero for ever.
    const writers = [
        'netlify/functions/process-discovery-jobs.ts',
        'netlify/functions/process-sequence-sends.ts',
        'netlify/functions/inbound-email.ts',
        'netlify/functions/lead-generation.ts',
        'src/utils/lead-enrichment.ts',
    ].map(src).join('\n');
    for (const item of EFFORT_ITEMS) {
        assert.ok(writers.includes(`recordEvent(db, '${item.eventType}'`),
            `nothing writes ${item.eventType} to the ledger, so it can only ever count zero`);
    }
});

check('discovery counts leads and outreach counts messages', () => {
    // ⚠️ The distinction IS the accuracy of the number. `outreach_sent` is written once per send
    // INCLUDING every chaser, and each of those is another email a person would have written;
    // finding the same company twice is not two researches.
    const byType = Object.fromEntries(EFFORT_ITEMS.map((i) => [i.eventType, i.distinct]));
    assert.equal(byType.lead_discovered, true);
    assert.equal(byType.lead_enriched, true);
    assert.equal(byType.outreach_sent, false);
    assert.equal(byType.reply_received, false);

    // …and the query has to implement both, or the flag is decoration.
    const fn = src('netlify/functions/get-lead-roi.ts');
    assert.ok(/it\.distinct \? sql`DISTINCT lead_key` : sql`\*`/.test(fn),
        'the query no longer branches on `distinct` — every count would use the same rule');
});

console.log('\n──── the strip is switched on for the lead role, and only the strip ────');

check('the Lead Generator declares roiSource, and does NOT flip hasImpactRoi', () => {
    const registry = src('src/components/assistant-dashboard-registry.js');
    const entry = registry.slice(
        registry.indexOf('lead_qualifier: {'),
        registry.indexOf('accounts_receivable_clerk: {'),
    );
    assert.ok(entry.length > 0, 'the lead_qualifier registry entry is gone');
    assert.ok(/roiSource: 'lead'/.test(entry), 'the lead role no longer declares its own ROI source');
    assert.ok(/hasImpactRoi: false/.test(entry),
        'hasImpactRoi was flipped to true — that routes the strip back to the POST endpoint, which '
        + 'is structurally zero for this role, and the strip hides itself again');
});

check('the registry entry explains why both switches exist', () => {
    // Two flags that look contradictory need the reason ON them, or the next reader "simplifies"
    // one away. This assertion is the tripwire on that.
    const registry = src('src/components/assistant-dashboard-registry.js');
    const entry = registry.slice(
        registry.indexOf('lead_qualifier: {'),
        registry.indexOf('accounts_receivable_clerk: {'),
    );
    assert.ok(/SECOND, independent switch/i.test(entry),
        'the roiSource declaration no longer explains its relationship to hasImpactRoi');
});

check('the client branches on roiSource BEFORE the post-role guard', () => {
    // ⚠️ _fetchAndRenderAssistantMetrics returns early when the platform-breakdown card is
    // role-hidden — which it is for every non-posting role, i.e. for exactly the roles roiSource
    // serves. A branch placed after that guard is a branch that never runs.
    const js = src('assistants.js');
    const fn = js.slice(js.indexOf('async function _fetchAndRenderAssistantMetrics('));
    const branch = fn.indexOf("roiStrip.dataset.roiSource === 'lead'");
    const guard = fn.indexOf("card.dataset.roleHidden === '1'");
    assert.ok(branch > -1, 'the lead ROI branch is gone');
    assert.ok(guard > -1, 'the post-role guard is gone — this check no longer measures anything');
    assert.ok(branch < guard, 'the roiSource branch must come before the post-role early return');
});

check('applying the registry clears roleHidden on the strip, not just the class', () => {
    // The fetch re-checks `roleHidden` after its await and would re-hide the strip underneath us.
    const js = src('assistants.js');
    const at = js.indexOf('const roiStripNode');
    assert.ok(at > -1, 'the registry no longer reveals the strip for a roiSource role');
    const block = js.slice(at, at + 600);
    assert.ok(/delete roiStripNode\.dataset\.roleHidden/.test(block),
        'the dataset flag is not cleared — the async fetch will re-hide the strip');
    assert.ok(/dataset\.roiSource = cfg\.roiSource/.test(block), 'the source is never stamped on the strip');
    assert.ok(/delete roiStripNode\.dataset\.roiSource/.test(block),
        'switching to a role WITHOUT a roiSource must clear the stamp — this page is reused across '
        + 'assistants without a reload');
});

check('the strip says the figure is an ESTIMATE, on screen', () => {
    // Nothing in the platform times a human doing this work by hand. That is why "Hours Reclaimed"
    // was struck off this role's four KPI cards, and it is why this may only ship labelled.
    const js = src('assistants.js');
    const fn = js.slice(js.indexOf('async function _fetchAndRenderLeadRoi('), js.indexOf('async function _fetchAndRenderAssistantMetrics('));
    assert.ok(/Estimated effort & money saved/.test(fn), 'the caption no longer says the figure is estimated');
    assert.ok(/Estimated across \$\{d\.items\}/.test(fn), 'the sub-line no longer says how many jobs it is estimating over');
    assert.ok(/workings/.test(fn), 'the workings tooltip is gone — the number can no longer be checked');
});

check('the post-based path resets the heading it does not own', () => {
    // The lead branch rewrites "Time Saved" to "Effort Saved", and assistant-detail.html is reused
    // across assistants without a reload. Without the reset, a Social Media Manager opened after a
    // Lead Generator shows "Effort Saved" over a post-drafting figure.
    const js = src('assistants.js');
    const fn = js.slice(js.indexOf('async function _fetchAndRenderAssistantMetrics('));
    assert.ok(/hoursLabel\.textContent = 'Time Saved'/.test(fn),
        'the post-based branch no longer restores its own heading');
});

check('the endpoint degrades rather than 500ing, and only on a missing TABLE', () => {
    const fn = src('netlify/functions/get-lead-roi.ts');
    // ⚠️ 42P01 (undefined_table) only. 42703 (undefined_column) is almost always a bug in the query
    // and must stay loud — swallowing it turns a broken aggregate into a confident, silent zero.
    assert.ok(/code === '42P01'/.test(fn), 'the migration-gap branch is gone');
    // Comment-stripped: the file NAMES 42703 in the comment explaining why it is excluded, and a
    // scan over the prose would fail on the very sentence that documents the rule — which teaches
    // you to delete the comment. Same trap the lead-threads suite calls out with codeOnly().
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/42703/.test(code), 'a missing COLUMN must not be swallowed as a migration gap');
    // drizzle rethrows every query failure as "Failed query: …" and puts the real error on `cause`.
    assert.ok(/\.cause/.test(fn), 'the error handler reads message alone — the real failure is on cause');
});

console.log(`\n${passed} checks passed.`);
