// tests/campaign-paid-gaps.test.ts
// The three things the paid rails shipped without, and what closing each one had to get right.
//
//   1. THE COST CEILING. The optimiser's cost-per-outcome rule existed and was tested from the day
//      it was written, and had never once fired — the cron passed a hard-coded null because there
//      was no column to read. Half the kill switch was dark.
//   2. THE AD-ACCOUNT PICKER. `metadata.selectedAccountUrn` was written as null and nothing set it,
//      so nothing could be staged at all.
//   3. TARGETING. `targetingCriteria` went up EMPTY. LinkedIn rejects a campaign with no location
//      facet, so every staging attempt would have failed at the API with an opaque error — the
//      flow could not have worked end to end even with everything else correct.
//
// Run:  npx tsx tests/campaign-paid-gaps.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    COMPANY_SIZES, FALLBACK_GEOS, INCOMPATIBLE_WITH_FUNCTION_OR_SENIORITY, TARGETING_FACETS,
    buildTargetingCriteria, campaignGroupName,
} from '../src/utils/ad-networks/linkedin';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const api = read('netlify/functions/campaigns.ts');
const cron = read('netlify/functions/optimise-paid-campaigns.ts');
const ui = read('src/components/assistant-campaigns.js');
const ddl = read('db/campaign-cost-ceiling.sql');
const lk = read('src/utils/ad-networks/linkedin.ts');
const stage = api.slice(landmark(api, "if (action === 'stage_paid')"), landmark(api, "if (action === 'approve_launch')"));

console.log('\n──── 1. the cost ceiling is the CUSTOMER\'s number, or none ────');

check('the column is nullable, and null means no ceiling', () => {
    // ⚠️ Any default we picked would be us deciding what a customer's lead is worth — and being
    // wrong in the expensive direction quietly pauses ads that were working.
    assert.match(ddl, /ADD COLUMN IF NOT EXISTS max_cost_per_outcome_gbp NUMERIC\(10,2\);/);
    assert.ok(!/NOT NULL/.test(ddl.replace(/--[^\n]*/g, '')), 'the ceiling column is NOT NULL');
    assert.match(read('db/schema.ts'), /maxCostPerOutcomeGbp: numeric\("max_cost_per_outcome_gbp"/);
});

check('zero is refused at the database AND the boundary', () => {
    // A ceiling of £0 pauses every variant on its first conversion. That is a typo, not a setting.
    assert.match(ddl, /max_cost_per_outcome_gbp IS NULL OR max_cost_per_outcome_gbp > 0/);
    assert.match(stage, /ceiling <= 0/);
    assert.match(stage, /has to be more than £0/);
});

check('a blank ceiling stores NULL, never 0', () => {
    assert.match(stage, /let maxCostPerOutcomeGbp: string \| null = null;/);
    assert.match(code(ui), /maxCostPerOutcomeGbp: ceilingRaw === '' \? undefined : Number\(ceilingRaw\)/);
});

check('the cron now READS it — the rule is finally live', () => {
    // The line this whole gap was about.
    assert.match(code(cron), /campaignBudgets\.maxCostPerOutcomeGbp/);
    assert.match(code(cron), /maxCostPerOutcomeGbp: ceiling,/);
});

check('the daily budget is never used as the ceiling', () => {
    // ⚠️ The tempting shortcut, and the one that would make the agent invent what a lead is worth.
    assert.ok(!/maxCostPerOutcomeGbp:\s*(dailyBudget|budget\.maxSpendGbp|maxSpendGbp)/.test(code(cron)));
    assert.ok(!/maxCostPerOutcomeGbp:\s*(dailyBudget|maxSpendGbp)/.test(code(stage)));
});

check('the surface says which rules are actually running', () => {
    // "No limit set" is a fact about the customer's money. Silence would leave them assuming a
    // cost rule is protecting them when none is.
    assert.match(ui, /No cost limit is set, so ads are only paused when their click-through/);
    assert.match(ui, /We will pause any ad costing more than/);
    assert.match(ui, /st\.maxCostPerOutcomeGbp != null/);
});

console.log('\n──── 2. the account picker, where the decision is needed ────');

check('the picker is inline, not a link to a shared grid', () => {
    // ⚠️ The connections grid is shared by every assistant role. Putting an org-level ads
    // connection in it would have meant widening connection-map — a fail-open surface where a
    // mistake hands a role every connector in the product.
    assert.match(ui, /data-cmp-account-select/);
    assert.match(ui, /action: 'select', accountUrn: urn/);
    assert.ok(!/href="\/integrations\.html"/.test(ui), 'the picker regressed to a link out');
});

check('accounts are only fetched when the workspace could use one', () => {
    // No point asking LinkedIn about a workspace whose plan does not include advertising.
    assert.match(code(ui), /state\.paid\.featureEnabled && state\.paid\.anyNetwork/);
    assert.match(code(ui), /&& state\.adAccounts === null\) loadAdAccounts\(\)/);
});

check('a saved selection reloads from the server rather than guessing', () => {
    const branch = ui.slice(landmark(ui, "action: 'select', accountUrn: urn"), landmark(ui, 'if (facetRm)'));
    assert.match(branch, /await load\(\);/);
});

console.log('\n──── 3. targeting: mandatory, and never invented ────');

check('a campaign with no location is REFUSED, with a sentence', () => {
    // ⚠️ LinkedIn rejects it anyway — but as an opaque 400 at the end of a filled-in form. This is
    // the difference between "choose where these ads run" and a third party's error code.
    assert.throws(() => buildTargetingCriteria({ locations: [] }), /at least one location/);
    assert.throws(() => buildTargetingCriteria({}), /at least one location/);
    assert.match(stage, /buildTargetingCriteria\(\{/);
    assert.match(ui, /LinkedIn will not run an advert without at least one location/);
});

check('targetingCriteria is neither SENT nor STORED empty', () => {
    // Two places, and the second is easy to miss: the payload to LinkedIn, and the local
    // ad_variants.targeting column — the only record that can answer "why did this ad run in
    // Germany" after the fact, since Campaign Manager's copy is editable and a deleted campaign
    // takes its targeting with it.
    assert.ok(!/targeting: \{\}/.test(code(stage)), 'empty targeting is still being written');
    assert.equal((code(stage).match(/targeting: targetingCriteria,/g) || []).length, 2,
        'expected the real criteria in BOTH the LinkedIn payload and the stored row');
});

check('the criteria shape is AND-of-ORs, as LinkedIn expects', () => {
    const c = buildTargetingCriteria({
        locations: ['urn:li:geo:101165590'],
        seniorities: ['urn:li:seniority:1', 'urn:li:seniority:2'],
    }) as any;
    assert.ok(Array.isArray(c.include.and));
    // Locations AND seniorities narrows; two seniorities within one group widens.
    assert.equal(c.include.and.length, 2);
    assert.deepEqual(c.include.and[0].or[TARGETING_FACETS.locations], ['urn:li:geo:101165590']);
    assert.equal(c.include.and[1].or[TARGETING_FACETS.seniorities].length, 2);
});

check('an empty optional facet adds no group at all', () => {
    // An empty OR group would match nothing and silently kill the campaign's reach.
    const c = buildTargetingCriteria({ locations: ['urn:li:geo:1'], jobFunctions: [], seniorities: [] }) as any;
    assert.equal(c.include.and.length, 1);
});

check('targeting values are looked up LIVE, not shipped as a list', () => {
    // ⚠️ A wrong geo URN does not error — it targets somewhere else and spends the customer's
    // money there. Only LinkedIn can map a URN to a name.
    const t = read('netlify/functions/linkedin-ads-targeting.ts');
    assert.match(t, /searchTargeting\(/);
    assert.match(read('src/utils/ad-networks/linkedin.ts'), /adTargetingEntities\?\$\{params/);
    // The only two URNs in the codebase, both documented as verified.
    assert.equal(FALLBACK_GEOS.length, 2);
    assert.ok(FALLBACK_GEOS.every((g) => /^urn:li:geo:\d+$/.test(g.urn)));
});

check('the fallback list is LOCATIONS ONLY and is labelled as a fallback', () => {
    // ⚠️ Falling back on a job title or seniority would mean offering a list we invented. An empty
    // result for those is honest; a fabricated one spends money on the wrong audience.
    const t = read('netlify/functions/linkedin-ads-targeting.ts');
    assert.match(t, /if \(facet === 'locations'\) \{\s*\n\s*return json\(200, \{ entities: FALLBACK_GEOS, fallback: true \}\)/);
    assert.match(t, /return json\(200, \{ entities: \[\], fallback: true \}\)/);
    // And the client must SAY so, or a short list reads as LinkedIn's real answer.
    assert.match(ui, /We could not reach LinkedIn, so this is a short list/);
});

check('each variant can have its own destination, defaulting to the first', () => {
    // Three identical URLs is the common case; making someone paste the same thing three times to
    // A/B a headline is a tax on the thing we are asking them to do.
    assert.match(code(ui), /destinationUrl: url\(i\) \|\| firstUrl/);
    assert.match(ui, /data-cmp-paid-url="\$\{esc\(String\(c\.id\)\)\}-\$\{i\}"/);
    // The server has always accepted per-variant URLs and validates every one of them.
    assert.match(stage, /isSafeDestination\(v\.destinationUrl\)/);
});

console.log('\n──── job function, seniority and company size ────');

check('the job-function facet is jobFunctions, NOT titles', () => {
    // ⚠️ A REAL BUG CAUGHT BEFORE SHIPPING. The first draft used
    // `urn:li:adTargetingFacet:titles`, a DIFFERENT facet taking urn:li:title:N. It would have
    // worked — silently targeting job titles while the form said "job function". A wrong facet
    // does not error; it spends the money on the wrong audience.
    assert.equal(TARGETING_FACETS.jobFunctions, 'urn:li:adTargetingFacet:jobFunctions');
    assert.equal(TARGETING_FACETS.seniorities, 'urn:li:adTargetingFacet:seniorities');
    assert.equal(TARGETING_FACETS.companySizes, 'urn:li:adTargetingFacet:staffCountRanges');
});

check('no job-TITLE picker is offered, because it cannot be AND-ed with these', () => {
    // ⚠️ LinkedIn: job functions and seniorities "may not be AND'ed with any include clauses
    // targeting Job Titles". buildTargetingCriteria ANDs every facet group, so a titles picker
    // would make most combinations invalid — rejected by LinkedIn as an opaque 400 at staging.
    assert.ok(!Object.values(TARGETING_FACETS).some((f) => INCOMPATIBLE_WITH_FUNCTION_OR_SENIORITY.includes(f as never)),
        'an incompatible titles facet has been added to the offered set');
    assert.ok(INCOMPATIBLE_WITH_FUNCTION_OR_SENIORITY.length >= 3, 'the incompatibility list lost entries');
    // And the constraint is written where someone adding a picker will see it.
    assert.match(read('src/utils/ad-networks/linkedin.ts'), /may not be AND'ed with any include\s*\n\s*\* clauses targeting Job Titles/);
});

check('all four facets reach the criteria builder', () => {
    const c = buildTargetingCriteria({
        locations: ['urn:li:geo:101165590'],
        jobFunctions: ['urn:li:function:22'],
        seniorities: ['urn:li:seniority:7'],
        companySizes: ['urn:li:staffCountRange:(51,200)'],
    }) as any;
    assert.equal(c.include.and.length, 4);
    assert.deepEqual(c.include.and[3].or[TARGETING_FACETS.companySizes], ['urn:li:staffCountRange:(51,200)']);
});

check('company sizes are a documented enum, served without a lookup', () => {
    // A closed set with no typeahead behind it, and a format nobody could be expected to type.
    assert.equal(COMPANY_SIZES.length, 9);
    assert.ok(COMPANY_SIZES.every((c) => /^urn:li:staffCountRange:\(\d+,\d+\)$/.test(c.urn)));
    // INT_MAX is LinkedIn's "no upper limit".
    assert.ok(COMPANY_SIZES.some((c) => c.urn.includes('2147483647')));
    const t = read('netlify/functions/linkedin-ads-targeting.ts');
    assert.match(t, /if \(facet === 'companySizes'\) return json\(200, \{ entities: COMPANY_SIZES \}\)/);
    assert.ok(landmark(t, "facet === 'companySizes'") < landmark(t, 'await searchTargeting('),
        'company sizes are being sent to a typeahead that has nothing to return');
});

check('only the location picker nags when empty', () => {
    // Saying "optional" and then warning about it being empty would be the form contradicting
    // itself.
    assert.match(ui, /required: true, search: true,/);
    assert.match(code(ui), /f\.required\s*\n\s*\? '<p[^']*without at least one location/);
});

check('the client sends every facet, not just locations', () => {
    assert.match(code(ui), /jobFunctions: urns\('jobFunctions'\)/);
    assert.match(code(ui), /seniorities: urns\('seniorities'\)/);
    assert.match(code(ui), /companySizes: urns\('companySizes'\)/);
    assert.match(code(api), /companySizes: Array\.isArray\(t\.companySizes\)/);
});

check('a picked value carrying the delimiter keeps its whole name', () => {
    // The pick payload is `cid|facet|urn|name`, and a LinkedIn display name is theirs to choose.
    // A naive 4-way destructure would truncate any name containing the delimiter.
    assert.match(code(ui), /const name = parts\.slice\(3\)\.join\('\|'\);/);
});

console.log('\n──── the campaign group, without which nothing could ever stage ────');

check('no caller passes an empty campaign group any more', () => {
    // ⚠️ THE BUG. `campaignGroup` is Required:True on campaign creation — LinkedIn has mandated it
    // since 30 October 2020 — and every caller passed ''. The FIRST real stage_paid would have
    // failed at the very first API call, before reaching a creative.
    for (const f of ['netlify/functions/campaigns.ts', 'netlify/functions/optimise-paid-campaigns.ts']) {
        assert.ok(!/campaignGroupUrn: ''/.test(read(f)), `${f} still sends an empty campaign group`);
    }
    // And it is optional on the config now, resolved per campaign instead.
    assert.match(lk, /campaignGroupUrn\?: string;/);
});

check('the group is resolved per campaign at stage time', () => {
    assert.match(code(lk), /const groupUrn = cfg\.campaignGroupUrn\s*\n\s*\|\| await ensureCampaignGroup\(/);
    assert.match(code(lk), /campaignGroupUrn: groupUrn,/);
});

check('the group name is DETERMINISTIC, so a retry cannot duplicate it', () => {
    // stage_paid can fail after the group is created — the creative call is the next thing that
    // can go wrong. A retry that minted a second group would litter Campaign Manager with empty
    // duplicates.
    assert.equal(campaignGroupName(7), 'Be More Swan — campaign 7');
    assert.notEqual(campaignGroupName(7), campaignGroupName(8));
    assert.match(code(lk), /const wanted = campaignGroupName\(campaignId\);/);
});

check('an existing group is matched EXACTLY, not by contains', () => {
    // ⚠️ LinkedIn's name search is a contains-match, so "campaign 1" would return "campaign 12"
    // and a retry would attach ads to the wrong campaign's group.
    assert.match(code(lk), /\.find\(\(g\) => g\.name === wanted && g\.id\)/);
});

check('a failed search still creates rather than blocking the stage', () => {
    // The worst case is an untidy duplicate. Refusing would block the campaign entirely.
    const fn = lk.slice(landmark(lk, 'export async function ensureCampaignGroup'), landmark(lk, 'const created = await call('));
    assert.match(fn, /catch \(err\) \{/);
    assert.match(fn, /campaign group search failed, creating a new one/);
});

check('the group is created ACTIVE while the campaign is created PAUSED', () => {
    // ⚠️ LinkedIn applies the MOST RESTRICTIVE status across levels, so nothing serves. Creating
    // the group paused too would mean approval had to flip TWO things — two writes that could
    // half-succeed and leave a live group over a paused campaign, or the reverse.
    const create = lk.slice(landmark(lk, 'const created = await call('), landmark(lk, 'return parseRestliId(created);'));
    assert.match(create, /status: 'ACTIVE',/);
    assert.match(code(lk), /status: 'PAUSED',/);
});

check('no lifetime budget is invented for the group', () => {
    // We only ever ask for a DAILY figure. A totalBudget would be us deciding something the
    // customer never told us.
    const create = lk.slice(landmark(lk, 'const created = await call('), landmark(lk, 'return parseRestliId(created);'));
    assert.ok(!/totalBudget/.test(create), 'a lifetime budget is being invented for the campaign group');
});

console.log(`\n${passed} checks passed.\n`);
