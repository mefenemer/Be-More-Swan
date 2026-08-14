// tests/facebook-insights-page-token.test.ts
// Two invariants in ingest-facebook-insights.ts, both of which failed silently in production and
// neither of which any behavioural test can reach (every path is a live Graph call).
//
// WHAT WENT WRONG: the vault holds the long-lived USER token meta-oauth.ts stored. Facebook
// PAGE-POST insights must be called with a PAGE access token. The ingester passed the user token
// straight through, Graph answered "(#190) This method must be called with a Page Access Token",
// and the 190 handler read that as an expired grant and wrote token_expired to the connection.
//
// The user-visible result was not a missing metric. It was an infinite reconnect loop: the
// Connections UI only suppresses its "connect Facebook?" prompt for status='active'
// (integrations.js), so every 6-hourly tick re-armed a popup that sent the user back to Facebook
// to re-authorise a connection that had never actually expired.
//
// Run:  npx tsx tests/facebook-insights-page-token.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const src = readFileSync(new URL('../netlify/functions/ingest-facebook-insights.ts', import.meta.url), 'utf8');

console.log('\ningest-facebook-insights — Page token + 190 handling\n');

// ── 1. The token handed to Graph must be a PAGE token ────────────────────────────────────────
test('derives the Page token through the publisher\'s own resolver', () => {
    assert.ok(
        /import \{ resolveFacebookPageCredentials \} from '\.\.\/\.\.\/src\/utils\/social-publish'/.test(src),
        'ingester no longer imports resolveFacebookPageCredentials — it is the single source of ' +
        'truth for Page credentials, shared with publish-facebook.ts so the two cannot drift',
    );
    assert.ok(
        src.includes('resolveFacebookPageCredentials(db, { organisationId, connectionId })'),
        'tokenFor no longer calls resolveFacebookPageCredentials',
    );
});

test('tokenFor never returns the raw vault token to the insights calls', () => {
    // The vault read still exists — but ONLY inside grantIsDead, which needs the user token to ask
    // Meta whether the grant is alive. If a vault read reappears in tokenFor, the original bug is
    // back: a user token would flow into the page-post insights edge again.
    const tokenFor = src.slice(landmark(src, 'async function tokenFor('), landmark(src, 'async function grantIsDead('));
    assert.ok(tokenFor.length > 0, 'could not locate tokenFor — update this test');
    assert.ok(
        !tokenFor.includes('getSecret('),
        'tokenFor reads the vault directly again; it must go through resolveFacebookPageCredentials',
    );
});

test('the org id reaches tokenFor — without it no Page token can be resolved', () => {
    // resolveFacebookPageCredentials needs an organisationId to fall back to the org's Meta
    // connection when the dedicated facebook row carries no usable Page id. A one-arg call would
    // typecheck against an optional param and silently degrade to "no token, skip every post".
    assert.ok(
        src.includes('tokenFor(post.connectionId, post.organisationId)'),
        'tokenFor is not being called with the post organisation id',
    );
});

// ── 2. A 190 must not condemn a connection on its own ────────────────────────────────────────
test('a 190 marks the connection SUSPECT, not expired', () => {
    assert.ok(
        !src.includes('expiredConnections'),
        'the old expiredConnections set is back — a 190 on one post must not mean "expired"',
    );
    assert.ok(
        src.includes('suspectConnections.add(post.connectionId)'),
        '190s are no longer collected as suspects',
    );
});

test('token_expired is only written after Meta confirms the grant is dead', () => {
    // Ordering is the whole assertion: grantIsDead must gate the write, not merely appear near it.
    const loop = src.indexOf('for (const connId of suspectConnections)');
    const guard = src.indexOf('grantIsDead(connId)', loop);
    const write = landmark(src, "status: 'token_expired'", loop);
    assert.ok(loop !== -1, 'could not locate the suspect-connection loop — update this test');
    assert.ok(guard !== -1 && guard < write, 'the token_expired write is not gated by grantIsDead');
    assert.ok(
        src.slice(guard, write).includes('continue'),
        'a live grant does not skip the write — the guard must short-circuit, not just log',
    );
});

test('grantIsDead fails closed — only a 190 on the credential itself counts', () => {
    const fn = src.slice(landmark(src, 'async function grantIsDead('), landmark(src, 'let updated = 0'));
    assert.ok(fn.length > 0, 'could not locate grantIsDead — update this test');
    assert.ok(
        fn.includes('data.error?.code === 190'),
        'grantIsDead no longer requires a 190 from the credential check',
    );
    // A network blip, a missing vault ref or a thrown fetch must all leave the connection alone.
    // Returning true on any of those would resurrect the loop through a different door.
    assert.ok(fn.includes('return false;'), 'grantIsDead has no fail-closed path');
    const catchBlock = fn.slice(landmark(fn, '} catch'));
    assert.ok(
        catchBlock.includes('return false'),
        'a thrown liveness check must not be treated as evidence of expiry',
    );
});

console.log(`\n${passed} checks passed\n`);
