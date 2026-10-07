// tests/disconnect-revoke.test.ts
// Disconnect must not revoke a token that something else still uses: src/utils/disconnect-revoke.ts
// and the DELETE handler in netlify/functions/integrations.ts.
//
// What has to hold:
//   · Meta's DELETE /me/permissions (which kills the whole Facebook LOGIN) runs only when no other
//     active facebook/instagram row, in any workspace, shares the row's metadata.fbUserId
//   · a Meta row without a recorded fbUserId is never revoked remotely
//   · the vault secret is deleted only when no other active row reads the same vault_ref_key
//   · LinkedIn / X revoke their own per-workspace token unless another row reads the same secret
// No network, no database.
//
// Run:  npx tsx tests/disconnect-revoke.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDisconnectRevoke } from '../src/utils/disconnect-revoke';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const free = { loginSharedElsewhere: false, vaultSharedElsewhere: false };

console.log('planDisconnectRevoke');
check('Facebook: the same login connected elsewhere → no remote revoke, own secret still deleted', () => {
    assert.deepEqual(planDisconnectRevoke({ serviceName: 'facebook', fbUserId: 'u-1', ...free, loginSharedElsewhere: true }),
        { revokeAtProvider: false, deleteVaultSecret: true });
});
check('Instagram (any case) is guarded the same way', () => {
    assert.equal(planDisconnectRevoke({ serviceName: 'Instagram', fbUserId: 'u-1', ...free, loginSharedElsewhere: true }).revokeAtProvider, false);
});
check('Meta: the last row for that login → revoke', () => {
    assert.deepEqual(planDisconnectRevoke({ serviceName: 'facebook', fbUserId: 'u-1', ...free }),
        { revokeAtProvider: true, deleteVaultSecret: true });
});
check('Meta: no recorded fbUserId → never revoke remotely', () => {
    assert.equal(planDisconnectRevoke({ serviceName: 'facebook', fbUserId: null, ...free }).revokeAtProvider, false);
    assert.equal(planDisconnectRevoke({ serviceName: 'instagram', fbUserId: '', ...free }).revokeAtProvider, false);
});
check('a vault secret another row reads is neither revoked nor deleted, for every service', () => {
    for (const s of ['facebook', 'instagram', 'linkedin', 'x']) {
        assert.deepEqual(planDisconnectRevoke({ serviceName: s, fbUserId: 'u-1', ...free, vaultSharedElsewhere: true }),
            { revokeAtProvider: false, deleteVaultSecret: false }, s);
    }
});
check('LinkedIn / X revoke their own token (a shared login is a Meta-only concept)', () => {
    for (const s of ['linkedin', 'x']) {
        assert.deepEqual(planDisconnectRevoke({ serviceName: s, fbUserId: null, ...free, loginSharedElsewhere: true }),
            { revokeAtProvider: true, deleteVaultSecret: true }, s);
    }
});

console.log('sharing lookup');
const util = read('src/utils/disconnect-revoke.ts');
const lookup = util.slice(util.indexOf('export async function findDisconnectSharing'));
check('the login lookup spans every workspace, both Meta services, active rows only, excluding this row', () => {
    const q = lookup.slice(lookup.indexOf('[loginSharer]'), lookup.indexOf('return {'));
    assert.ok(q.length > 0, 'login lookup not found');
    assert.ok(q.includes("in ('facebook', 'instagram')"));
    assert.ok(q.includes("->>'fbUserId' = ${params.fbUserId}"));
    assert.ok(q.includes('eq(systemConnections.isActive, true)'));
    assert.ok(q.includes('ne(systemConnections.id, params.connectionId)'));
    assert.ok(!q.includes('organisationId'), 'must not be limited to one workspace');
});
check('the vault lookup matches vault_ref_key on active rows, excluding this row', () => {
    const q = lookup.slice(lookup.indexOf('[vaultSharer]'), lookup.indexOf('let loginSharer'));
    assert.ok(q.length > 0, 'vault lookup not found');
    assert.ok(q.includes('eq(systemConnections.vaultRefKey, params.vaultRefKey)'));
    assert.ok(q.includes('eq(systemConnections.isActive, true)'));
    assert.ok(q.includes('ne(systemConnections.id, params.connectionId)'));
});

console.log('integrations.ts DELETE');
const src = read('netlify/functions/integrations.ts');
const start = src.indexOf('US-SMM-4.1.2: Remote token revocation');
const del = src.slice(start, src.indexOf('Cancel scheduled posts linked to this connection', start));
check('the handler block is found', () => assert.ok(start > -1 && del.length > 0));
check('the plan is computed before any provider call', () => {
    const plan = del.indexOf('planDisconnectRevoke(');
    assert.ok(plan > -1);
    assert.ok(del.indexOf('findDisconnectSharing(') > -1 && del.indexOf('findDisconnectSharing(') < plan);
    assert.ok(plan < del.indexOf('fetch('));
});
check('the token is only read when the plan allows a remote revoke', () => {
    assert.ok(del.includes('plan.revokeAtProvider ? await getSecret('));
});
check('the vault secret is deleted only when the plan allows it', () => {
    assert.ok(del.includes('if (plan.deleteVaultSecret) await deleteSecret(db, conn.vaultRefKey)'));
    assert.equal(del.match(/deleteSecret\(/g)?.length, 1, 'no unconditional deleteSecret');
});
check('the connection lookup selects metadata (where fbUserId lives)', () => {
    const sel = src.slice(src.lastIndexOf('const [conn] = await db', start), start);
    assert.ok(sel.includes('metadata: systemConnections.metadata'));
});
check('meta-oauth still records fbUserId in the row metadata', () => {
    assert.ok(read('netlify/functions/meta-oauth.ts').includes('const connMetadata = { accountType, fbPageId, igUsername, pageName, fbUserId };'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
