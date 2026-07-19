// tests/social-credentials.test.ts
// Credential-store routing for the social publish path (src/utils/social-publish.ts).
//
// Run:  npx tsx tests/social-credentials.test.ts
//
// Social platforms are split across two connection stores — system_connections (Facebook,
// Instagram, LinkedIn, X) and workspace_integrations (Threads, YouTube). chooseCredentialSource
// is the branch that decides which one answers, and getting it wrong is how a post either
// publishes with the wrong account's token or fails with a misleading error. Verifies:
//   - a row owning a vaultRefKey always wins (the legacy path is untouched)
//   - a shadow row (vaultRefKey NULL) routes to workspace_integrations, not an error
//   - a missing row routes to workspace_integrations ONLY for platforms backed there
//   - a missing system_connections platform still fails closed
// Pure logic — no DB required.

import assert from 'node:assert';
import { chooseCredentialSource, WORKSPACE_BACKED_PLATFORMS, type ConnectionRow } from '../src/utils/social-publish';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const LEGACY = ['facebook', 'instagram', 'linkedin', 'x'];
const owned = (over: Partial<ConnectionRow> = {}): ConnectionRow =>
    ({ id: 7, vaultRefKey: 'aura/user-1/x-oauth', externalUserId: 'acct-1', ...over });
const shadow = (over: Partial<ConnectionRow> = {}): ConnectionRow =>
    ({ id: 9, vaultRefKey: null, externalUserId: null, ...over });

// ── The legacy path must be completely unaffected by the bridge ──────────────

check('a row with a vaultRefKey resolves from system_connections', () => {
    for (const p of LEGACY) {
        const s = chooseCredentialSource(p, owned());
        assert.equal(s.store, 'system_connections', p);
    }
});

check('system_connections carries through the row id, vault key and account id', () => {
    const s = chooseCredentialSource('linkedin', owned({ id: 42, vaultRefKey: 'k', externalUserId: 'urn:li:org:5' }));
    assert.equal(s.store, 'system_connections');
    if (s.store !== 'system_connections') return;
    assert.equal(s.connectionId, 42);
    assert.equal(s.vaultRefKey, 'k');
    assert.equal(s.externalUserId, 'urn:li:org:5');
});

check('an owned row wins even for a workspace-backed platform', () => {
    // If Threads ever gains a real system_connections row, its own token must take precedence
    // over the org-wide workspace integration rather than being silently shadowed by it.
    const s = chooseCredentialSource('threads', owned({ vaultRefKey: 'threads-key' }));
    assert.equal(s.store, 'system_connections');
});

// ── Shadow rows: the per-assistant toggle, no token ──────────────────────────

check('a shadow row routes to workspace_integrations, not an error', () => {
    for (const p of WORKSPACE_BACKED_PLATFORMS) {
        const s = chooseCredentialSource(p, shadow());
        assert.equal(s.store, 'workspace_integrations', p);
    }
});

check('a shadow row still surfaces its connection id for scoping', () => {
    const s = chooseCredentialSource('threads', shadow({ id: 99 }));
    assert.equal(s.store, 'workspace_integrations');
    if (s.store !== 'workspace_integrations') return;
    assert.equal(s.connectionId, 99, 'the toggle row id must survive so scoping can be attributed');
});

check('no row at all still routes a workspace-backed platform to its store', () => {
    // The common case: connected on the Integrations page, never toggled per-assistant.
    const s = chooseCredentialSource('youtube', undefined);
    assert.equal(s.store, 'workspace_integrations');
    if (s.store !== 'workspace_integrations') return;
    assert.equal(s.connectionId, null);
});

// ── Fail-closed: the bridge must not swallow genuine misconfiguration ────────

check('a missing legacy connection fails closed rather than falling through', () => {
    // Regression guard: routing Facebook to workspace_integrations would replace "no active
    // facebook connection" with a confusing "connect it on the Integrations page".
    for (const p of LEGACY) {
        assert.equal(chooseCredentialSource(p, undefined).store, 'none', p);
        assert.equal(chooseCredentialSource(p, shadow()).store, 'none', `${p} (shadow row)`);
    }
});

check('an unknown platform never routes anywhere', () => {
    assert.equal(chooseCredentialSource('pinterest', undefined).store, 'none');
    assert.equal(chooseCredentialSource('', undefined).store, 'none');
});

check('the workspace-backed set stays limited to the intended platforms', () => {
    // Widening this set silently re-routes a live platform's credentials — it should be a
    // deliberate edit that trips this test, not a drive-by.
    assert.deepEqual([...WORKSPACE_BACKED_PLATFORMS].sort(), ['threads', 'youtube']);
    for (const p of LEGACY) assert.equal(WORKSPACE_BACKED_PLATFORMS.has(p), false, p);
});

console.log(`\n${passed} passed`);
