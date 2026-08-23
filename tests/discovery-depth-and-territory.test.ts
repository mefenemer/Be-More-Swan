// tests/discovery-depth-and-territory.test.ts
// Tier 3: actually reach more of the market, rather than describing how little was reached.
//
// Two independent levers, and they are not the same kind of thing:
//
//   DEPTH (pagination)  — a MULTIPLE. Reads past the first ten results of a query it already runs.
//   TERRITORY (split)   — an ORDER. "primary school kent surrey sussex" is one search against
//                         ~1,500 schools; one search per county asks a question a result set can
//                         actually answer. No amount of depth fixes a query aimed at a population
//                         three orders of magnitude larger than any page of results.
//
// ⚠️ Depth is EARNED, never planned: buying four pages for every query would be 75 searches whether
// or not any paid. And territory expansion is OFFERED, never automatic — it moves the binding limit
// and the bill, so it belongs on the screen the user is already reading.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePlanReach, RESULTS_PER_QUERY, MAX_PAGES_PER_QUERY, YIELD_TO_PAGINATE } from '../src/config/plan-reach';
import { expandQueryAcrossTerritories, expansionAnchor, pickExpansionSource, MAX_TERRITORIES } from '../src/lib/territory-split';
import { DEFAULT_MAX_LEADS_PER_RUN, DEFAULT_MAX_LEADS_PER_MONTH, DEFAULT_MAX_SEARCH_CALLS_PER_RUN } from '../src/config/discovery-limits';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nDiscovery depth and territory\n');

const WORKER = read('netlify/functions/process-discovery-jobs.ts');
const SEARCH = read('src/lib/discovery-search.ts');
const SPLIT = read('src/lib/territory-split.ts');
const UI = read('src/components/assistant-discovery-campaigns.js');
const API = read('netlify/functions/discovery-campaigns.ts');

// ── Depth: the search layer can now go past page one ───────────────────────────────────────────

check('the provider call accepts a page', () => {
    // Nothing in discovery paginated at all, so a market of thousands was only ever seen ten at a
    // time — and I had wrongly called that a limit of the search interface.
    assert.match(SEARCH, /page\?: number/, 'search() must take a page');
    assert.match(SEARCH, /\.\.\.\(page > 1 \? \{ page \} : \{\}\)/, 'page must reach the provider payload');
});

check('page 1 sends a byte-identical payload to before', () => {
    // ⚠️ An explicit page:1 is equivalent but not identical. Omitting it means pagination cannot
    // regress the path that has been running in production.
    assert.ok(!/page: 1/.test(SEARCH), 'page:1 must never be sent explicitly');
});

check('the per-call results ceiling is tunable without a deploy', () => {
    // It sat at 20 while the worker asked for 10 — the real constraint was ours, not the vendor's.
    // Left env-tunable rather than raised on faith: it has never been exercised against a live key.
    assert.match(SEARCH, /DISCOVERY_MAX_RESULTS_PER_CALL/, 'the ceiling must be env-tunable');
    assert.ok(!/Math\.min\(opts\.limit \?\? 10, 20\)/.test(SEARCH), 'the hardcoded 20 is back');
});

// ── Depth is earned, not planned ───────────────────────────────────────────────────────────────

check('the next page is bought only when this one paid', () => {
    const i = WORKER.indexOf('const yieldRate =');
    assert.ok(i > 0, 'the worker must measure per-page yield');
    assert.match(WORKER.slice(i, i + 300), /page < MAX_PAGES_PER_QUERY && yieldRate >= YIELD_TO_PAGINATE/,
        'depth must be gated on BOTH a page ceiling and a yield floor');
});

check('earned pages go to the END of the plan, preserving strategy interleaving', () => {
    // ⚠️ The plan interleaves three strategies so a budget cut still samples all of them. Splicing
    // depth in after the current entry would let one productive query eat the run before the other
    // two angles were tried even once.
    assert.match(WORKER, /extraPages\.push\(/, 'depth must be collected');
    assert.match(WORKER, /\[\.\.\.cursor\.flat, \.\.\.extraPages\]/, 'and appended, not spliced');
});

check('a grown plan is persisted on both exits', () => {
    // The completion path and the resume path both write the cursor. Depth earned on the last slice
    // of a run is worthless if only the resume path saves it.
    const writes = WORKER.split('flat,').length - 1;
    assert.ok(writes >= 2, `both cursor writes must carry the grown plan (found ${writes})`);
});

check('a cursor written before pagination still runs', () => {
    // Entries have no `page`. A required field would strand every in-flight run at deploy time.
    assert.match(WORKER, /page\?: number;/, 'the planned-query page must be optional');
    assert.match(WORKER, /Math\.max\(1, plannedPage \?\? 1\)/, 'a missing page must mean page 1');
});

// ── Reach reports a RANGE, because depth is conditional ────────────────────────────────────────

const DEFAULTS = {
    maxLeadsPerRun: DEFAULT_MAX_LEADS_PER_RUN,
    maxSearchCallsPerRun: DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
    maxLeadsPerMonth: DEFAULT_MAX_LEADS_PER_MONTH,
};

check('the schools plan now reports both a floor and a ceiling', () => {
    const r = computePlanReach(15, DEFAULTS);
    assert.strictEqual(r.searchesThatWillRun, 15, 'the floor is the plan as written');
    assert.strictEqual(r.searchesIfAllProductive, Math.min(15 * MAX_PAGES_PER_QUERY, DEFAULT_MAX_SEARCH_CALLS_PER_RUN));
    assert.ok(r.maxResultsReadIfAllProductive > r.maxResultsRead, 'depth must widen the ceiling');
});

check('depth cannot outrun the user\'s own search cap', () => {
    const r = computePlanReach(15, { ...DEFAULTS, maxSearchCallsPerRun: 20 });
    assert.strictEqual(r.searchesIfAllProductive, 20, 'a page spends a search like any other');
});

check('caps are reported against the DEEP figure, not the shallow one', () => {
    // ⚠️ A lead cap that only bites once depth is earned still bites. Measuring against the shallow
    // number would tell the user a cap will not affect them when it is what ends their run.
    const r = computePlanReach(2, DEFAULTS);
    assert.ok(r.maxResultsReadIfAllProductive >= r.maxLeadsBanked);
    assert.strictEqual(computePlanReach(15, DEFAULTS).bindingLimit, 'lead_cap');
});

check('the screen states the range rather than the floor alone', () => {
    // Quoting only the floor understates reach fourfold.
    assert.match(UI, /searchesIfAllProductive/, 'the reach block must render the ceiling');
    assert.match(UI, /go deeper on their own/, 'and explain that depth is conditional');
});

// ── Territory: the lever that changes the order of the answer ──────────────────────────────────

check('the model names territories but never writes the queries', () => {
    // ⚠️ Query strings carry -site:/-inurl: operators the pipeline depends on, and they are half of
    // what the user approved. A regenerated set would quietly drop or mangle them.
    assert.match(SPLIT, /export function expandQueryAcrossTerritories/, 'substitution must be in code');
    const fn = SPLIT.slice(SPLIT.indexOf('export function expandQueryAcrossTerritories'));
    assert.ok(!/anthropic|messages\.create/.test(fn), 'the expansion itself must not call a model');
});

check('substitution preserves search operators exactly', () => {
    const out = expandQueryAcrossTerritories(
        'primary school south east england -site:linkedin.com -inurl:jobs', 'south east england', ['Kent', 'Surrey']);
    assert.deepStrictEqual(out, [
        'primary school Kent -site:linkedin.com -inurl:jobs',
        'primary school Surrey -site:linkedin.com -inurl:jobs',
    ]);
});

// ── The bug a live plan walked into ────────────────────────────────────────────────────────────
// ⚠️ The generator had ALREADY sliced geographically, so the first query of each group read
// "primary school Surrey" while the area was "South East England excluding Essex". Neither
// matched, every expansion fell to append, and the plan would have contained
// "primary school Surrey Kent" (two counties) and "primary school Surrey Surrey" (noise) — about a
// third of it nonsense, one paid search each. The original tests passed because they exercised
// substitution and append in isolation and never asked what append does to a query that already
// names a DIFFERENT territory.

check('a query that already names a county has it REPLACED, never appended to', () => {
    const out = expandQueryAcrossTerritories('primary school Surrey', 'South East England excluding Essex',
        ['Kent', 'Surrey', 'Hampshire']);
    assert.deepStrictEqual(out, ['primary school Kent', 'primary school Surrey', 'primary school Hampshire']);
    for (const q of out) {
        assert.ok(!/Surrey \w/.test(q) || q === 'primary school Surrey', `two counties in one query: ${q}`);
    }
});

check('a query naming SEVERAL counties keeps exactly one', () => {
    // ⚠️ The full territory set, as a real split supplies. My first version passed ['Surrey','Kent']
    // and asserted Hampshire vanished — it did not, and should not have: a territory the split never
    // enumerated is one this function has never heard of. The honest fix for THAT case is not to
    // expand such a query at all (see the anchor tests below).
    const out = expandQueryAcrossTerritories(
        'primary school Kent Hampshire -site:tes.com -inurl:careers', 'South East England',
        ['Surrey', 'Kent', 'Hampshire']);
    assert.deepStrictEqual(out, [
        'primary school Surrey -site:tes.com -inurl:careers',
        'primary school Kent -site:tes.com -inurl:careers',
        'primary school Hampshire -site:tes.com -inurl:careers',
    ]);
});

check('the short form of a compound county is recognised', () => {
    // The generator writes "Sussex"; the register says "East Sussex". Without the short form the
    // query looks unanchored and gets a second county bolted on.
    const out = expandQueryAcrossTerritories('primary school Sussex', 'South East England', ['Kent', 'East Sussex']);
    assert.deepStrictEqual(out, ['primary school Kent', 'primary school East Sussex']);
});

check('a compound name does not donate a misleading short form', () => {
    // "Brighton and Hove" must not contribute "Hove", and "Isle of Wight" must not contribute
    // "Wight", as though either were the county itself.
    const out = expandQueryAcrossTerritories('primary school Hove', 'South East England', ['Kent', 'Brighton and Hove']);
    assert.ok(out.every((q) => q.includes('Hove ') || q.endsWith('Hove')), 'Hove must be treated as unanchored text');
});

check('lowercase county names are matched too', () => {
    // The live prod campaign wrote "primary school kent surrey sussex" in lower case.
    const out = expandQueryAcrossTerritories('primary school kent surrey sussex', 'South East England',
        ['Hampshire', 'Kent', 'Surrey', 'East Sussex']);
    assert.strictEqual(out[0], 'primary school Hampshire', 'all three lowercase counties must be stripped');
    // Assert the SUBSTANCE — exactly one county per query — not the word count. "East Sussex" is
    // two words, so a length check fails on a correct result.
    for (const q of out) {
        const named = ['Hampshire', 'Kent', 'Surrey', 'Sussex'].filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(q));
        assert.strictEqual(named.length, 1, `expected exactly one county in "${q}", found ${named.join(' + ')}`);
    }
});

check('an exclusion clause does not stop the area matching', () => {
    // "South East England excluding Essex" never appears verbatim in a query that says
    // "south east England" — which is exactly why everything fell through to append.
    const out = expandQueryAcrossTerritories(
        'primary school "head teacher" contact south east England', 'South East England excluding Essex', ['Kent']);
    assert.deepStrictEqual(out, ['primary school "head teacher" contact Kent']);
});

check('repeated territories are not paid for twice', () => {
    // My first version of this asserted that 'primary school Kent Surrey' with territories
    // ['Kent','Kent'] collapses to one query. It does not, and should not: Surrey is not in that
    // territory list, so the function has never heard of it and correctly leaves it alone. Only
    // territories the split actually named are stripped — a limitation worth stating, and harmless
    // in practice because a real split enumerates every county in the area.
    const out = expandQueryAcrossTerritories('primary school Surrey', 'South East England', ['Kent', 'Kent', 'Surrey']);
    assert.deepStrictEqual(out, ['primary school Kent', 'primary school Surrey'], 'the duplicate must collapse');
});

// ── The residual gap, handled by choosing WHICH query to expand ───────────────────────────────
// Substitution can only strip territories the split enumerated. A query naming a place outside
// that list keeps it, and the two-county bug returns by the back door. Rather than pretend a
// gazetteer is available, the caller picks a query the substitution handles exactly.

check('a query naming an unenumerated place is classified as unsafe to expand', () => {
    assert.strictEqual(expansionAnchor('primary school Kent Medway', 'South East England', ['Kent', 'Surrey']), 'unknown');
});

check('anchors are ranked area > territory > none', () => {
    const T = ['Kent', 'Surrey'];
    assert.strictEqual(expansionAnchor('primary school south east England', 'South East England', T), 'area');
    assert.strictEqual(expansionAnchor('primary school Kent', 'South East England', T), 'territory');
    assert.strictEqual(expansionAnchor('primary school admissions email', 'South East England', T), 'none');
});

check('operators and quoted phrases are not mistaken for places', () => {
    // -site:Tes.com and a quoted "Head Teacher" must not read as an unenumerated county.
    assert.strictEqual(
        expansionAnchor('primary school Kent "Head Teacher" -site:Tes.com', 'South East England', ['Kent']),
        'territory',
    );
});

check('the cleanest query in a group is the one expanded', () => {
    // The live plan: the first query named a county, a later one named the area. The area one is
    // the unambiguous substitution, so it wins despite not being first.
    const group = ['primary school Kent Medway', 'primary school contact south east England', 'primary school Surrey'];
    assert.strictEqual(pickExpansionSource(group, 'South East England excluding Essex', ['Kent', 'Surrey']), 1);
});

check('the API picks the source rather than taking list[0]', () => {
    const block = API.slice(API.indexOf("action === 'expand_territories'"));
    assert.match(block.slice(0, 3600), /pickExpansionSource\(list, split\.area, split\.territories\)/);
    assert.ok(!/expandQueryAcrossTerritories\(list\[0\]/.test(block.slice(0, 3600)), 'list[0] must no longer be forced');
});

check('a query that does not name the area still becomes territory-specific', () => {
    // Append survives as the LAST resort — the one case where adding a territory cannot contradict
    // anything already in the query.
    const out = expandQueryAcrossTerritories('primary school contact -inurl:blog', 'nowhere', ['Kent']);
    assert.strictEqual(out[0], 'primary school contact -inurl:blog Kent', 'the territory must be appended');
});

check('an empty territory list leaves the query untouched', () => {
    assert.deepStrictEqual(expandQueryAcrossTerritories('primary school kent', 'kent', []), ['primary school kent']);
    assert.deepStrictEqual(expandQueryAcrossTerritories('', 'kent', ['Kent']), []);
});

check('one territory is not a split', () => {
    // It is the same query wearing a hat, and offering it spends a model call to say nothing.
    assert.match(SPLIT, /if \(territories\.length < 2\) return null;/);
});

check('the split respects an exclusion in the idea', () => {
    assert.match(SPLIT, /excluding Essex/, 'the prompt must be explicit that exclusions bind');
});

check('the number of territories is bounded', () => {
    assert.ok(MAX_TERRITORIES > 0 && MAX_TERRITORIES <= 60, 'a split must not become a bill');
    assert.match(SPLIT, /\.slice\(0, MAX_TERRITORIES\)/, 'the cap must be enforced in code, not just asked for');
});

// ── Expansion is offered, never applied ────────────────────────────────────────────────────────

check('expanding saves nothing and returns a plan to review', () => {
    const i = API.indexOf("action === 'expand_territories'");
    assert.ok(i > 0, 'the action must exist');
    // Bounded at the next action so the window cannot silently fall short of the block as it grows —
    // an off-by-a-few slice is how a source-scan test starts passing for the wrong reason.
    const block = API.slice(i, API.indexOf("action === 'approve_brief'", i));
    assert.ok(block.length > 500, 'the expand_territories block must be found in full');
    assert.ok(!/db\.update\(discoveryCampaigns\)/.test(block), 'expansion must not persist anything');
    assert.match(block, /computePlanReach\(flat\.length/, 'and must re-report reach for the bigger plan');
});

check('exactly one query per strategy is expanded, and the rest kept unless duplicated', () => {
    // 15 queries x 18 counties is 270 searches — a plan nobody can read and a bill nobody sanctioned.
    //
    // ⚠️ This used to assert the leftovers were kept VERBATIM, which is precisely the bug found on
    // the live deploy: expanding across Kent reproduces "primary school Kent", and keeping the
    // original too meant paying twice. The assertion described the defect and passed.
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'approve_brief'"));
    assert.match(block, /const expanded = expandQueryAcrossTerritories\(list\[i\], split\.area, split\.territories\);/,
        'one query per strategy is expanded');
    assert.match(block, /expandedQueries\[key\] = \[\.\.\.expanded, \.\.\.leftovers\];/,
        'the deduped leftovers follow the expansion');
});

check('the expansion uses the EDITED plan, not a regenerated one', () => {
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'expand_territories'") + 1600);
    assert.match(block, /body\.queries/, 'it must read the queries from the request');
    assert.ok(!/generateQueries\(/.test(block), 'regenerating would discard the user\'s edits');
});

check('the offer is a button, not a side effect', () => {
    assert.match(UI, /data-dc-split/, 'the split must be user-triggered');
    assert.match(UI, /state\.territoriesApplied = false;/, 'and its banner must reset with a fresh brief');
});

check('both advisory calls fail soft', () => {
    // They run while the user waits on the brief screen; neither is a gate.
    assert.match(SPLIT, /catch \(err\)/);
    assert.match(SPLIT, /!process\.env\.ANTHROPIC_API_KEY/, 'a missing key must short-circuit');
});

// ── What you are offered is what runs ─────────────────────────────────────────────────────────
// Found by pressing the button on a real deploy: it said "Split into 9 areas" and delivered 12.
// generate_brief called splitTerritories to draw the button, expand_territories called it AGAIN,
// and the call is non-deterministic — the same idea has returned 18, 10, 9 and 12.

check('the expansion uses the split the BRIEF offered, not a fresh one', () => {
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'approve_brief'"));
    assert.match(block, /body\.territorySplit/, 'the client-supplied split must be read');
    assert.match(block, /offeredTerritories\.length >= 2/, 'and preferred over a fresh call');
    assert.match(block, /: await splitTerritories\(campaign\.idea\)/, 'with a fallback for older callers');
});

check('the client sends the split its button was drawn from', () => {
    const call = UI.slice(UI.indexOf("call('expand_territories'"), UI.indexOf("call('expand_territories'") + 500);
    assert.match(call, /territorySplit: state\.brief\?\.territorySplit/, 'the brief\'s own split must be sent back');
});

// ── No paying twice for the same query ────────────────────────────────────────────────────────
// Also found on the live deploy: group one held twelve expanded queries and then kept
// "primary school Kent", "primary school Hampshire" and "primary school Berkshire" verbatim —
// each already produced by the expansion. Three paid searches for results already fetched.

check('leftovers duplicating the expansion are dropped', () => {
    const block = API.slice(API.indexOf("action === 'expand_territories'"), API.indexOf("action === 'approve_brief'"));
    assert.match(block, /new Set\(expanded\.map\(\(q\) => q\.toLowerCase\(\)\)\)/, 'the expansion must be indexed');
    assert.match(block, /!seen\.has\(q\.trim\(\)\.toLowerCase\(\)\)/, 'and leftovers filtered against it');
    // ⚠️ The old assertion — "the rest of the plan must be kept verbatim" — described exactly the
    // behaviour that caused this, and passed while being wrong.
    assert.ok(!/\.\.\.list\.filter\(\(_, n\) => n !== i\)/.test(block), 'unfiltered leftovers are back');
});

check('both reach calculations know how much of the month is spent', () => {
    // generate_brief passed leadsThisMonth and expand_territories did not, so the expanded plan
    // reported a full monthly allowance while the un-expanded one knew better.
    const uses = API.match(/leadsThisMonth: Number\(/g) ?? [];
    assert.strictEqual(uses.length, 2, `both brief paths must pass it (found ${uses.length})`);
});

// ── Review plan reaches the Searches tab ──────────────────────────────────────────────────────

check('the Searches tab can review a plan before spending on it', () => {
    const inbox = read('src/components/assistant-signal-inbox.js');
    assert.match(inbox, /data-si-plan/, 'the tab must offer the button');
    assert.match(inbox, /manageSearch\('openPlan', b, 'data-si-plan'\)/, 'wired through the shared delegate');
});

check('openPlan is exported and raises the overlay before drawing the brief', () => {
    // ⚠️ openBrief writes into [data-dc-body], which only exists once the modal is mounted —
    // calling it from another tab without raising the overlay first is a silent no-op.
    assert.match(UI, /window\.AssistantDiscoveryCampaigns = \{[^}]*openPlan/, 'openPlan must be public');
    assert.match(UI, /openOverlay\(\(\) => openBrief\(campaignId\)\)/, 'the overlay must be raised first');
});

check('reviewing a plan closes the results modal, like the other mutating actions', () => {
    // It can end in "Approve & start searching", which changes what an open results list means.
    const inbox = read('src/components/assistant-signal-inbox.js');
    assert.match(inbox, /if \(method !== 'openView'\) closeResults\(\);/);
});

console.log(`\n${passed} checks passed\n`);
