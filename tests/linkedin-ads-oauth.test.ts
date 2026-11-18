// tests/linkedin-ads-oauth.test.ts
// The LinkedIn ADVERTISING authorisation flow, and the wall between it and the posting connection.
//
// The single most expensive mistake available here is putting the ads scopes into the social
// connector's scope string. LinkedIn refuses the ENTIRE authorization when an app requests a scope
// it does not hold — not the offending scope, the whole request — and that is precisely how
// production broke on 2026-07-20. Every workspace's LinkedIn posting would stop, and the failure
// would look like an unrelated platform error.
//
// So most of what follows asserts separation: separate scopes, separate service name, separate
// vault keys, separate callback, and a state from one flow that cannot be redeemed in the other.
//
// Source scans, because these are HTTP handlers with no pure core to unit test.
// Run:  npx tsx tests/linkedin-ads-oauth.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { LINKEDIN_ADS_SCOPES, adsCsrfKey } from '../netlify/functions/linkedin-ads-oauth-init';
import { ADS_SERVICE_NAME } from '../netlify/functions/linkedin-ads-oauth-callback';
import { linkedInAdsClient } from '../src/config/linkedin-capabilities';
import { ADS_REQUIRED_SCOPES, adsNeedsReconnect, adsScopeProblem, assessAdsReadiness } from '../src/utils/linkedin-ads-connection';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const init = read('netlify/functions/linkedin-ads-oauth-init.ts');
const cb = read('netlify/functions/linkedin-ads-oauth-callback.ts');
const social = read('netlify/functions/social-oauth-init.ts');

console.log('\n──── the ads scopes never reach the posting connector ────');

check('social-oauth-init still requests ONLY the approved member scopes', () => {
    // ⚠️ THE PRODUCTION-OUTAGE GUARD. If rw_ads appears in this string, every LinkedIn connect in
    // the product fails — LinkedIn refuses the whole authorization, not just the extra scope.
    assert.match(social, /const scopes = 'openid profile email w_member_social';/);
    for (const forbidden of ['rw_ads', 'r_ads_reporting', 'r_ads']) {
        assert.ok(!code(social).includes(forbidden), `${forbidden} has leaked into the social connector`);
    }
});

check('the ads flow requests exactly the spend scopes + company posting, space-delimited', () => {
    // Space-delimited per RFC 6749 §3.3 — a comma-joined list is rejected outright.
    // w_organization_social: the ad image is owned by, and the ad posted as, the company.
    assert.equal(LINKEDIN_ADS_SCOPES, 'rw_ads r_ads_reporting w_organization_social');
});

check('readiness requires exactly the scopes the flow requests', () => {
    assert.deepEqual(ADS_REQUIRED_SCOPES, LINKEDIN_ADS_SCOPES.split(' '));
});

check('an ads connection made before w_organization_social must reconnect to CREATE, but stays ready', () => {
    const base = {
        connectionId: 1, status: 'active',
        adAccounts: [{ urn: 'urn:li:sponsoredAccount:1', name: 'Acme', currency: 'GBP' }],
        selectedAccountUrn: 'urn:li:sponsoredAccount:1', selectedCurrency: 'GBP',
    } as const;
    const oldConn = { ...base, scopes: 'rw_ads r_ads_reporting' } as never;
    // ⚠️ Still READY: the optimiser halts through the adapter only when ready, and rw_ads can pause.
    assert.equal(assessAdsReadiness(oldConn).ready, true);
    assert.match(String(adsScopeProblem(oldConn)), /Reconnect/);
    assert.equal(adsNeedsReconnect(oldConn), true);
    const fresh = { ...base, scopes: LINKEDIN_ADS_SCOPES } as never;
    assert.equal(adsScopeProblem(fresh), null);
    assert.equal(adsNeedsReconnect(fresh), false);
});

check('the create paths refuse an old connection; the optimiser does not check scopes', () => {
    const media = read('netlify/functions/linkedin-ads-media.ts');
    const camp = read('netlify/functions/campaigns.ts');
    const opt = read('netlify/functions/optimise-paid-campaigns.ts');
    assert.ok(code(media).includes('adsScopeProblem('), 'media upload does not check scopes');
    assert.ok(code(camp).includes('adsScopeProblem(stageConnection)'), 'stage_paid does not check scopes');
    assert.ok(!code(opt).includes('adsScopeProblem'), 'the optimiser must keep pausing old connections');
});

check('the panel offers the connect link whenever the fix is a reconnect', () => {
    const ui = read('src/components/assistant-campaigns.js');
    assert.ok(ui.includes('|| p.needsReconnect ?'), 'reconnect link not offered');
});

check('the two flows are separate functions, not a shared one with a branch', () => {
    // A branch would put the spend path one boolean away from the posting path.
    assert.ok(!code(social).includes('linkedin_ads'), 'the social flow now knows about ads');
    assert.ok(!code(init).includes('w_member_social'), 'the ads flow now knows about posting');
});

console.log('\n──── the ads flow uses the Adverts app, never the main app ────');

check('both ads functions take their keys from linkedInAdsClient(), not LINKEDIN_CLIENT_*', () => {
    // The main app holds no Advertising product; sending rw_ads under its client id fails the whole
    // authorization. Init and callback must also present the SAME app or the exchange is refused.
    for (const [name, src] of [['init', init], ['callback', cb]] as const) {
        assert.ok(code(src).includes('linkedInAdsClient()'), `${name} does not use linkedInAdsClient()`);
        assert.ok(!/LINKEDIN_CLIENT_(ID|SECRET)/.test(code(src)), `${name} reads the main app's keys`);
    }
});

check('linkedInAdsClient reads only LINKEDIN_ADS_* and has no fallback to the main app', () => {
    const saved = { ...process.env };
    try {
        process.env.LINKEDIN_CLIENT_ID = 'main-app';
        process.env.LINKEDIN_CLIENT_SECRET = 'main-secret';
        delete process.env.LINKEDIN_ADS_CLIENT_ID;
        delete process.env.LINKEDIN_ADS_CLIENT_SECRET;
        assert.deepEqual(linkedInAdsClient(), { clientId: undefined, clientSecret: undefined });
        process.env.LINKEDIN_ADS_CLIENT_ID = '77ji7h15dgy32l';
        process.env.LINKEDIN_ADS_CLIENT_SECRET = 'ads-secret';
        assert.deepEqual(linkedInAdsClient(), { clientId: '77ji7h15dgy32l', clientSecret: 'ads-secret' });
    } finally {
        process.env = saved;
    }
});

console.log('\n──── the ads connection is a different row ────');

check('the service name is linkedin_ads and never linkedin', () => {
    // ⚠️ Widening this to 'linkedin' would overwrite the workspace's posting connection with an
    // ads token that cannot post — silently, on the next reconnect.
    assert.equal(ADS_SERVICE_NAME, 'linkedin_ads');
    const writes = code(cb);
    assert.ok(!/serviceName, 'linkedin'\)/.test(writes), 'a query is scoped to the social connection');
    assert.ok(!/serviceName: 'linkedin'/.test(writes), 'a write targets the social connection');
});

check('every read and write of system_connections is ads-scoped', () => {
    const body = code(cb);
    const selects = (body.match(/eq\(systemConnections\.serviceName, ADS_SERVICE_NAME\)/g) || []).length;
    assert.ok(selects >= 1, 'the lookup is not scoped by service name');
    assert.match(body, /serviceName: ADS_SERVICE_NAME/, 'the insert does not name the ads service');
});

check('the vault key and CSRF key are namespaced away from the social flow', () => {
    assert.equal(adsCsrfKey(42), 'oauth_csrf:42:linkedin_ads');
    assert.match(code(cb), /aura\/org-\$\{organisationId\}\/linkedin_ads-oauth/);
});

check('nothing in the ads callback deletes a connection or an integration', () => {
    // The blog-destination lesson: a disconnect fell through into deleteSecret/deleteIntegration
    // and would have stopped the Social Media Manager posting.
    const body = code(cb);
    assert.ok(!/deleteIntegration/.test(body));
    // deleteSecret IS used — but only on the one-time CSRF key, never on a stored token.
    const deletes = body.match(/deleteSecret\(db, ([^)]+)\)/g) || [];
    assert.ok(deletes.every((d) => d.includes('adsCsrfKey')), `deleteSecret used on something other than the CSRF key: ${deletes.join(', ')}`);
});

console.log('\n──── the handshake ────');

check('the redirect_uri carries no query string, in BOTH legs', () => {
    // LinkedIn matches the registered callback as an exact string, and its portal is hostile to
    // registering a URL with parameters — the 2026-07-20 lesson.
    const initUri = init.match(/const callbackUri = `([^`]+)`/)![1];
    const cbUri = cb.match(/const callbackUri = `([^`]+)`/)![1];
    assert.ok(!initUri.includes('?'), 'the init redirect_uri has a query string');
    assert.equal(initUri, cbUri, 'the two legs build different redirect_uris — the exchange will be rejected');
    assert.match(initUri, /linkedin-ads-oauth-callback$/);
});

check('the CSRF value is compared server-side and burned before the exchange', () => {
    // Burning first means a replayed callback cannot mint a second token.
    assert.ok(
        landmark(cb, 'await deleteSecret(db, adsCsrfKey(userId));', landmark(cb, 'One-time use'))
        < landmark(cb, "fetch('https://www.linkedin.com/oauth/v2/accessToken'"),
        'the CSRF key is burned after the token exchange, so a replay could mint a second token',
    );
    assert.match(code(cb), /stored\.csrf !== parsed\.csrf/);
});

check('an expired CSRF is refused, not merely noted', () => {
    assert.match(code(cb), /Date\.now\(\) > Number\(stored\.expiresAt\)/);
});

check('a state minted by the social flow cannot redeem an ads token', () => {
    // Both flows base64 a JSON blob into `state`. Without this check, a social state would sail
    // through the ads callback.
    assert.match(code(cb), /parsed\.flow !== 'linkedin_ads'/);
    assert.match(code(init), /flow: 'linkedin_ads'/);
});

check('the token exchange logs its STATUS, never its body', () => {
    // ⚠️ A token exchange response can carry credentials. This project has already had secrets
    // land in transcripts.
    const body = code(cb);
    assert.match(body, /console\.error\('\[linkedin-ads-oauth\] token exchange failed', \{ status: res\.status \}\)/);
    assert.ok(!/await res\.text\(\)[\s\S]{0,80}console\.error/.test(body), 'the failure body is being logged');
});

console.log('\n──── it refuses rather than asking for consent it cannot use ────');

check('the flow is gated on the paid_ads plan feature', () => {
    // The adapter it feeds is Development Tier and registered for development only. A workspace
    // that connected an ad account here would have granted permission we cannot act on — a control
    // that asks for consent it cannot use is worse than no control.
    assert.match(code(init), /hasFeatureByOrg\(db, organisationId, PAID_ADS_FEATURE\)/);
    assert.ok(
        landmark(init, 'hasFeatureByOrg') < landmark(init, 'const authUrl'),
        'the authorisation URL is built before the entitlement is checked',
    );
});

check('a declined consent screen is not reported as an error', () => {
    assert.match(code(cb), /if \(q\.error\) return redirect\('\/integrations\.html\?ads_error=declined'\)/);
});

console.log('\n──── account discovery is best-effort and honest about it ────');

check('"could not ask" and "you have none" stay distinguishable', () => {
    // ⚠️ null vs []. One says try again, the other says create an account in Campaign Manager
    // first. Collapsing them sends a user to fix a problem they do not have.
    assert.match(code(cb), /Promise<AdAccount\[\] \| null>/);
    assert.match(code(cb), /if \(accounts === null\) return redirect\([^)]*ads_accounts=unknown/);
    assert.match(code(cb), /if \(accounts\.length === 0\) return redirect\([^)]*ads_accounts=none/);
});

check('a failed listing still keeps the token', () => {
    // The authorisation is the thing worth keeping. Losing it because a listing call was throttled
    // would make the user repeat a consent flow for no reason.
    assert.ok(
        landmark(cb, 'const accounts = await fetchAdAccounts') < landmark(cb, 'await storeSecret(db, refKey'),
        'the token is stored before accounts are fetched — check the ordering intent',
    );
    // No early return between the fetch and the store.
    const between = cb.slice(landmark(cb, 'const accounts = await fetchAdAccounts'), landmark(cb, 'await storeSecret(db, refKey'));
    assert.ok(!/return redirect/.test(between), 'a failed account listing abandons the token');
});

check('the account currency is carried through, not assumed', () => {
    // Spend comes back in the account's currency. Assuming GBP is how a euro gets added to a pound.
    assert.match(code(cb), /currency: String\(e\.currency \?\? ''\)/);
});

console.log(`\n${passed} checks passed.\n`);
