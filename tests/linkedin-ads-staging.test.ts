// tests/linkedin-ads-staging.test.ts
// The ad-account picker and `stage_paid` — the two steps between a connected LinkedIn account and
// a campaign sitting paused, waiting for a human to approve the spend.
//
// `stage_paid` is the first action in this product that can create something on an external system
// which is capable of charging a customer. It does not spend — the campaign is created PAUSED —
// but every guard in front of it is load-bearing, and none of them is expressible in a type.
//
// Pure readiness logic is unit-tested; the handlers are source-scanned.
// Run:  npx tsx tests/linkedin-ads-staging.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    ADS_SERVICE_NAME, assessAdsReadiness, type AdsConnection,
} from '../src/utils/linkedin-ads-connection';
import { ADS_SERVICE_NAME as CALLBACK_SERVICE_NAME } from '../netlify/functions/linkedin-ads-oauth-callback';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const api = read('netlify/functions/campaigns.ts');
const stage = api.slice(landmark(api, "if (action === 'stage_paid')"), landmark(api, "if (action === 'list_decisions')"));
const picker = read('netlify/functions/linkedin-ads-account.ts');

const conn = (over: Partial<AdsConnection> = {}): AdsConnection => ({
    connectionId: 1,
    adAccounts: [{ urn: 'urn:li:sponsoredAccount:1', name: 'Acme', currency: 'GBP' }],
    selectedAccountUrn: 'urn:li:sponsoredAccount:1',
    selectedCurrency: 'GBP',
    scopes: 'rw_ads r_ads_reporting',
    status: 'active',
    ...over,
});

console.log('\n──── every refusal is a different sentence ────');

check('the four failure modes do not collapse into one message', () => {
    // Connect / reconnect / pick an account / go to Campaign Manager are four different next
    // actions. A single "not ready" sends three of those four people to the wrong place.
    const reasons = [
        assessAdsReadiness(null),
        assessAdsReadiness(conn({ status: 'expired' })),
        assessAdsReadiness(conn({ adAccounts: [], selectedAccountUrn: null, selectedCurrency: null })),
        assessAdsReadiness(conn({ selectedAccountUrn: null, selectedCurrency: null })),
    ].map((r) => (r.ready ? '' : r.reason));
    assert.equal(new Set(reasons).size, 4, 'two refusals share a message');
    assert.ok(reasons.every((r) => r.length > 25));
});

check('"could not ask" never becomes "you have none"', () => {
    // ⚠️ null vs []. Telling someone to create an ad account they already have is worse than
    // saying nothing at all.
    const couldNotAsk = assessAdsReadiness(conn({ adAccounts: null, selectedAccountUrn: null, selectedCurrency: null }));
    const genuinelyNone = assessAdsReadiness(conn({ adAccounts: [], selectedAccountUrn: null, selectedCurrency: null }));
    assert.match((couldNotAsk as any).reason, /could not read/i);
    assert.match((genuinelyNone as any).reason, /Campaign Manager/);
});

check('a selected account that has vanished is refused, not priced in an unknown currency', () => {
    // A reconnect can change what is available. Better to ask again than to guess.
    const r = assessAdsReadiness(conn({ selectedAccountUrn: 'urn:li:sponsoredAccount:999', selectedCurrency: null }));
    assert.equal(r.ready, false);
    assert.match((r as any).reason, /no longer available/);
});

check('a fully configured connection is ready', () => {
    assert.equal(assessAdsReadiness(conn()).ready, true);
});

console.log('\n──── the picker cannot be pointed at a stranger\'s account ────');

check('a selection is validated against the STORED list', () => {
    // ⚠️ Without this the refusal arrives at SPEND time, from LinkedIn, as an opaque error deep in
    // the staging flow.
    assert.match(code(picker), /const match = \(connection\.adAccounts \?\? \[\]\)\.find\(\(a\) => a\.urn === accountUrn\)/);
    assert.match(code(picker), /if \(!match\)/);
});

check('the metadata blob is MERGED, never replaced', () => {
    // It also holds the discovered account list and the tier. A wholesale write loses both — the
    // widget theme was replaced wholesale once and silently deleted every key not resent.
    assert.match(code(picker), /\.\.\.\(row\?\.metadata as Record<string, unknown> \?\? \{\}\), selectedAccountUrn: accountUrn/);
});

check('every picker query is scoped to the ads connection', () => {
    const body = code(picker);
    const scoped = (body.match(/eq\(systemConnections\.serviceName, ADS_SERVICE_NAME\)/g) || []).length;
    assert.ok(scoped >= 2, `expected the read and the write to be ads-scoped, found ${scoped}`);
    assert.ok(!/serviceName, 'linkedin'\)/.test(body), 'a query targets the posting connection');
});

check('the two ADS_SERVICE_NAME constants agree', () => {
    // Two modules define it; a drift would silently split the connection in half — written by one
    // and never found by the other.
    assert.equal(ADS_SERVICE_NAME, CALLBACK_SERVICE_NAME);
    assert.equal(ADS_SERVICE_NAME, 'linkedin_ads');
});

check('the picker is gated on the same plan feature as the OAuth flow', () => {
    assert.match(code(picker), /hasFeatureByOrg\(db, orgId, PAID_ADS_FEATURE\)/);
});

console.log('\n──── staging creates something PAUSED, and nothing else ────');

check('the network call happens BEFORE any local write', () => {
    // A failed network call must leave nothing changed. The reverse order would mark a campaign
    // paid, with a budget, and no campaign on LinkedIn to match it.
    assert.ok(
        landmark(stage, 'await adapter.stageCampaign(') < landmark(stage, 'db.update(campaigns).set({'),
        'the campaign is marked paid before LinkedIn has accepted it',
    );
});

check('mode is set to paid BEFORE a non-zero budget is written', () => {
    // ⚠️ db/campaigns.sql carries a trigger refusing any non-zero max_spend_gbp on a campaign still
    // marked organic. That trigger is what makes "an organic campaign can never spend" true in the
    // database rather than in a comment — this ordering is how we work WITH it, not around it.
    assert.ok(
        landmark(stage, "mode: 'paid'") < landmark(stage, 'db.update(campaignBudgets)'),
        'the budget is written while the campaign is still organic — the trigger will refuse it',
    );
});

check('variants are inserted as staged, never active', () => {
    // A CHECK also requires approved_by on anything live, so this would fail loudly — but failing
    // loudly at the database is not a substitute for not trying.
    assert.match(stage, /status: 'staged',/);
    assert.ok(!/status: 'active'/.test(code(stage)), 'a variant is being staged live');
});

check('the response states that nothing will be spent', () => {
    // The user has just pressed a button on a screen about advertising. "Done" is not enough.
    assert.match(stage, /status: 'paused',/);
    assert.match(stage, /Nothing will be spent until you approve it/);
});

check('stage_paid never activates', () => {
    assert.ok(!code(stage).includes('activateCampaign'), 'staging can start a spend');
});

console.log('\n──── the guards in front of it ────');

check('IDOR, entitlement, mode, status, readiness — all before the network call', () => {
    const networkAt = landmark(stage, 'await adapter.stageCampaign(');
    for (const guard of [
        'await requireCampaign(Number(body.campaignId))',
        'hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)',
        "campaign.mode !== 'organic'",
        'LIVE_CAMPAIGN_STATUSES.includes(campaign.status as never)',
        'assessAdsReadiness(',
    ]) {
        assert.ok(landmark(stage, guard) < networkAt, `${guard} runs after the network call`);
    }
});

check('a non-GBP ad account is REFUSED, not converted', () => {
    // ⚠️ max_spend_gbp is named for its currency. Writing euros into it is the same mistake the
    // adapter refuses to make with costInLocalCurrency, and it would misreport every
    // cost-per-outcome figure downstream. Converting needs a rate we do not have.
    assert.match(stage, /conn\.selectedCurrency !== 'GBP'/);
    assert.match(stage, /bills in \$\{conn\.selectedCurrency\}/);
});

check('the daily budget is bounded at both ends', () => {
    assert.match(stage, /dailyBudgetGbp <= 0/);
    assert.match(stage, /dailyBudgetGbp > 1000/);
});

check('destinations get the same open-redirect check as tracked links', () => {
    assert.match(stage, /isSafeDestination\(v\.destinationUrl\)/);
});

check('between one and three variants, matching the brief', () => {
    assert.match(stage, /rawVariants\.length < 1 \|\| rawVariants\.length > 3/);
});

check('an adapter that refuses to construct is reported, not crashed through', () => {
    // In production linkedInAdapter() throws — Development Tier is dev-only. The caller gets the
    // sentence, not a 500.
    assert.match(stage, /catch \(err\) \{\s*\n\s*return json\(400, \{ error: err instanceof Error \? err\.message/);
});

check('a half-completed stage tells the user it is paused and safe', () => {
    // The orphan case: LinkedIn accepted it, our write failed. It cannot spend, and saying so is
    // the difference between a support ticket and a panic.
    const branch = stage.slice(landmark(stage, 'stage_paid created a LinkedIn campaign but failed to record it'));
    assert.match(branch, /It is paused and cannot spend/);
});

check('the organic create path is untouched', () => {
    // stage_paid adds a second, separately-gated door. It must not have widened the first one.
    assert.match(read('src/config/campaign-vocab.ts'), /CREATABLE_CAMPAIGN_MODES[^=]*=\s*\['organic'\]/);
    const create = api.slice(landmark(api, "if (action === 'create')"), landmark(api, "if (action === 'edit')"));
    assert.match(create, /Number\(body\.maxSpendGbp\) > 0/);
});

console.log(`\n${passed} checks passed.\n`);
