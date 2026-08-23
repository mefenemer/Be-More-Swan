// tests/discovery-territory-sweep.test.ts
// A campaign must remember which territories it has already worked.
//
// ── The problem this closes ──────────────────────────────────────────────────
// Splitting South East England into 58 districts produces ~174 queries. No single run executes
// that: it stops at a lead cap, a search budget or a token budget. And until now the NEXT run
// began from a freshly generated plan — so the same handful of territories were worked over and
// over while the rest were never looked at once. 4,530 schools were not out of reach because
// search cannot find them; they were out of reach because nothing remembered where the last run
// had got to.
//
// Three properties hold this together, and each has a way of failing silently:
//   1. Continuation is DETERMINISTIC — no model call, or the plan drifts between runs.
//   2. Progress is banked only for territories actually SEARCHED, or a capped run retires ground
//      nobody looked at.
//   3. The slice fits the run's budget, or a run stops mid-territory and repeats it forever.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTerritoryPlan, remainingTerritories, nextSlice, territoriesWorked, type TerritoryPlan } from '../src/config/territory-plan';
import { expandQueryAcrossTerritories, expansionAnchor } from '../src/lib/territory-split';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nDiscovery territory sweep\n');

const PLAN: TerritoryPlan = {
    area: 'South East England excluding Essex',
    basis: 'districts',
    granularity: 'fine',
    parents: ['Kent'],
    territories: ['Ashford', 'Canterbury', 'Dartford', 'Dover', 'Maidstone', 'Sevenoaks', 'Swale', 'Thanet'],
    covered: ['Ashford', 'Canterbury'],
    templates: { niche_scrape: 'primary school Ashford', intent_signal: null, footprint: 'primary school Ashford -inurl:jobs' },
};

// ── Remaining work ─────────────────────────────────────────────────────────────────────────────

check('covered territories are excluded, case-insensitively', () => {
    assert.deepStrictEqual(remainingTerritories(PLAN), ['Dartford', 'Dover', 'Maidstone', 'Sevenoaks', 'Swale', 'Thanet']);
    assert.deepStrictEqual(
        remainingTerritories({ ...PLAN, covered: ['ashford', 'CANTERBURY'] }).length, 6,
        'casing must not resurrect finished ground',
    );
});

check('a finished sweep has nothing left', () => {
    assert.deepStrictEqual(remainingTerritories({ ...PLAN, covered: [...PLAN.territories] }), []);
    assert.deepStrictEqual(nextSlice({ ...PLAN, covered: [...PLAN.territories] }, { maxSearchCalls: 500, maxPagesPerQuery: 4 }), []);
});

// ── Slice sizing ───────────────────────────────────────────────────────────────────────────────

check('the slice is sized from the run\'s own search budget', () => {
    // Two templates x 4 pages = 8 searches per territory; 80% of 500 is 400; 400/8 = 50 — more
    // than remain, so it takes all six.
    assert.strictEqual(nextSlice(PLAN, { maxSearchCalls: 500, maxPagesPerQuery: 4 }).length, 6);
    // 80% of 100 is 80; 80/8 = 10 → still all six.
    assert.strictEqual(nextSlice(PLAN, { maxSearchCalls: 100, maxPagesPerQuery: 4 }).length, 6);
    // 80% of 24 is 19; 19/8 = 2.
    assert.deepStrictEqual(nextSlice(PLAN, { maxSearchCalls: 24, maxPagesPerQuery: 4 }), ['Dartford', 'Dover']);
});

check('a budget too small for one territory still makes progress', () => {
    // ⚠️ Returning [] here would stall the campaign permanently — it would never mark anything
    // covered, so it would re-plan the same nothing on every run.
    assert.deepStrictEqual(nextSlice(PLAN, { maxSearchCalls: 1, maxPagesPerQuery: 4 }), ['Dartford']);
});

check('a plan with no usable templates yields no slice', () => {
    const empty = { ...PLAN, templates: { niche_scrape: null, intent_signal: null, footprint: null } };
    assert.deepStrictEqual(nextSlice(empty, { maxSearchCalls: 500, maxPagesPerQuery: 4 }), []);
});

// ── Reading it back off jsonb ──────────────────────────────────────────────────────────────────

check('a well-formed plan round-trips', () => {
    const back = readTerritoryPlan({ territoryPlan: PLAN });
    assert.ok(back);
    assert.deepStrictEqual(back.territories, PLAN.territories);
    assert.deepStrictEqual(back.covered, PLAN.covered);
    assert.strictEqual(back.templates.niche_scrape, 'primary school Ashford');
    assert.strictEqual(back.templates.intent_signal, null);
});

check('junk degrades to null rather than a half-built plan', () => {
    for (const bad of [null, undefined, 'nope', {}, { territoryPlan: null }, { territoryPlan: { territories: ['only one'] } }]) {
        assert.strictEqual(readTerritoryPlan(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

check('a missing covered list reads as nothing covered, not as a failure', () => {
    // Every plan starts this way — the first run has covered nothing.
    const back = readTerritoryPlan({ territoryPlan: { ...PLAN, covered: undefined } });
    assert.ok(back);
    assert.deepStrictEqual(back.covered, []);
});

// ── The worker's half ──────────────────────────────────────────────────────────────────────────

const WORKER = read('netlify/functions/process-discovery-jobs.ts');
const API = read('netlify/functions/discovery-campaigns.ts');

check('continuing a sweep makes NO model call', () => {
    // ⚠️ The territories and templates were approved by a human. Re-deriving them would reintroduce
    // exactly the non-determinism the stored plan exists to remove — the same idea has returned
    // 9, 10, 12, 13 and 18 areas on different calls.
    const i = WORKER.indexOf('const tPlan = readTerritoryPlan(campaign.approvedBrief);');
    assert.ok(i > 0, 'the worker must read the stored plan');
    const block = WORKER.slice(i, WORKER.indexOf('const gen = await generateQueries({', i));
    assert.match(block, /expandQueryAcrossTerritories\(template, tPlan\.area, slice/, 'substitution, not generation');
    assert.ok(!/generateQueries|anthropic/.test(block), 'the continuation path must not call a model');
});

check('a sweep run short-circuits before query generation', () => {
    // Falling through would pay for a generated plan and then discard it.
    const i = WORKER.indexOf('const tPlan = readTerritoryPlan(campaign.approvedBrief);');
    const block = WORKER.slice(i, WORKER.indexOf('const gen = await generateQueries({', i));
    assert.match(block, /return;/, 'the sweep branch must return, not fall through');
});

check('progress is banked per TERRITORY, not gated on the whole plan finishing', () => {
    // ⚠️ Gating on plan_complete was the first instinct and it does not survive a lead cap. A
    // district sweep plans ~99 queries per run; a 200-lead cap stops it around the 44th, so
    // plan_complete never fires, nothing is ever banked, and the sweep re-works its opening
    // territories forever while the rest are never reached.
    const i = WORKER.indexOf('markTerritoriesCovered(db, job.campaign_id');
    assert.ok(i > 0, 'the worker must bank progress somewhere');
    const guard = WORKER.slice(Math.max(0, i - 600), i);
    assert.match(guard, /territoriesWorked\(flat, nextIndex, cursor\.territorySlice\)/,
        'banking must be decided per territory');
    assert.ok(!/finalStopReason === 'plan_complete'/.test(guard),
        'the plan_complete gate is back — a capped sweep would never advance');
});

check('a territory whose queries all ran is banked', () => {
    const flat = [
        { query: 'primary school Ashford', page: 1 },
        { query: 'primary school Canterbury', page: 1 },
        { query: 'primary school Ashford contact', page: 1 },
        { query: 'primary school Canterbury contact', page: 1 },
    ];
    // Three of four ran: Ashford's both did, Canterbury's second did not.
    assert.deepStrictEqual(territoriesWorked(flat, 3, ['Ashford', 'Canterbury']), ['Ashford']);
});

check('ground the cursor never reached is never retired', () => {
    const flat = [{ query: 'primary school Ashford', page: 1 }, { query: 'primary school Dover', page: 1 }];
    assert.deepStrictEqual(territoriesWorked(flat, 0, ['Ashford', 'Dover']), [], 'nothing ran, nothing banked');
});

check('an unearned second page does not block a worked territory', () => {
    // Pages are appended AFTER the plan, so a territory whose first page ran has been searched.
    // Requiring its page 2 would stall the sweep for the same reason plan_complete did.
    const flat = [
        { query: 'primary school Ashford', page: 1 },
        { query: 'primary school Ashford', page: 2 },
    ];
    assert.deepStrictEqual(territoriesWorked(flat, 1, ['Ashford']), ['Ashford']);
});

check('a multi-word territory is matched whole', () => {
    const flat = [{ query: 'primary school Brighton and Hove', page: 1 }];
    assert.deepStrictEqual(territoriesWorked(flat, 1, ['Brighton and Hove']), ['Brighton and Hove']);
    // A different territory's name is not claimed by coincidence.
    assert.deepStrictEqual(territoriesWorked(flat, 1, ['Ashford']), []);
});

check('the matcher is word-boundary, and that boundary is documented', () => {
    // ⚠️ My first version of the check above asserted that a slice entry "Hove" would NOT match
    // "primary school Brighton and Hove". It does, and by the stated rule it should — "Hove" is a
    // whole word there. That is only ambiguous if one split returns both a name and a fragment of
    // another, which cannot happen: every entry comes from one enumeration of one area. Pinned so
    // the behaviour is a decision rather than a surprise.
    const flat = [{ query: 'primary school Brighton and Hove', page: 1 }];
    assert.deepStrictEqual(territoriesWorked(flat, 1, ['Hove']), ['Hove']);
    // Not a substring match, though: "Hov" is not a word.
    assert.deepStrictEqual(territoriesWorked(flat, 1, ['Hov']), []);
});

check('recording progress can never fail the run', () => {
    // Losing a stamp costs one repeated territory; throwing would lose the leads just banked.
    const fn = WORKER.slice(WORKER.indexOf('async function markTerritoriesCovered'));
    assert.match(fn.slice(0, 1600), /catch \(err\)/, 'the write must be swallowed on failure');
});

check('the territory slice rides on the cursor so the completion path knows what to bank', () => {
    assert.match(WORKER, /territorySlice\?: string\[\]/, 'the cursor must carry the slice');
    assert.match(WORKER, /territorySlice: slice/, 'and the sweep branch must set it');
});

// ── Persistence and surfacing ──────────────────────────────────────────────────────────────────

check('approving a split plan stores the territory memory', () => {
    assert.match(API, /territoryPlan: readTerritoryPlan\(\{ territoryPlan: body\.territoryPlan \}\)/,
        'approve_brief must persist the plan the user approved');
});

check('the expansion returns its templates, not just the expanded queries', () => {
    // Storing the expanded set would be storing an answer rather than a method: continuing into
    // Maidstone needs the shape of the question, not the copy that named Ashford.
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'approve_brief'"));
    assert.match(block, /templates\[key\] = list\[i\];/, 'the pre-expansion query must be captured');
    assert.match(block, /const territoryPlan: TerritoryPlan = \{/, 'the plan must be assembled');
    assert.match(block, /territoryPlan, slice \}\);/, 'and returned for approval alongside its first slice');
});

check('progress is exposed on both campaign reads', () => {
    const hits = API.split('territoriesCovered').length - 1;
    assert.ok(hits >= 3, `both selects and the mapper must carry progress (found ${hits})`);
});

// ── The screen ─────────────────────────────────────────────────────────────────────────────────

const UI = read('src/components/assistant-discovery-campaigns.js');

check('sweep progress is shown wherever coverage is', () => {
    // ⚠️ Without it, "stopped early" reads as a failure on EVERY run of a sweep — which is the
    // normal outcome by design — and the user learns to ignore the one line that tells them when
    // something is genuinely wrong.
    assert.strictEqual(UI.split('sweepLine(c)').length - 1, UI.split('coverageLine(c)').length - 1,
        'both surfaces must render the sweep line beside the coverage line');
});

check('a finished sweep says so rather than reporting 58 of 58', () => {
    const fn = UI.slice(UI.indexOf('function sweepLine(c) {'));
    assert.match(fn.slice(0, 900), /All \$\{total\} areas worked/);
});

check('a campaign that is not sweeping shows nothing', () => {
    const fn = UI.slice(UI.indexOf('function sweepLine(c) {'));
    assert.match(fn.slice(0, 400), /if \(!total\) return null;/);
});

check('the finer split re-derives instead of reusing the coarse one', () => {
    // The offered-equals-delivered rule only holds at the SAME granularity: the button the user
    // pressed was drawn from a COUNTY split, so sending it back would silently produce counties.
    assert.match(UI, /granularity === 'fine' \? null : \(state\.brief\?\.territorySplit \?\? null\)/);
});

check('approving carries the territory plan', () => {
    assert.match(UI, /territoryPlan: state\.brief\?\.territoryPlan \?\? null/,
        'without this the campaign forgets its sweep the moment it starts');
});

// ── The first run is the first LEG, not a one-off ──────────────────────────────────────────────

check('the expansion covers the first slice, not every territory', () => {
    // ⚠️ 58 districts x 3 strategies is 174 queries — more than one run executes and more than
    // anyone reads. Expanding all of them also seeded a first run that banked NO progress, so the
    // next run restarted at territory one and re-covered ground already worked.
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'approve_brief'"));
    assert.match(block, /const slice = nextSlice\(territoryPlan, \{/, 'the slice must be computed');
    assert.match(block, /expandQueryAcrossTerritories\(list\[i\], split\.area, slice/, 'and expanded across');
    assert.ok(!/expandQueryAcrossTerritories\(list\[i\], split\.area, split\.territories/.test(block),
        'expanding across every territory is back');
});

check('templates are chosen BEFORE the slice is sized', () => {
    // nextSlice sizes itself from how many templates exist, so the order is load-bearing.
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'approve_brief'"));
    assert.ok(block.indexOf('templates[key] = list[i];') < block.indexOf('const slice = nextSlice('),
        'templates must be resolved first, or the slice is sized from zero');
});

check('approving seeds the first job with its territory slice', () => {
    const block = API.slice(API.indexOf("action === 'approve_brief'"));
    assert.match(block.slice(0, 6000), /territorySlice: \(body\.slice as unknown\[\]\)/,
        'the first run must know which territories it is working');
});

check('the screen says a sweep spans several runs', () => {
    // A user who believes they approved all 58 areas will read the next "stopped early" notice as
    // a failure instead of the sweep working as designed.
    assert.match(UI, /Later runs continue with the rest/);
});

// ── The level ABOVE the territories ────────────────────────────────────────────────────────────
// ⚠️ Caught by predicting a live district split, not by any test written before it. The generator
// writes at county level ("primary school Berkshire") while a fine split's territories are
// districts, so with only districts as vocabulary the expansion did not recognise the county, fell
// through to its append branch, and produced "primary school Berkshire Ashford" — two areas, in
// different counties, in one paid search. About a third of a 111-query plan.
//
// The root cause both times has been the same: every earlier test drew the query and the territory
// list from the SAME split. Real plans cross granularities.

check('a county-level query expanded across DISTRICTS loses the county', () => {
    const out = expandQueryAcrossTerritories(
        'primary school Berkshire', 'South East England',
        ['Ashford', 'Canterbury'], ['Berkshire', 'Kent']);
    assert.deepStrictEqual(out, ['primary school Ashford', 'primary school Canterbury']);
});

check('the same holds with a suffix and with operators', () => {
    assert.deepStrictEqual(
        expandQueryAcrossTerritories('primary school Kent admissions enquiry', 'SE', ['Ashford'], ['Kent']),
        ['primary school Ashford admissions enquiry'],
    );
    assert.deepStrictEqual(
        expandQueryAcrossTerritories('primary school Berkshire -site:tes.com -inurl:jobs', 'SE', ['Ashford'], ['Berkshire']),
        ['primary school Ashford -site:tes.com -inurl:jobs'],
    );
});

check('without the parents it would append — the bug, pinned', () => {
    // Same call, parents omitted. Proves the fix is the vocabulary and not something incidental.
    assert.deepStrictEqual(
        expandQueryAcrossTerritories('primary school Berkshire', 'South East England', ['Ashford']),
        ['primary school Berkshire Ashford'],
    );
});

check('a county query becomes anchored once the parents are known', () => {
    // ⚠️ I described the pre-fix classification as `unknown`. It was `none` — with no district
    // matched there are no spans at all, so the "is there a stray place name in the residue" test
    // never runs. Either way pickExpansionSource could not help, because EVERY query in the plan
    // rated the same and it had nothing better to choose.
    assert.strictEqual(expansionAnchor('primary school Berkshire', 'SE', ['Ashford'], ['Berkshire']), 'territory');
    assert.strictEqual(expansionAnchor('primary school Berkshire', 'SE', ['Ashford']), 'none');
});

check('parents survive into the stored plan and the worker', () => {
    // A continuation run expands the same county-level templates across NEW districts, so it needs
    // the vocabulary the first run had.
    const back = readTerritoryPlan({ territoryPlan: PLAN });
    assert.deepStrictEqual(back?.parents, ['Kent']);
    assert.match(WORKER, /expandQueryAcrossTerritories\(template, tPlan\.area, slice, tPlan\.parents\)/);
    assert.match(API, /expandQueryAcrossTerritories\(list\[i\], split\.area, slice, split\.parents \?\? \[\]\)/);
});

console.log(`\n${passed} checks passed\n`);
