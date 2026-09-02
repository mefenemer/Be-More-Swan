// tests/connection-selection.test.ts
// Four defects that let ONE workspace holding TWO accounts of the same platform corrupt itself.
// All four were live on prod until 2026-09-01, and none of them announced itself: the visible
// symptom was Meta answering "(#10) Application does not have permission for this action", which
// reads as an App Review / business-verification problem and sends you to the Meta dashboard.
//
//   1. VAULT KEY COLLISION. The Meta vault ref was `aura/org-<id>/<service>-token` — org+service,
//      no account. Two Instagram accounts in one workspace therefore shared ONE secret, so
//      connecting the second silently overwrote the first's token. Each row kept its own
//      external_user_id, so publishing paired account A's id with account B's token.
//
//   2. ARBITRARY CONNECTION PICK. The publish paths select the org's connection with `limit(1)`
//      and no ORDER BY, so which of several accounts published was left to the planner.
//
//   3. A DISCONNECTED ROW COULD WIN THE CARD. integrations.ts keeps one row per serviceName via
//      `.find()`, which takes the first match. Unordered, a deactivated row beat the live one and
//      the Connections page rendered "Connect Instagram" for an account that was publishing fine.
//
//   4. userId WAS NEVER SELECTED. The client filters on `c.userId !== null` and
//      `c.status === 'active' && c.userId`. With the column absent every row arrived
//      `userId === undefined`: the first filter passed everything, the second matched NOTHING, so
//      the "Use for this assistant" toggle saved an empty platform list.
//
// Run:  npx tsx tests/connection-selection.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark, landmarkEnd } from './landmark';
import { buildSocialRefKey } from '../src/utils/vault';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const metaOauth = read('../netlify/functions/meta-oauth.ts');
const publishIg = read('../netlify/functions/publish-instagram.ts');
const socialPublish = read('../src/utils/social-publish.ts');
const integrations = read('../netlify/functions/integrations.ts');

console.log('\nConnection selection + vault key scoping\n');

// ── 1. Vault key is account-scoped ───────────────────────────────────────────────────────────
// A real behavioural test, not a source scan: this is the defect that corrupted tokens.

test('two accounts of the same service in one org get DIFFERENT vault keys', () => {
    const a = buildSocialRefKey(37, 'instagram', '17841414318461950');
    const b = buildSocialRefKey(37, 'instagram', '17841467511229378');
    assert.notStrictEqual(a, b, 'same key for two accounts — the second connect would overwrite the first token');
});

test('the same account in different orgs stays isolated', () => {
    assert.notStrictEqual(
        buildSocialRefKey(37, 'instagram', '17841467511229378'),
        buildSocialRefKey(38, 'instagram', '17841467511229378'),
    );
});

test('facebook and instagram never share a key for one account', () => {
    // Both products are discovered from the same Meta Page, so this is a live collision risk.
    assert.notStrictEqual(buildSocialRefKey(37, 'facebook', '123'), buildSocialRefKey(37, 'instagram', '123'));
});

test('the key is stable for the same inputs', () => {
    // Reconnect must overwrite its OWN secret rather than orphan it under a new name.
    assert.strictEqual(buildSocialRefKey(37, 'instagram', '999'), buildSocialRefKey(37, 'instagram', '999'));
});

test('path separators and wildcards cannot ride in from a provider id', () => {
    const key = buildSocialRefKey(37, 'instagram', '../org-38/instagram-*');
    assert.ok(!key.includes('..'), 'a traversal sequence must not survive into a vault key');
    assert.ok(!key.includes('*'));
    assert.ok(key.startsWith('aura/org-37/'), 'and it must stay inside its own org prefix');
});

test('meta-oauth builds its ref key through the shared helper', () => {
    // The one place that CONSTRUCTS a Meta key; every reader takes it from the stored column.
    const at = landmark(metaOauth, 'const refKey =');
    const line = metaOauth.slice(at, landmark(metaOauth, '\n', at));
    assert.match(line, /buildSocialRefKey\(/, 'must not hand-roll the org+service key again');
});

// ── 2. Deterministic connection selection in the publish paths ───────────────────────────────

test('publish-instagram orders before limit(1)', () => {
    const at = landmark(publishIg, '.select({ vaultRefKey: systemConnections.vaultRefKey');
    const query = publishIg.slice(at, landmark(publishIg, '.limit(1)', at));
    assert.match(query, /\.orderBy\(/, 'an unordered limit(1) picks an arbitrary account');
});

test('every social-publish connection lookup is ordered', () => {
    // Three sites: resolveSocialCredentials, the dedicated FB connection, the IG fallback.
    const limits = [...socialPublish.matchAll(/\.limit\(1\)/g)].map(m => m.index!);
    assert.ok(limits.length >= 3, `expected the three connection lookups, found ${limits.length}`);
    for (const at of limits) {
        // Look back over the query that this limit(1) terminates.
        const window = socialPublish.slice(Math.max(0, at - 600), at);
        if (!window.includes('systemConnections')) continue;   // not a connection lookup
        assert.match(window, /\.orderBy\(/, `unordered connection lookup at offset ${at}`);
    }
});

// ── 3. A disconnected row must never win the Connections card ────────────────────────────────

test('userConnections is ordered live-first', () => {
    const at = landmark(integrations, 'const userConnections =');
    const query = integrations.slice(at, landmarkEnd(integrations, ';', at));
    assert.match(query, /\.orderBy\(/, 'the merge keeps one row per service via .find() — order decides which');
    assert.match(query, /isActive/, 'active rows must sort ahead of disconnected ones');
});

test('inactive rows are still returned, not filtered out', () => {
    // Hiding them would make a broken/expired connection vanish instead of prompting a reconnect.
    const at = landmark(integrations, 'const userConnections =');
    const query = integrations.slice(at, landmarkEnd(integrations, ';', at));
    assert.ok(!/where\([^)]*eq\(systemConnections\.isActive,\s*true\)/s.test(query),
        'an is_active filter here would silently drop connections that need attention');
});

test('the org is resolved through the shared resolver', () => {
    const at = landmark(integrations, 'const currentOrgId =');
    const window = integrations.slice(Math.max(0, at - 500), at + 100);
    assert.match(window, /resolveActiveOrg\(/, 'an unordered limit(1) picked an arbitrary workspace');
});

// ── 4. userId reaches the client ─────────────────────────────────────────────────────────────

test('safeColumns selects userId', () => {
    const start = landmark(integrations, 'const safeColumns');
    const safeCols = integrations.slice(start, landmark(integrations, '};', start));
    assert.match(safeCols, /userId:\s*systemConnections\.userId/,
        'without it the client filters see undefined: one passes everything, the other matches nothing');
});

test('safeColumns still withholds the vault reference', () => {
    // The pre-existing guarantee — re-asserted here because this suite ADDS a column to it.
    const start = landmark(integrations, 'const safeColumns');
    const safeCols = integrations.slice(start, landmark(integrations, '};', start));
    assert.ok(!safeCols.includes('vaultRefKey'), 'token reference must never be selected');
    assert.ok(!/accessToken|refreshToken/.test(safeCols));
});

test('the workspace_integrations bridge row is attributed', () => {
    // It is a real connection; the client drops `userId === null`, so an unattributed one vanishes.
    const at = landmark(integrations, 'id: -row.id,');
    assert.match(integrations.slice(at, at + 400), /userId:\s*currentUserId/);
});

console.log(`\n${passed} passed\n`);
