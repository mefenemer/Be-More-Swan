// tests/meta-deletion-callbacks.test.ts
// meta-callbacks.ts originally served the Threads app only: it verified EVERY signed_request
// against THREADS_CLIENT_SECRET and revoked rows from workspace_integrations. Pointing the
// Facebook/Instagram app's data-deletion callback at it would therefore have failed the HMAC on
// every call and 400'd — a broken callback in Meta's eyes, worse than none at all.
//
// Two things had to be true to fix that, and both are easy to regress:
//   1. The route must carry the app segment, because the segment picks the verifying secret.
//      Verifying with the wrong secret is indistinguishable from a forgery.
//   2. The Facebook revoke must join on metadata->>'fbUserId'. Meta's callback sends the
//      APP-SCOPED USER ID; system_connections.external_user_id holds a Page id (facebook) or an
//      Instagram business account id (instagram). Joining on external_user_id matches nothing —
//      silently, with a 200 — so the deletion would appear to succeed and delete nothing.
//
// Run:  npx tsx tests/meta-deletion-callbacks.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const callbacks = read('../netlify/functions/meta-callbacks.ts');
const metaOauth = read('../netlify/functions/meta-oauth.ts');

console.log('\nMeta deletion + deauthorization callbacks\n');

// ── The route regex, executed for real ───────────────────────────────────────────────────────
// Lifted out of the source rather than duplicated, so a change to the pattern is exercised here
// instead of quietly diverging from a copy.
const routeSrc = callbacks.match(/path\.match\((\/.+\/[gimsuy]*)\);/)?.[1];
assert.ok(routeSrc, 'could not locate the route regex in meta-callbacks.ts — update this test');

const lastSlash = routeSrc!.lastIndexOf('/');
const routeRe = new RegExp(routeSrc!.slice(1, lastSlash), routeSrc!.slice(lastSlash + 1));
const route = (p: string) => {
    const m = p.match(routeRe);
    return m ? { app: m[1]?.toLowerCase() ?? 'threads', action: m[2] } : null;
};

test('facebook delete callback routes to the facebook app', () => {
    assert.deepStrictEqual(route('/api/meta/facebook/delete'), { app: 'facebook', action: 'delete' });
});

test('facebook uninstall callback routes to the facebook app', () => {
    assert.deepStrictEqual(route('/api/meta/facebook/uninstall'), { app: 'facebook', action: 'uninstall' });
});

test('threads routes still resolve to the threads app', () => {
    assert.deepStrictEqual(route('/api/meta/threads/delete'), { app: 'threads', action: 'delete' });
    assert.deepStrictEqual(route('/api/meta/threads/uninstall'), { app: 'threads', action: 'uninstall' });
});

test('an app-less path still means threads (the shape already registered with Meta)', () => {
    // This is the URL the Threads dashboard may already hold. If the segment became mandatory,
    // live Threads deauthorizations would start 404ing.
    assert.deepStrictEqual(route('/api/meta/delete'), { app: 'threads', action: 'delete' });
});

test('deletion-status is not mistaken for an app segment', () => {
    assert.deepStrictEqual(route('/api/meta/deletion-status'), { app: 'threads', action: 'deletion-status' });
});

test('an unknown app segment does not silently fall back to threads', () => {
    // /api/meta/tiktok/delete must not parse as action="tiktok" or app="threads" — verifying a
    // stranger's payload with our Threads secret is precisely what we must never do.
    const m = route('/api/meta/tiktok/delete');
    assert.ok(m === null, `expected no match for an unknown app segment, got ${JSON.stringify(m)}`);
});

// ── Secret selection ─────────────────────────────────────────────────────────────────────────
test('the facebook route verifies against META_APP_SECRET', () => {
    assert.ok(
        /app === 'facebook'\s*\?\s*'META_APP_SECRET'\s*:\s*'THREADS_CLIENT_SECRET'/.test(callbacks),
        'secret must be chosen by the route; a hardcoded THREADS_CLIENT_SECRET fails every FB callback',
    );
});

test('no unconditional THREADS_CLIENT_SECRET read remains', () => {
    assert.ok(
        !/const appSecret = process\.env\.THREADS_CLIENT_SECRET/.test(callbacks),
        'found the original unconditional secret read — the FB callback would 400 on every request',
    );
});

// ── The revoke join ──────────────────────────────────────────────────────────────────────────
test('facebook revoke joins on metadata->>fbUserId, not external_user_id', () => {
    const fn = callbacks.match(/async function revokeMetaConnections[\s\S]*?\n}/)?.[0];
    assert.ok(fn, 'revokeMetaConnections is missing');
    assert.ok(
        /metadata\}->>'fbUserId' = \$\{fbUserId\}/.test(fn!),
        'the join must be on the app-scoped user id stored in metadata',
    );
    assert.ok(
        !/externalUserId/.test(fn!),
        'external_user_id holds a Page/IG id, which Meta never sends — matching on it deletes nothing',
    );
});

test('facebook revoke covers both products', () => {
    const fn = callbacks.match(/async function revokeMetaConnections[\s\S]*?\n}/)?.[0] ?? '';
    assert.ok(
        /\['facebook',\s*'instagram'\]/.test(fn),
        'one Meta grant backs both products; removing the app withdraws consent for both',
    );
});

test('facebook revoke deletes the vault secret, not just the row status', () => {
    const fn = callbacks.match(/async function revokeMetaConnections[\s\S]*?\n}/)?.[0] ?? '';
    assert.ok(/deleteSecret\(db, row\.vaultRefKey\)/.test(fn), 'the encrypted token must be destroyed');
    assert.ok(/vaultRefKey: null/.test(fn), 'the row must stop pointing at a deleted secret');
});

// ── The writer that makes the join possible ──────────────────────────────────────────────────
test('meta-oauth persists fbUserId on the connection', () => {
    assert.ok(
        /const connMetadata = \{[^}]*fbUserId[^}]*\}/.test(metaOauth),
        'without fbUserId on the row, a verified deletion callback can never match it',
    );
    assert.ok(
        /graph\.facebook\.com\/v19\.0\/me\?fields=id/.test(metaOauth),
        'fbUserId has to be fetched at connect time — the token is dead by callback time',
    );
});

test('a failed /me lookup does not abort the connect', () => {
    // Deletion-callback matching is important, but not important enough to fail an otherwise
    // good connection over. The lookup is best-effort and logs loudly instead.
    // Anchor on `}` + newline so the match runs past `} catch (e) {` to the real end of the block.
    const block = metaOauth.match(/let fbUserId[\s\S]*?\n        \}\n/)?.[0] ?? '';
    assert.ok(block, 'could not locate the fbUserId lookup block in meta-oauth.ts');
    assert.ok(/try \{/.test(block) && /catch/.test(block), '/me lookup must be wrapped in try/catch');
    assert.ok(!/return \{ statusCode/.test(block), 'a /me failure must not short-circuit the OAuth callback');
});

// ── delete ≠ uninstall ───────────────────────────────────────────────────────────────────────
// Until 2026-08-05 both Meta actions took the same soft-revoke path: the token was deleted but
// the system_connections row survived, still carrying external_user_id (the Page / IG business
// account id), the cached follower counts and fbUserId in metadata. Meanwhile the status page
// Meta links the person to asserted that nothing was retained. A deletion request that does not
// delete is the one failure mode of this file that a reviewer would treat as a misrepresentation,
// and nothing about the code shape makes it obvious — hence these.
test('the facebook revoke distinguishes a deletion request from an uninstall', () => {
    assert.ok(
        /revokeMetaConnections\(\s*fbUserId: string,\s*mode: 'revoke' \| 'erase'/.test(callbacks),
        'revokeMetaConnections must take an explicit mode — the two callbacks are different requests',
    );
    assert.ok(
        /action === 'delete' \? 'erase' : 'revoke'/.test(callbacks),
        "only the 'delete' action may erase; 'uninstall' withdraws authorisation and keeps the row",
    );
});

test("a facebook data-deletion request removes the connection row itself", () => {
    const erase = callbacks.match(/if \(mode === 'revoke'\)[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(erase, 'could not locate the erase branch of revokeMetaConnections');
    assert.ok(
        /\.delete\(systemConnections\)/.test(erase),
        'erase must DELETE the row — an UPDATE to status=revoked leaves every Meta identifier in place',
    );
    for (const child of ['postInsights', 'webhookEvents']) {
        assert.ok(
            new RegExp(`\\.delete\\(${child}\\)`).test(erase),
            `${child}.connectionId is ON DELETE SET NULL, so erase must remove it explicitly or the Meta-derived rows are orphaned, not deleted`,
        );
    }
    assert.ok(
        erase.indexOf('.delete(postInsights)') < erase.indexOf('.delete(systemConnections)'),
        'children must be deleted before the connection row they point at',
    );
});

test('erase never touches the append-only audit tables', () => {
    // db/audit-log-immutability.sql revokes UPDATE/DELETE and attaches a forbid_mutation()
    // trigger; a DELETE against any of these raises rather than quietly doing nothing.
    for (const immutable of ['auditLogs', 'adminAuditLog', 'gdprErasureLog', 'dpaAcceptances']) {
        assert.ok(
            !new RegExp(`\\.delete\\(${immutable}\\)`).test(callbacks),
            `${immutable} is immutable by DDL — deleting from it throws`,
        );
    }
});

test('the deletion-status page does not overstate what was removed', () => {
    assert.ok(
        !/No further \$\{label\} data is retained/.test(callbacks),
        'the old absolute claim was false: published posts and the erasure record both survive',
    );
    assert.ok(
        /immutable record that this deletion took place/.test(callbacks),
        'the status page must disclose the audit record it keeps',
    );
});

console.log(`\n${passed} passed\n`);
