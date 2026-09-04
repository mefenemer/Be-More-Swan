// tests/linkedin-ads-adapter.test.ts
// The LinkedIn Advertising API adapter — Development Tier, dev-only.
//
// No live token exists yet, so nothing here makes a real call. What IS testable is every shape the
// API cares about: the request bodies, the URL construction, the response parsing, and the two
// gates that keep this out of production. Those are also where the expensive mistakes are — a
// campaign created ACTIVE instead of PAUSED spends money nobody approved, and a mis-parsed empty
// analytics response tells the optimiser a healthy campaign has collapsed.
//
// Shapes are taken from the versioned docs (li-lms-2026-08), not from memory.
// Run:  npx tsx tests/linkedin-ads-adapter.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LINKEDIN_API_VERSION, accountId, analyticsUrl, campaignCreateBody, creativeStatusPatchBody,
    dateParam, parseAnalytics, parseRestliId, statusPatchBody,
} from '../src/utils/ad-networks/linkedin';
import { anyNetworkAvailable, linkedInAdapter, resolveAdapter } from '../src/utils/ad-networks/registry';
import { isProductionDeploy } from '../src/utils/deploy-context';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const body = () => campaignCreateBody({
    accountUrn: 'urn:li:sponsoredAccount:518121035',
    campaignGroupUrn: 'urn:li:sponsoredCampaignGroup:635137195',
    name: 'March webinar',
    dailyBudgetAmount: '50',
    currencyCode: 'GBP',
    targeting: { include: { and: [] } },
    startMs: 1_767_225_600_000,
});

console.log('\n──── nothing is created live ────');

check('a staged campaign is created PAUSED, never ACTIVE', () => {
    // ⚠️ THE INVARIANT. The API accepts "ACTIVE" here and LinkedIn's own documented example uses
    // it — creating a spending campaign is literally one word away from this line.
    assert.equal(body().status, 'PAUSED');
});

check('DRAFT is not used, so validation happens at staging not at approval', () => {
    // LinkedIn postpones validation on DRAFT campaigns. Using it would move every error to the
    // moment after the user clicks Approve, which is the worst place to discover one.
    assert.notEqual(body().status, 'DRAFT');
});

check('the budget carries its currency and is a STRING', () => {
    // A bare number is rejected, and an amount without a currency is a number with no meaning.
    assert.deepEqual(body().dailyBudget, { amount: '50', currencyCode: 'GBP' });
});

check('the create body carries every field the API requires', () => {
    const b = body();
    // ⚠️ `unitCost` is Required:True and was MISSING from the first draft — the same class of
    // omission as campaignGroup, and both were invisible until the field table was read.
    for (const f of ['account', 'campaignGroup', 'name', 'type', 'costType', 'dailyBudget',
        'locale', 'runSchedule', 'targetingCriteria', 'status', 'unitCost', 'optimizationTargetType']) {
        assert.ok(f in b, `create body is missing ${f}`);
    }
});

check('bidding is AUTO, so a campaign cannot be created that never delivers', () => {
    // ⚠️ THE SILENT FAILURE THIS PREVENTS. Absent optimizationTargetType means NONE, which is
    // MANUAL bidding; unitCost then defaults to 0; and LinkedIn documents that under manual
    // bidding "if unitCost is 0, the campaign does not deliver". No error — an ad that looks
    // launched and never runs.
    const b = body() as any;
    assert.equal(b.optimizationTargetType, 'MAX_CLICK');
    assert.notEqual(b.optimizationTargetType, 'NONE');
    assert.ok(b.unitCost, 'unitCost is absent, so it defaults to 0');
});

check('costType is CPM, because auto-bidding always charges by impression', () => {
    // ⚠️ Not CPC. Auto-bidding charges by impression regardless of what it OPTIMISES for, and the
    // first draft paired CPC with auto-bidding-shaped intent.
    assert.equal((body() as any).costType, 'CPM');
});

check('the unit cost carries the account currency, not a bare zero', () => {
    assert.deepEqual((body() as any).unitCost, { amount: '0', currencyCode: 'GBP' });
});

check('no founder is ever asked to set a bid', () => {
    // The premise of the product: MAX_CLICK spends the daily budget without an advertiser
    // specifying one. A manual bidding mode would put a CPC field in front of someone whose whole
    // reason for being here is not knowing what that is.
    const src = read('src/utils/ad-networks/linkedin.ts');
    assert.match(src, /MAX_CLICK is auto-bidding/);
    const ui = readFileSync(join(root, 'src/components/assistant-campaigns.js'), 'utf8');
    assert.ok(!/bid/i.test(ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')),
        'a bid field has appeared in the staging form');
});

console.log('\n──── status changes use the shapes Rest.li expects ────');

check('a status change is a $set patch, not a plain field', () => {
    assert.deepEqual(statusPatchBody('ACTIVE'), { patch: { $set: { status: 'ACTIVE' } } });
});

check('creatives use intendedStatus, campaigns use status', () => {
    // Different field names on the two entities. Sending `status` to a creative silently does
    // nothing useful.
    assert.deepEqual(creativeStatusPatchBody('PAUSED'), { patch: { $set: { intendedStatus: 'PAUSED' } } });
    assert.ok('status' in (statusPatchBody('PAUSED').patch as any).$set);
});

check('the PARTIAL_UPDATE header accompanies every patch', () => {
    // The endpoint is a POST to the entity URL either way, so without this header LinkedIn reads
    // the call as something else entirely rather than erroring helpfully.
    const src = read('src/utils/ad-networks/linkedin.ts');
    const patches = (src.match(/statusPatchBody\(|creativeStatusPatchBody\(/g) || []).length;
    const headersWith = (src.match(/'X-RestLi-Method': 'PARTIAL_UPDATE'/g) || []).length;
    // Two of the matches are the exported definitions themselves, not call sites.
    assert.ok(headersWith >= 3, `expected a PARTIAL_UPDATE header on each patch call, found ${headersWith}`);
    assert.ok(patches >= headersWith);
});

console.log('\n──── analytics: the ambiguity that must not become zeroes ────');

check('the fields parameter is always sent', () => {
    // ⚠️ Without it LinkedIn returns impressions and clicks ONLY. Spend and conversions would
    // arrive undefined, and an optimiser reading undefined as 0 sees every variant as free and
    // converting nothing — which is exactly the profile of an ad it should pause.
    const url = analyticsUrl(['urn:li:sponsoredCreative:1'], new Date('2026-08-25'), new Date('2026-09-01'));
    assert.match(url, /&fields=/);
    for (const f of ['impressions', 'clicks', 'costInLocalCurrency', 'externalWebsiteConversions']) {
        assert.ok(url.includes(f), `fields is missing ${f}`);
    }
});

check('the URL is daily, creative-pivoted, and URL-encodes its URNs', () => {
    const url = analyticsUrl(['urn:li:sponsoredCreative:1', 'urn:li:sponsoredCreative:2'],
        new Date('2026-08-25'), new Date('2026-09-01'));
    assert.match(url, /q=analytics/);
    assert.match(url, /pivot=CREATIVE/);
    assert.match(url, /timeGranularity=DAILY/);
    assert.match(url, /creatives=List\(urn%3Ali%3AsponsoredCreative%3A1,urn%3Ali%3AsponsoredCreative%3A2\)/);
});

check('dates use LinkedIn\'s unpadded object form', () => {
    // (year:2026,month:9,day:1) — NOT ISO, and NOT zero-padded.
    assert.equal(dateParam(new Date(Date.UTC(2026, 8, 1))), '(year:2026,month:9,day:1)');
});

check('an empty response parses to NOTHING, not to a row of zeroes', () => {
    // ⚠️ The dangerous one. LinkedIn returns `elements: []` both when there was no activity AND
    // when the token lacks read access — the docs say so, and the two are indistinguishable. Zeroes
    // would look to the optimiser like a total collapse and could pause a healthy campaign.
    assert.deepEqual(parseAnalytics({ elements: [] }), []);
    assert.deepEqual(parseAnalytics({}), []);
    assert.deepEqual(parseAnalytics(null), []);
});

check('a real row parses, with cost read from a STRING', () => {
    const rows = parseAnalytics({
        elements: [{
            pivotValues: ['urn:li:sponsoredCreative:99'],
            dateRange: { start: { year: 2026, month: 5, day: 29 }, end: { year: 2026, month: 5, day: 29 } },
            impressions: 165, clicks: 12, landingPageClicks: 11,
            costInLocalCurrency: '19.91833', externalWebsiteConversions: 2,
        }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].externalVariantId, 'urn:li:sponsoredCreative:99');
    assert.equal(rows[0].day, '2026-05-29', 'the day must be zero-padded for stable sorting');
    assert.equal(rows[0].impressions, 165);
    assert.equal(rows[0].spendLocal, 19.91833);
    assert.equal(rows[0].reportedConversions, 2);
});

check('spend is named LOCAL, because it is not necessarily sterling', () => {
    // The ad account's currency, whatever that is. A field called spendGbp holding euros is a
    // number that will be added to pounds by someone, somewhere, eventually.
    const src = read('src/utils/ad-networks/linkedin.ts');
    assert.match(src, /spendLocal: number/);
    assert.match(src, /spendGbp: cfg\.currencyCode === 'GBP' \? r\.spendLocal : NaN/);
});

console.log('\n──── ids and errors ────');

check('the created id is read from the header, not the body', () => {
    const res = { headers: { get: (n: string) => (n === 'x-restli-id' ? 'urn:li:sponsoredCreative:120491345' : null) } };
    assert.equal(parseRestliId(res), 'urn:li:sponsoredCreative:120491345');
});

check('a write with no id back is an ERROR, not a silent success', () => {
    // An entity we cannot address is one we can never pause. Better to fail the stage than to
    // record a campaign we have lost the handle to.
    assert.throws(() => parseRestliId({ headers: { get: () => null } }), /cannot be tracked/);
});

check('an account urn reduces to its numeric id, in either form', () => {
    assert.equal(accountId('urn:li:sponsoredAccount:518121035'), '518121035');
    assert.equal(accountId('518121035'), '518121035');
    assert.throws(() => accountId('nonsense'));
});

check('a throttle or a 500 is NOT reported as lost control', () => {
    // "We can no longer stop this campaign" triggers a halt. Halting a healthy campaign because
    // LinkedIn was briefly busy is its own kind of damage.
    const src = read('src/utils/ad-networks/linkedin.ts');
    assert.match(src, /get throttled\(\): boolean \{ return this\.status === 429; \}/);
    assert.match(src, /get controlLost\(\): boolean \{ return this\.status === 401 \|\| this\.status === 403; \}/);
});

console.log('\n──── it still cannot reach a tenant ────');

check('LinkedIn is NOT in the production adapter registry', () => {
    // ⚠️ Development Tier allows EDIT on at most five ad accounts. Registering it for production
    // would give the sixth tenant a control that works for everyone else and fails for them —
    // mid-launch, on their money.
    assert.equal(anyNetworkAvailable(), false);
    assert.equal(resolveAdapter('linkedin').adapter, null);
});

check('the blocker copy describes the CAP, not a refusal that no longer applies', () => {
    // Access was granted on 2026-09-01. Copy still claiming we were never approved would be the
    // stale-claim failure this project keeps hitting.
    const blocker = resolveAdapter('linkedin').blocker!;
    assert.ok(!/not yet been granted/i.test(blocker), 'the blocker still says access was refused');
    assert.match(blocker, /handful of ad accounts|limited testing/i);
});

check('the dev adapter refuses to construct in production', () => {
    // ⚠️ The verdict is passed IN now. It used to read process.env.NODE_ENV, which Netlify sets to
    // 'production' on EVERY context including branch deploys — so the gate was shut on staging too
    // and this adapter could never have been exercised anywhere at all.
    const cfg = { accessToken: 't', accountUrn: 'urn:li:sponsoredAccount:1', currencyCode: 'GBP' };
    assert.throws(() => linkedInAdapter(cfg, { isProduction: true }), /Development Tier only/);
    assert.ok(linkedInAdapter(cfg, { isProduction: false }), 'the adapter is unreachable on staging');
});

check('production is derived from the HOST, and fails closed without one', () => {
    // CONTEXT/BRANCH are BUILD-time vars and are often absent at function runtime — the host is
    // the only signal always available. No host means a scheduled function, which Netlify runs on
    // production only.
    const prevC = process.env.CONTEXT; const prevB = process.env.BRANCH;
    delete process.env.CONTEXT; delete process.env.BRANCH;
    try {
        assert.equal(isProductionDeploy({ host: 'bemoreswan.com' }), true);
        assert.equal(isProductionDeploy({ host: 'www.bemoreswan.com' }), true);
        assert.equal(isProductionDeploy({ host: 'staging--bemoreswan.netlify.app' }), false);
        assert.equal(isProductionDeploy({ host: 'bemoreswan.com:443' }), true, 'a port defeats the host match');
        // Fail closed.
        assert.equal(isProductionDeploy(undefined), true);
        assert.equal(isProductionDeploy({}), true);
    } finally {
        if (prevC !== undefined) process.env.CONTEXT = prevC;
        if (prevB !== undefined) process.env.BRANCH = prevB;
    }
});

check('the API version is pinned and documented as a sunset risk', () => {
    assert.match(LINKEDIN_API_VERSION, /^20\d{4}$/);
    assert.match(read('src/utils/ad-networks/linkedin.ts'), /sunsets versions on a\s*\n \* schedule/);
});

console.log(`\n${passed} checks passed.\n`);
