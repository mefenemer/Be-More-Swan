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
    buildTargetingCriteria, campaignGroupName, ALLOWED_IMAGE_TYPES,
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

console.log('\n──── the creative call, and the one thing still missing ────');

check('creatives go through createInline, not the plain create', () => {
    // ⚠️ The first draft POSTed `content: { reference: url }` to the plain endpoint. On that
    // endpoint `content` is a URN of ALREADY-EXISTING content, and that object shape does not
    // exist in the API at all. We have no pre-existing post, so createInline is the only path.
    assert.match(code(lk), /\/creatives\?action=createInline/);
    assert.ok(!/content: \{ reference:/.test(code(lk)), 'the invalid content shape is back');
});

check('the post is authored by the ACCOUNT\'S ORGANISATION, read live', () => {
    // ⚠️ Sponsored Content is published by a Company Page, not a person — a person URN is invalid
    // here. There is no other source for the value, and a guessed or stale organisation URN would
    // publish an advert under the wrong company's name.
    assert.match(code(lk), /const author = await fetchAccountOrganization\(/);
    assert.match(code(lk), /author,/);
    assert.match(code(lk), /urn:li:organization/);
});

check('an ad account with no Company Page is refused, with a sentence', () => {
    const fn = lk.slice(landmark(lk, 'export async function fetchAccountOrganization'));
    assert.match(fn, /not linked to a Company Page/);
    assert.match(fn, /Adverts are published by a Page, not by a person/);
});

check('it is Direct Sponsored Content, so nothing appears on the Page feed', () => {
    // dscAdAccount marks the post as ad-only. Without it we would be publishing to the customer's
    // actual company page.
    assert.match(code(lk), /adContext: \{ dscAdAccount: cfg\.accountUrn, dscStatus: 'ACTIVE' \}/);
});

check('the tracked link is the landing page, and the body is the commentary', () => {
    assert.match(code(lk), /contentLandingPage: v\.destinationUrl/);
    assert.match(code(lk), /commentary: v\.body/);
});

check('a missing image REFUSES before any work is thrown away', () => {
    // ⚠️ THE LAST MISSING PIECE. A Sponsored Content ad is a post WITH MEDIA — both of LinkedIn's
    // createInline examples carry content.media.id and there is no documented text-only variant.
    // Without an upload path every stage would be rejected by the API, AFTER the user had written
    // three ads and chosen their targeting.
    assert.match(stage, /code: 'creative_media_required'/);
    assert.match(stage, /we cannot upload one for you yet/);
    assert.ok(landmark(stage, 'creative_media_required') < landmark(stage, 'await adapter.stageCampaign('),
        'the media check runs after the network call');
});

check('mediaUrn is REQUIRED by the contract, so this cannot be forgotten again', () => {
    // Expressed in the type, not just checked at the boundary — the compiler refuses any caller
    // that omits it.
    assert.match(read('src/utils/ad-networks/types.ts'), /mediaUrn: string;/);
});

console.log('\n──── the image upload — the last blocker, closed ────');

const media = read('netlify/functions/linkedin-ads-media.ts');
const sf = read('src/utils/safe-fetch.ts');

check('image bytes go through the BINARY fetch, never the text one', () => {
    // ⚠️ THE BUG THIS AVOIDS. safeFetchText decodes as UTF-8, replacing every invalid byte
    // sequence with U+FFFD — a JPEG round-tripped through it is silently destroyed, with no error
    // at any layer. It only surfaces as "the advert has a broken image".
    assert.match(code(media), /safeFetchBinary\(imageUrl/);
    assert.ok(!/safeFetchText/.test(code(media)), 'image bytes are being decoded as text');
    assert.match(sf, /export async function safeFetchBinary/);
});

check('the binary path keeps the whole SSRF fence — by sharing it, not copying it', () => {
    // The valuable part of safe-fetch is the DNS pin and the per-hop re-validation, not the
    // decoding. A binary variant that skipped them would be a fresh SSRF hole.
    //
    // ⚠️ It was first written as a COPY of safeFetchText's loop: twenty-one statements identical
    // but for the return line. Asserting the copy still contains the guards cannot catch what
    // actually goes wrong there — a NEW guard added to the text loop and not to the binary one.
    // So what is pinned now is that there is exactly one loop and both entry points go through it.
    const fence = sf.slice(landmark(sf, 'async function followRedirects('), landmark(sf, 'interface SafeFetchOptions'));
    assert.match(fence, /resolveToPublicAddresses\(url\.hostname\)/);
    assert.match(fence, /parseAndValidateUrl\(next\.toString\(\)\)/);
    assert.match(fence, /too_many_redirects/);

    for (const entry of ['safeFetchText', 'safeFetchBinary']) {
        const fn = sf.slice(landmark(sf, `export async function ${entry}(`));
        const body = fn.slice(0, landmark(fn, '\n}'));
        assert.match(body, /await followRedirects\(rawUrl, \{/, `${entry} must go through the shared fence`);
        assert.doesNotMatch(body, /\bfor \(let hop\b/, `${entry} has grown a redirect loop of its own`);
        assert.doesNotMatch(body, /resolveToPublicAddresses/, `${entry} must not re-implement the check`);
    }
});

check('a hop produces the decoded text or the raw bytes, never both', () => {
    // A 10MB JPEG was being decoded into a ~10MB UTF-8 string that was allocated and thrown away,
    // and on the text path the concatenated Buffer — collectable the instant .toString() returned —
    // stayed reachable for the rest of the redirect loop.
    const end = sf.slice(landmark(sf, "res.on('end'"), landmark(sf, "res.on('error'"));
    assert.match(end, /opts\.binary/, 'the end handler must branch on what the caller asked for');
    assert.match(end, /body: '', bytes \}/, 'binary: bytes only');
    assert.match(end, /bytes: EMPTY \}/, 'text: string only');
});

check('an image request says it wants an image', () => {
    // The text Accept list was sent for every request. A server doing content negotiation may
    // answer that with HTML or a 406, which surfaced as "that link returned text/html" about a URL
    // serving a perfectly good JPEG — our header, blamed on the user's link.
    assert.match(sf, /'Accept': opts\.accept,/, 'the header must be per-caller, not hardcoded');
    assert.match(sf, /accept: ACCEPT\.binary,/);
    assert.match(sf, /accept: ACCEPT\.text,/);
    assert.match(sf, /binary: 'image\/\*/, 'the binary list must lead with image types');
});

check('the Buffer is sliced to its own view before being sent', () => {
    // ⚠️ Node Buffers share a POOLED ArrayBuffer. Handing over `.buffer` unsliced would upload the
    // neighbouring allocations too — other requests' memory, sent to a third party.
    assert.match(code(media), /res\.bytes\.buffer\.slice\(res\.bytes\.byteOffset, res\.bytes\.byteOffset \+ res\.bytes\.byteLength\)/);
});

check('the upload WAITS for the asset to be processed', () => {
    // ⚠️ A fresh upload is WAITING_UPLOAD, then PROCESSING. Referencing it in a creative before
    // LinkedIn finishes is the Instagram-container bug: the asset exists, the reference is valid,
    // and it silently does not work.
    assert.match(code(lk), /await waitForImageReady\(accessToken, imageUrn\)/);
    assert.ok(landmark(lk, "method: 'PUT'") < landmark(lk, 'await waitForImageReady'));
});

check('a missing status is NOT read as ready, and a failure is terminal', () => {
    const fn = lk.slice(landmark(lk, 'export async function waitForImageReady'));
    assert.match(fn, /data\.status === 'AVAILABLE'/);
    assert.match(fn, /data\.status === 'PROCESSING_FAILED'/);
    // Only an explicit AVAILABLE returns; anything else keeps waiting or throws.
    assert.ok(!/data\.status !== /.test(fn), 'readiness is being inferred from a negative check');
});

check('the pre-signed upload URL is not sent our bearer token', () => {
    // It is already signed; attaching an Authorization header is needless credential exposure and
    // some signed endpoints reject it outright.
    const put = lk.slice(landmark(lk, 'const put = await fetch(uploadUrl'), landmark(lk, 'if (!put.ok)'));
    assert.ok(!/Authorization/.test(put), 'the bearer token is being sent to the upload URL');
    assert.match(put, /'Content-Type': contentType/);
});

check('only formats LinkedIn accepts are forwarded', () => {
    assert.deepEqual([...ALLOWED_IMAGE_TYPES], ['image/jpeg', 'image/png', 'image/gif']);
    assert.match(code(media), /ALLOWED_IMAGE_TYPES\.includes\(contentType as never\)/);
});

check('the SSRF refusal is not echoed back to the caller', () => {
    // ⚠️ A refusal naming the internal address it blocked tells a prober what exists.
    const branch = media.slice(landmark(media, '[linkedin-ads-media] fetch refused or failed'), landmark(media, 'const owner = await fetchAccountOrganization'));
    assert.match(branch, /Use a public https:\/\/ link/);
    assert.ok(!/err\.message/.test(branch), 'the fence\'s internal reason is being returned to the caller');
});

check('the UI uploads BEFORE staging, and names which ad failed', () => {
    // A rejected image should say WHICH ad and why, not fail the whole campaign with one opaque
    // message after three ads have been written.
    assert.ok(landmark(ui, "action: 'upload', imageUrl: src") < landmark(ui, "action: 'stage_paid'"));
    assert.match(code(ui), /`Ad \$\{i \+ 1\}: \$\{d\.error/);
});

check('one image shared by three ads is uploaded once', () => {
    // The common case. Three uploads would be three round trips and three assets for one file.
    assert.match(code(ui), /const urlToUrn = new Map\(\)/);
    assert.match(code(ui), /if \(!urlToUrn\.has\(src\)\)/);
});

console.log(`\n${passed} checks passed.\n`);
