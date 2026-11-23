// tests/meta-ads.test.ts
// The Meta advertising path: adapter shapes, a mocked end-to-end stage, readiness, and the wall
// between the ads sign-in and the Facebook/Instagram posting sign-in.
// Run:  npx tsx tests/meta-ads.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    MetaAdsError, actId, buildMetaTargeting, createMetaAdapter, metaAdSetBody, metaAdsGraphVersion,
    metaCampaignBody, metaCreativeBody, metaErrorDetail, toMinorUnits, META_ADS_DEFAULT_GRAPH_VERSION,
} from '../src/utils/ad-networks/meta';
import {
    META_ADS_DEFAULT_SCOPES, assessMetaAdsReadiness, metaAdsAllowedInProduction, metaAdsCreateProblem, metaAdsScopes,
    type MetaAdsConnection,
} from '../src/utils/meta-ads-connection';
import { anyNetworkAvailable, metaAdapter } from '../src/utils/ad-networks/registry';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

console.log('\n──── shapes Meta will judge ────');

check('ad accounts are addressed with the act_ prefix', () => {
    assert.equal(actId('123'), 'act_123');
    assert.equal(actId('act_123'), 'act_123');
    assert.throws(() => actId('nope'));
});

check('budgets go to Meta in pence, as integers', () => {
    assert.equal(toMinorUnits(5), 500);
    assert.equal(toMinorUnits(12.345), 1235);
});

check('targeting needs a country and never lets Meta widen the audience', () => {
    assert.throws(() => buildMetaTargeting({ countries: [] }), /at least one country/);
    const t = buildMetaTargeting({ countries: ['gb', 'XX1'] });
    assert.deepEqual(t.geo_locations, { countries: ['GB'] });
    assert.deepEqual(t.targeting_automation, { advantage_audience: 0 });
});

check('the campaign is created PAUSED, traffic objective, categories declared', () => {
    const b = metaCampaignBody('x');
    assert.equal(b.status, 'PAUSED');
    assert.equal(b.objective, 'OUTCOME_TRAFFIC');
    assert.deepEqual(b.special_ad_categories, []);
    assert.equal(b.is_adset_budget_sharing_enabled, false);
});

check('the ad set carries the customer\'s daily budget in pence and runs under the paused campaign', () => {
    const b = metaAdSetBody({ name: 'n', campaignId: '9', dailyBudgetGbp: 5, targeting: { a: 1 }, startMs: 0 });
    assert.equal(b.daily_budget, 500);
    assert.equal(b.campaign_id, '9');
    assert.equal(b.status, 'ACTIVE');
    assert.equal(b.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
});

check('the creative is a Page link post citing the image hash', () => {
    const b = metaCreativeBody({ name: 'n', pageId: 'P', headline: 'H', body: 'B', link: 'https://x.test', imageHash: 'abc' }) as any;
    assert.equal(b.object_story_spec.page_id, 'P');
    assert.equal(b.object_story_spec.link_data.image_hash, 'abc');
    assert.equal(b.object_story_spec.link_data.call_to_action.value.link, 'https://x.test');
});

console.log('\n──── a refusal says WHY, and the knobs need no deploy ────');

check('metaErrorDetail names status, message, code and Meta\'s user message', () => {
    const body = JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 1487390, error_user_msg: 'Pick a page' } });
    assert.equal(metaErrorDetail(new MetaAdsError(400, body, 'x')), '400: Invalid parameter (code 100/1487390) Pick a page');
    assert.equal(metaErrorDetail(new Error('nope')), null);
});

check('META_ADS_GRAPH_VERSION overrides the version; junk is ignored', () => {
    const saved = process.env.META_ADS_GRAPH_VERSION;
    try {
        process.env.META_ADS_GRAPH_VERSION = 'v26.0';
        assert.equal(metaAdsGraphVersion(), 'v26.0');
        process.env.META_ADS_GRAPH_VERSION = 'latest';
        assert.equal(metaAdsGraphVersion(), META_ADS_DEFAULT_GRAPH_VERSION);
    } finally {
        if (saved === undefined) delete process.env.META_ADS_GRAPH_VERSION; else process.env.META_ADS_GRAPH_VERSION = saved;
    }
});

check('META_ADS_SCOPES overrides the permissions asked for', () => {
    const saved = process.env.META_ADS_SCOPES;
    try {
        delete process.env.META_ADS_SCOPES;
        assert.equal(metaAdsScopes(), META_ADS_DEFAULT_SCOPES);
        process.env.META_ADS_SCOPES = ' ads_management ads_read ';
        assert.equal(metaAdsScopes(), 'ads_management,ads_read');
    } finally {
        if (saved === undefined) delete process.env.META_ADS_SCOPES; else process.env.META_ADS_SCOPES = saved;
    }
});

console.log('\n──── readiness: what stops reading vs what stops creating ────');

const base: MetaAdsConnection = {
    connectionId: 1, status: 'active',
    adAccounts: [{ id: 'act_1', name: 'A', currency: 'GBP', accountStatus: 1 }],
    pages: [{ id: 'P1', name: 'Page' }],
    selectedAccountId: 'act_1', selectedCurrency: 'GBP', selectedPageId: 'P1',
    scopes: 'ads_management,ads_read,pages_show_list',
};

check('a fully set-up connection is ready and can create', () => {
    assert.equal(assessMetaAdsReadiness(base).ready, true);
    assert.equal(metaAdsCreateProblem(base), null);
});

check('no account chosen → not ready, with the sentence that says so', () => {
    const r = assessMetaAdsReadiness({ ...base, selectedAccountId: null, selectedCurrency: null });
    assert.equal(r.ready, false);
    assert.match((r as { reason: string }).reason, /Choose which Meta ad account/);
});

check('a missing Page or missing ads_management blocks CREATING but not readiness (the optimiser can still pause)', () => {
    const noPage = { ...base, selectedPageId: null };
    assert.equal(assessMetaAdsReadiness(noPage).ready, true);
    assert.match(String(metaAdsCreateProblem(noPage)), /Choose which Facebook Page/);
    const noPerm = { ...base, scopes: 'ads_read' };
    assert.equal(assessMetaAdsReadiness(noPerm).ready, true);
    assert.match(String(metaAdsCreateProblem(noPerm)), /ads_management/);
});

check('"could not list" and "you have none" stay different sentences', () => {
    assert.match((assessMetaAdsReadiness({ ...base, adAccounts: null }) as any).reason, /could not read/);
    assert.match((assessMetaAdsReadiness({ ...base, adAccounts: [] }) as any).reason, /Create one in Meta Ads Manager/);
});

console.log('\n──── the paid lock still holds ────');

check('the Meta adapter refuses production and the registry stays empty', () => {
    assert.throws(() => metaAdapter({ accessToken: 't', accountId: 'act_1', pageId: 'P' }, { isProduction: true }), /development only/);
    assert.equal(anyNetworkAvailable(), false);
});

console.log('\n──── the wall between the ads sign-in and posting ────');

check('the posting sign-in still asks for no ads permission', () => {
    const posting = code(read('netlify/functions/meta-oauth.ts'));
    for (const p of ['ads_management', 'ads_read']) assert.ok(!posting.includes(p), `${p} leaked into meta-oauth.ts`);
});

check('the ads callback only redeems its own state and only writes meta_ads', () => {
    const cb = code(read('netlify/functions/meta-ads-oauth-callback.ts'));
    assert.ok(cb.includes("parsed.flow !== 'meta_ads'"));
    assert.ok(cb.includes('serviceName: META_ADS_SERVICE_NAME'));
    assert.ok(!/serviceName,\s*'(facebook|instagram)'/.test(cb) && !/'facebook'|'instagram'/.test(cb), 'the ads callback names a posting service');
});

check('a reconnect keeps the chosen account and Page — even when a listing fails', () => {
    const cb = code(read('netlify/functions/meta-ads-oauth-callback.ts'));
    assert.ok(cb.includes('selectedAccountId: keepAccount'));
    assert.ok(cb.includes('keepPage ??'));
    // A failed (null) listing falls back to the previous list, so the choice survives.
    assert.ok(cb.includes('const accountList = accounts ?? prevAccounts;'));
    assert.ok(cb.includes('const pageList = pages ?? prevPages;'));
    assert.ok(cb.includes('adAccounts: accountList,') && cb.includes('pages: pageList,'));
});

check('only the production refusal skips; any other adapter failure halts', () => {
    const ca = code(read('src/utils/ad-networks/campaign-adapter.ts'));
    // Exactly two: Meta's production refusal (unless allow-listed) and LinkedIn's. Each sits right
    // under its own production check; nothing else may skip a live campaign.
    assert.equal((ca.match(/noAdapter: true/g) ?? []).length, 2, 'noAdapter is set for something other than production');
    for (const m of ca.matchAll(/noAdapter: true/g)) {
        const before = ca.slice(Math.max(0, m.index! - 220), m.index);
        assert.ok(/if \(env\.isProduction[^\n]*\)\s*\{\s*\n\s*return \{ ok: false, label, $/.test(before), 'a noAdapter not guarded by a production check');
    }
});

check('the callback stores what was GRANTED, not what was asked for', () => {
    const cb = code(read('netlify/functions/meta-ads-oauth-callback.ts'));
    assert.ok(cb.includes("const scopes = granted ? granted.join(',') : metaAdsScopes();"));
});

check('stage_paid routes Meta; approve and the optimiser pick the adapter by the campaign\'s network', () => {
    const camp = code(read('netlify/functions/campaigns.ts'));
    assert.ok(camp.includes("body.network === 'meta' ? 'meta' : 'linkedin'"));
    assert.ok(camp.includes('metaAdapter({ accessToken: token, accountId: metaAccountId!, pageId: metaPageId! },'));
    assert.ok(camp.includes('adNetwork: network,'));
    assert.ok(camp.includes('await adapterForCampaign(db, orgId, campaign.adNetwork'));
    const opt = code(read('netlify/functions/optimise-paid-campaigns.ts'));
    assert.ok(opt.includes('adapterForCampaign(db, c.organisationId, c.adNetwork'));
    assert.ok(!opt.includes('metaAdsCreateProblem') && !opt.includes('adsScopeProblem'), 'the optimiser must keep pausing');
});

console.log('\n──── the paid surface is reachable where the adapters can run ────');

check('off production the surface offers LinkedIn and Meta; in production only the (empty) registry', () => {
    const camp = code(read('netlify/functions/campaigns.ts'));
    assert.ok(camp.includes('const devAdaptersAllowed = !isProductionDeploy('));
    assert.ok(camp.includes("? ['linkedin', 'meta']"));
    assert.ok(camp.includes('...networkAvailability().filter((n) => n.available).map((n) => n.network),'));
    assert.ok(camp.includes("...(metaAdsAllowedInProduction(orgId) ? ['meta'] : []),"), 'production adds Meta only for listed workspaces');
    assert.ok(camp.includes('anyNetwork: anyNetworkAvailable() || offeredNetworks.length > 0,'));
    // The registry itself stays empty — production is still locked.
    assert.equal(anyNetworkAvailable(), false);
});

check('the panel reports Meta readiness beside LinkedIn\'s, and campaigns carry their network', () => {
    const camp = code(read('netlify/functions/campaigns.ts'));
    assert.ok(camp.includes('meta: {') && camp.includes('needsReconnect: metaAdsNeedsReconnect(metaConnection),'));
    assert.ok(camp.includes('adNetwork: campaigns.adNetwork,'));
});

check('the panel switches network, and stage/upload/approve follow it', () => {
    const ui = read('src/components/assistant-campaigns.js');
    assert.ok(ui.includes('data-cmp-paid-net='), 'no network switch');
    assert.ok(ui.includes("network === 'meta' ? 'meta-ads-media' : 'linkedin-ads-media'"), 'upload not routed');
    assert.ok(/action: 'stage_paid',\s*\n\s*network,/.test(ui), 'stage_paid not sent the network');
    assert.ok(ui.includes('? { countries }'), 'Meta targeting not sent');
    assert.ok(ui.includes('data-cmp-network="${esc(network)}"'), 'approve does not know its network');
    assert.ok(ui.includes('/.netlify/functions/meta-ads-oauth-init'), 'no Meta connect link');
    assert.ok(ui.includes('data-cmp-meta-save'), 'no Meta account/Page save');
    assert.ok(ui.includes("if (!p.featureEnabled || !p.anyNetwork) return '';"), 'switch shown without paid ads');
    assert.ok(/await load\(\);\s*\n(\s*\/\/.*\n)*\s*if \(state\.paid && state\.paid\.meta && state\.paid\.meta\.connected && !state\.paid\.meta\.ready\) loadMetaAds\(\);/.test(ui), 'partial Meta save leaves the box stuck');
});

console.log('\n──── the error box shows the platform\'s reason ────');

check('post() carries the server\'s detail into the message the panel shows', () => {
    const ui = read('src/components/assistant-campaigns.js');
    const post = ui.slice(ui.indexOf('async function post(payload)'), ui.indexOf('async function load()'));
    assert.ok(post.includes('withPlatformReason(data.error ||') && post.includes('data.detail'), 'post() drops detail');
    assert.ok(ui.includes('withPlatformReason(d.error ||'), 'image upload does not use the same wording');
});

check('the reason is cleaned into a sentence (status code and ERROR :: scaffolding removed)', () => {
    const ui = read('src/components/assistant-campaigns.js');
    const src = ui.slice(ui.indexOf('function withPlatformReason('), ui.indexOf('async function load()'));
    // eslint-disable-next-line no-new-func
    const withPlatformReason = new Function(`${src}; return withPlatformReason;`)();
    assert.equal(withPlatformReason('Did not finish.', null), 'Did not finish.');
    assert.equal(
        withPlatformReason('LinkedIn did not finish.', '422: ERROR :: /campaignGroup :: Invalid Urn format.\nERROR :: /politicalIntent :: field is required\n'),
        'LinkedIn did not finish. Reason given: /campaignGroup: Invalid Urn format. · /politicalIntent: field is required',
    );
    assert.equal(
        withPlatformReason('Meta did not finish.', '400: Invalid parameter (code 100/1487390) Pick a page'),
        'Meta did not finish. Reason given: Invalid parameter (code 100/1487390) Pick a page',
    );
});

console.log('\n──── the ad-category declaration is the advertiser\'s ────');

check('stage_paid refuses without the declaration, refuses special categories, and records who declared', () => {
    const camp = code(read('netlify/functions/campaigns.ts'));
    assert.ok(camp.includes("if (declaration === 'special') {"), 'special categories not refused');
    assert.ok(camp.includes("if (declaration !== 'none') {"), 'missing declaration not refused');
    assert.ok(camp.indexOf("if (declaration !== 'none') {") < camp.indexOf('await adapter.stageCampaign('), 'declaration checked after the network call');
    assert.ok(camp.includes("actionType: 'campaign_paid_staged'") && camp.includes("adCategoryDeclaration: 'none',") && camp.includes('stagedByUserId: userId'));
});

check('the form asks for the declaration and only sends it when ticked', () => {
    const ui = read('src/components/assistant-campaigns.js');
    assert.ok(ui.includes('data-cmp-paid-declare='), 'no declaration box');
    assert.ok(ui.indexOf('[data-cmp-paid-declare="${id}"]') < ui.indexOf("adCategoryDeclaration: 'none',"), 'sent before it is checked');
});

check('a LinkedIn reconnect keeps the chosen account, even when the listing fails', () => {
    const cb = code(read('netlify/functions/linkedin-ads-oauth-callback.ts'));
    assert.ok(cb.includes('const accountList = accounts ?? prevAccounts;'));
    assert.ok(cb.includes('selectedAccountUrn: keepAccount,'));
    assert.ok(!cb.includes('selectedAccountUrn: null as string | null'), 'reconnect still wipes the choice');
});

console.log('\n──── the named production exception (META_ADS_PROD_ORG_IDS) ────');

check('only workspaces listed in META_ADS_PROD_ORG_IDS may use Meta ads on production', () => {
    const saved = process.env.META_ADS_PROD_ORG_IDS;
    try {
        delete process.env.META_ADS_PROD_ORG_IDS;
        assert.equal(metaAdsAllowedInProduction(58), false);
        process.env.META_ADS_PROD_ORG_IDS = ' 58, 101 ';
        assert.equal(metaAdsAllowedInProduction(58), true);
        assert.equal(metaAdsAllowedInProduction(101), true);
        assert.equal(metaAdsAllowedInProduction(5), false);
        process.env.META_ADS_PROD_ORG_IDS = 'all';
        assert.equal(metaAdsAllowedInProduction(58), false, 'a non-id value must not open it to everyone');
    } finally {
        if (saved === undefined) delete process.env.META_ADS_PROD_ORG_IDS; else process.env.META_ADS_PROD_ORG_IDS = saved;
    }
});

check('every production gate for Meta uses the exception; LinkedIn has none', () => {
    const ca = code(read('src/utils/ad-networks/campaign-adapter.ts'));
    assert.ok(ca.includes('if (env.isProduction && !metaAdsAllowedInProduction(organisationId))'));
    // LinkedIn's own production refusal stays, unconditional.
    const raw = read('src/utils/ad-networks/campaign-adapter.ts');
    const li = raw.slice(raw.indexOf('// LinkedIn —'));
    assert.ok(/if \(env\.isProduction\) \{\s*\n\s*return \{ ok: false, label, noAdapter: true/.test(li));
    const camp = code(read('netlify/functions/campaigns.ts'));
    assert.ok(camp.includes("...(metaAdsAllowedInProduction(orgId) ? ['meta'] : []),"));
    assert.ok(camp.includes('{ isProduction: env.isProduction && !metaAdsAllowedInProduction(orgId) })'));
    const media = code(read('netlify/functions/meta-ads-media.ts'));
    assert.ok(media.includes('&& !metaAdsAllowedInProduction(orgId)'));
    // The registry itself stays empty.
    assert.equal(anyNetworkAvailable(), false);
});

// ── A mocked end-to-end stage. Async, so it runs in main() (the runner is CJS: no top-level await).
async function main(): Promise<void> {
    const name = 'stageCampaign: campaign PAUSED first, then ad set, creative, ad — ids read from bodies, token never in a URL';
    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string; body: any; auth: string | null }[] = [];
    try {
        let n = 0;
        globalThis.fetch = (async (url: string, init: any) => {
            calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization ?? null });
            n++;
            return new Response(JSON.stringify({ id: String(1000 + n) }), { status: 200 });
        }) as never;
        const adapter = createMetaAdapter({ accessToken: 'TOKEN', accountId: '555', pageId: 'PAGE' });
        const res = await adapter.stageCampaign({
            campaignId: 2, organisationId: 1, name: 'Test', dailyBudgetGbp: 5,
            variants: [{ variantId: 0, headline: 'H', body: 'B', destinationUrl: 'https://x.test', targeting: buildMetaTargeting({ countries: ['GB'] }), mediaUrn: 'HASH' }],
        });
        assert.deepEqual(calls.map((c) => c.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '')),
            ['act_555/campaigns', 'act_555/adsets', 'act_555/adcreatives', 'act_555/ads']);
        assert.equal(calls[0].body.status, 'PAUSED');
        assert.equal(calls[1].body.campaign_id, '1001');
        assert.equal(calls[1].body.daily_budget, 500);
        assert.equal(calls[2].body.object_story_spec.link_data.image_hash, 'HASH');
        assert.deepEqual(calls[3].body.creative, { creative_id: '1003' });
        assert.equal(calls[3].body.adset_id, '1002');
        assert.deepEqual(res, { externalCampaignId: '1001', externalVariantIds: { 0: '1004' }, status: 'paused' });
        assert.ok(calls.every((c) => c.auth === 'Bearer TOKEN' && !c.url.includes('TOKEN')), 'the token reached a URL');

        calls.length = 0;
        await adapter.activateCampaign('1001');
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/1001$/);
        assert.deepEqual(calls[0].body, { status: 'ACTIVE' });

        // Metrics are read per ad, never from the currently selected account.
        calls.length = 0;
        globalThis.fetch = (async (url: string, init: any) => {
            calls.push({ url, method: init?.method ?? 'GET', body: null, auth: init?.headers?.Authorization ?? null });
            return new Response(JSON.stringify({ data: [{ ad_id: url.match(/\/(\d+)\/insights/)![1], impressions: '10', clicks: '2', spend: '1.50', date_start: '2026-11-19' }] }), { status: 200 });
        }) as never;
        const m = await adapter.fetchMetrics(['1004', '1005'], 3);
        assert.ok(calls.every((c) => /\/(1004|1005)\/insights\?/.test(c.url)) && calls.length === 2, 'metrics not read per ad');
        assert.ok(!calls.some((c) => c.url.includes('act_555/insights')));
        assert.equal(m.length, 2);
        assert.equal(m[0].spendGbp, 1.5);

        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    } finally {
        globalThis.fetch = realFetch;
    }
    console.log(`\n${passed} checks passed.\n`);
}
main();
