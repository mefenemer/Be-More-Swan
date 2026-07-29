// tests/connection-ownership.test.ts
// system_connections.user_id is nullable, and integrations.ts reads `user_id IS NULL` as the
// sentinel for a "system-wide platform definition". meta-oauth.ts never set the column, so every
// Facebook and Instagram connection ever made was written into that sentinel shape.
//
// Two consequences, both live on prod until 2026-07-29:
//   1. The Connections page rendered a workspace's own Facebook/Instagram as "Not connected" —
//      the rows fell into the catalog branch, which is hard-coded to connected: false.
//   2. The catalog query carried NO organisation filter, so those rows — service name, external
//      account id, and metadata holding a Facebook Page id/name and Instagram username — were
//      returned to every signed-in user of every other tenant. Tokens were never in reach:
//      safeColumns has always withheld vaultRefKey.
//
// Fixed on both sides: the writer attributes the row, and the reader is org-scoped so an
// unattributed row can never cross a tenant boundary again.
//
// Run:  npx tsx tests/connection-ownership.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const metaOauth = read('../netlify/functions/meta-oauth.ts');
const integrations = read('../netlify/functions/integrations.ts');

console.log('\nConnection ownership + tenant scoping\n');

// ── The writer ───────────────────────────────────────────────────────────────────────────────

test('a new Meta connection is written with an owner', () => {
    const insert = metaOauth.slice(metaOauth.indexOf('db.insert(systemConnections)'));
    assert.match(
        insert.slice(0, 400),
        /userId: connectionUserId/,
        'the insert must attribute the row — a NULL owner is read as a global catalog row',
    );
});

test('the owner survives the round trip through Meta', () => {
    // The callback is a top-level redirect back from Meta; the session cookie cannot be relied on,
    // which is exactly why organisationId already travelled in the signed state.
    assert.match(metaOauth, /signState\(\{[^}]*userId: String\(userId\)/, 'userId must ride in the signed state');
    assert.match(metaOauth, /state\.userId \? parseInt\(state\.userId\) : null/, 'and be read back out');
});

test('a flow already in flight across the deploy still gets an owner', () => {
    // Old state has no userId. Falling back to the org's first member beats writing another NULL.
    assert.match(metaOauth, /const connectionUserId = stateUserId \?\? orgUser\?\.id \?\? null/);
});

test('reconnecting heals a NULL owner but never reassigns a real one', () => {
    // A teammate reconnecting a shared account must not take ownership of it.
    assert.match(metaOauth, /existing\.userId == null && connectionUserId \? \{ userId: connectionUserId \}/);
    assert.match(
        metaOauth,
        /\.select\(\{ id: systemConnections\.id, userId: systemConnections\.userId \}\)/,
        'the upsert lookup must read userId to make that decision',
    );
});

// ── The reader ───────────────────────────────────────────────────────────────────────────────

test('the unattributed-row query is scoped to the caller’s organisation', () => {
    const catalog = integrations.slice(
        integrations.indexOf('const systemCatalog'),
        integrations.indexOf('const userConnections'),
    );
    assert.match(catalog, /eq\(systemConnections\.organisationId, currentOrgId\)/, 'no org filter — cross-tenant read');
    assert.ok(
        !/from\(systemConnections\)\.where\(isNull\(systemConnections\.userId\)\)/.test(integrations),
        'the unscoped form is back',
    );
});

test('a caller with no organisation reads no connections at all', () => {
    // Previously an org-less session got EVERY unattributed row on the platform.
    const catalog = integrations.slice(
        integrations.indexOf('const systemCatalog'),
        integrations.indexOf('const userConnections'),
    );
    assert.match(catalog, /currentOrgId\s*\?/, 'must branch on org presence');
    assert.match(catalog, /:\s*\[\]/, 'and fall back to an empty list, not an unscoped query');
});

test('vault references never reach the client', () => {
    // The pre-existing guarantee this fix relies on when scoping the exposure.
    // Bounded to the object literal itself — the surrounding comments discuss vaultRefKey by name.
    const start = integrations.indexOf('const safeColumns');
    const safeCols = integrations.slice(start, integrations.indexOf('};', start));
    assert.ok(!safeCols.includes('vaultRefKey'), 'token reference must never be selected');
    assert.ok(!/accessToken|refreshToken/.test(safeCols));
});

console.log(`\n${passed} passed\n`);
