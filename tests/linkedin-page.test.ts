// tests/linkedin-page.test.ts
// LinkedIn Company Page posting through the separate Community Management app.
//
// What must hold, and why each one bites:
//   · the switch is OFF unless both Community credentials AND LINKEDIN_PAGE_POSTING are set —
//     requesting Community scopes before LinkedIn approves the product fails the whole sign-in
//   · refresh and revoke present the app the token was ISSUED to, decided by the connection's own
//     external_user_id — a Page token refreshed with the main app's keys is rejected and the
//     connection condemned
//   · a Page is a business, so it is NOT exempt from the one-workspace collision rule; a member is
//   · the member flow is untouched: same scopes, same app, same callback
// Run:  npx tsx tests/linkedin-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkedinPageAccessEnabled, linkedinPageScopes, LINKEDIN_PAGE_DEFAULT_SCOPES } from '../src/config/linkedin-capabilities';
import { isLinkedInPageUrn, linkedInClientFor } from '../src/utils/linkedin-page';
import { findTenantCollision } from '../src/utils/connection-collision';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ENV_KEYS = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_COMMUNITY_CLIENT_ID', 'LINKEDIN_COMMUNITY_CLIENT_SECRET', 'LINKEDIN_PAGE_POSTING', 'LINKEDIN_PAGE_SCOPES', 'ENFORCE_TENANT_COLLISION'];
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)));
    try { fn(); }
    finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
}

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const init = src('netlify/functions/social-oauth-init.ts');
const callback = src('netlify/functions/social-oauth-callback.ts');

(async () => {
    // ── the switch ──────────────────────────────────────────────────────────
    await check('off with nothing set', () => withEnv({}, () => assert.equal(linkedinPageAccessEnabled(), false)));
    await check('off with credentials but no flag (keys may sit in Netlify before approval)', () =>
        withEnv({ LINKEDIN_COMMUNITY_CLIENT_ID: 'a', LINKEDIN_COMMUNITY_CLIENT_SECRET: 'b' }, () => assert.equal(linkedinPageAccessEnabled(), false)));
    await check('off with the flag but a missing secret', () =>
        withEnv({ LINKEDIN_COMMUNITY_CLIENT_ID: 'a', LINKEDIN_PAGE_POSTING: 'on' }, () => assert.equal(linkedinPageAccessEnabled(), false)));
    await check('on with both credentials and the flag', () =>
        withEnv({ LINKEDIN_COMMUNITY_CLIENT_ID: 'a', LINKEDIN_COMMUNITY_CLIENT_SECRET: 'b', LINKEDIN_PAGE_POSTING: 'On' }, () => assert.equal(linkedinPageAccessEnabled(), true)));

    // ── scopes ──────────────────────────────────────────────────────────────
    await check('default Page scopes are space-delimited and post as the organisation', () => withEnv({}, () => {
        const s = linkedinPageScopes();
        assert.equal(s, LINKEDIN_PAGE_DEFAULT_SCOPES);
        assert.ok(!s.includes(','));
        assert.ok(s.split(' ').includes('w_organization_social'));
    }));
    await check('LINKEDIN_PAGE_SCOPES override is normalised to single spaces', () =>
        withEnv({ LINKEDIN_PAGE_SCOPES: ' w_organization_social,  r_organization_admin ' }, () =>
            assert.equal(linkedinPageScopes(), 'w_organization_social r_organization_admin')));

    // ── which app owns a token ──────────────────────────────────────────────
    await check('isLinkedInPageUrn: organisation URN yes, member sub / person URN / empty no', () => {
        assert.equal(isLinkedInPageUrn('urn:li:organization:123'), true);
        assert.equal(isLinkedInPageUrn('abc123'), false);
        assert.equal(isLinkedInPageUrn('urn:li:person:abc'), false);
        assert.equal(isLinkedInPageUrn(null), false);
    });
    await check('a Page refreshes/revokes with the Community app, a member with the main app', () =>
        withEnv({ LINKEDIN_CLIENT_ID: 'main', LINKEDIN_CLIENT_SECRET: 'mainS', LINKEDIN_COMMUNITY_CLIENT_ID: 'comm', LINKEDIN_COMMUNITY_CLIENT_SECRET: 'commS' }, () => {
            assert.deepEqual(linkedInClientFor('urn:li:organization:9'), { clientId: 'comm', clientSecret: 'commS' });
            assert.deepEqual(linkedInClientFor('member-sub'), { clientId: 'main', clientSecret: 'mainS' });
        }));
    await check('the app is chosen even with the switch off (old Page connections still renew)', () =>
        withEnv({ LINKEDIN_COMMUNITY_CLIENT_ID: 'comm', LINKEDIN_COMMUNITY_CLIENT_SECRET: 'commS' }, () =>
            assert.equal(linkedInClientFor('urn:li:organization:9').clientId, 'comm')));
    await check('refresh and revoke both go through linkedInClientFor', () => {
        assert.ok(/linkedInClientFor\(externalUserId\)/.test(src('netlify/functions/refresh-social-tokens.ts')), 'refresh-social-tokens does not pick the app per connection');
        assert.ok(/linkedInClientFor\(conn\.externalUserId\)/.test(src('netlify/functions/integrations.ts')), 'disconnect revoke does not pick the app per connection');
    });

    // ── collision rule ──────────────────────────────────────────────────────
    // With enforcement on, an exempt member returns null BEFORE any query, so a db that throws
    // proves the exemption; a Page must reach the query.
    const throwingDb = { select: () => { throw new Error('queried'); } } as any;
    await check('a LinkedIn member is exempt from the collision rule', async () => {
        const saved = process.env.ENFORCE_TENANT_COLLISION;
        process.env.ENFORCE_TENANT_COLLISION = '1';
        try { assert.equal(await findTenantCollision(throwingDb, { serviceName: 'linkedin', externalUserId: 'member-sub', organisationId: 1 }), null); }
        finally { if (saved === undefined) delete process.env.ENFORCE_TENANT_COLLISION; else process.env.ENFORCE_TENANT_COLLISION = saved; }
    });
    await check('a LinkedIn Company Page is checked like any business account', async () => {
        const saved = process.env.ENFORCE_TENANT_COLLISION;
        process.env.ENFORCE_TENANT_COLLISION = '1';
        try { await assert.rejects(findTenantCollision(throwingDb, { serviceName: 'linkedin', externalUserId: 'urn:li:organization:5', organisationId: 1 }), /queried/); }
        finally { if (saved === undefined) delete process.env.ENFORCE_TENANT_COLLISION; else process.env.ENFORCE_TENANT_COLLISION = saved; }
    });

    // ── the OAuth handlers ──────────────────────────────────────────────────
    await check('init: linkedin_page uses the Community client and is gated on the switch', () => {
        const branch = init.slice(init.indexOf("platform === 'linkedin_page'"));
        assert.ok(init.includes("platform === 'linkedin_page'"), 'no linkedin_page branch');
        assert.ok(branch.includes('LINKEDIN_COMMUNITY_CLIENT_ID'), 'Page branch does not use the Community client');
        assert.ok(branch.includes('linkedinPageAccessEnabled()'), 'Page branch is not gated');
        assert.ok(branch.includes('linkedinPageScopes()'), 'Page branch does not use the Page scopes');
    });
    await check('callback: linkedin_page exchanges with the Community secret and lists Pages', () => {
        const start = callback.indexOf("if (platform === 'linkedin_page')");
        assert.ok(start > -1, 'no linkedin_page branch in callback');
        const branch = callback.slice(start, callback.indexOf('// ── X (Twitter)', start));
        assert.ok(branch.includes('LINKEDIN_COMMUNITY_CLIENT_SECRET'), 'Page branch does not use the Community secret');
        assert.ok(branch.includes('listAdministeredPages('), 'Page branch does not list Pages');
        assert.ok(branch.includes('linkedin_pick=1'), 'several Pages do not reach the picker');
        assert.ok(branch.includes('bindLinkedInPage('), 'one Page is not bound');
        assert.ok(!branch.includes('LINKEDIN_CLIENT_SECRET!'), 'Page branch reaches for the main app secret');
    });
    await check('callback: relevance treats a Company Page as LinkedIn', () => {
        assert.ok(/platform === 'linkedin_page' \? 'linkedin' : platform/.test(callback));
    });
    await check('the member flow is unchanged: main app, OpenID + Share scopes', () => {
        const member = init.slice(init.indexOf("if (platform === 'linkedin')"), init.indexOf("platform === 'linkedin_page'"));
        assert.ok(member.includes('process.env.LINKEDIN_CLIENT_ID'));
        assert.ok(member.includes("const scopes = 'openid profile email w_member_social'"));
    });
    await check('the picker binds only a Page from the stored list, in the same workspace', () => {
        const pick = src('netlify/functions/linkedin-page-pick.ts');
        assert.ok(pick.includes('pending.pages.find(p => p.urn === urn)'), 'picker trusts a URN from the browser');
        assert.ok(pick.includes('pending.organisationId !== organisationId'), 'picker does not check the workspace');
    });

    console.log(`\n${passed} checks passed.`);
})();
