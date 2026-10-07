// tests/connection-move.test.ts
// The re-armed tenant-collision block and its way out: src/utils/connection-collision.ts,
// src/utils/connection-move.ts, move-connection.ts, the collision modal in workspace.html, and
// db/system-connections-tenant-unique-v2.sql.
//
// What has to hold:
//   · one owner connecting two businesses never collides: Meta is keyed on the Page / IG account
//     (not the login), and LinkedIn (a personal member profile) is exempt altogether
//   · only an owner/admin of the HOLDING workspace, acting from the REQUESTING one, can move
//   · a move never revokes the provider token (it would kill the login's other connections)
// No network, no database.
//
// Run:  npx tsx tests/connection-move.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTenantCollision, COLLISION_EXEMPT_SERVICES, collisionParam } from '../src/utils/connection-collision';
import { judgeMove } from '../src/utils/connection-move';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// A db that fails the test if it is touched: proves the exemption returns before any query.
const untouchableDb = new Proxy({}, { get() { throw new Error('the database was queried'); } }) as any;
const attempt = { id: 7, requestingOrgId: 38, existingOrgId: 37, serviceName: 'facebook', externalUserId: 'page-1', status: 'pending' };

(async () => {
console.log('connection-collision');
await check('LinkedIn is exempt even when the block is armed, and never queries', async () => {
    process.env.ENFORCE_TENANT_COLLISION = 'true';
    try {
        assert.equal(await findTenantCollision(untouchableDb, { serviceName: 'LinkedIn', externalUserId: 'member-1', organisationId: 38 }), null);
    } finally { delete process.env.ENFORCE_TENANT_COLLISION; }
});
await check('Facebook, Instagram and X are NOT exempt', () => {
    for (const s of ['facebook', 'instagram', 'x']) assert.ok(!COLLISION_EXEMPT_SERVICES.has(s), s);
});
await check('the block stays off without the env var', async () => {
    assert.equal(await findTenantCollision(untouchableDb, { serviceName: 'facebook', externalUserId: 'p', organisationId: 1 }), null);
});
await check('collisionParam carries the id, and nothing when unrecorded', () => {
    assert.equal(collisionParam(12), '&collision=12');
    assert.equal(collisionParam(null), '');
});
await check('Meta is keyed on the Page / IG account, not the Facebook login', () => {
    const src = read('src/utils/meta-accounts.ts');
    assert.ok(src.includes("const externalUserId = platform === 'instagram' ? ig!.id : page.id;"));
});

console.log('judgeMove');
await check('an owner of the holding workspace, acting from the requesting one, may move', () =>
    assert.equal(judgeMove(attempt, 38, 'owner'), null));
await check('an admin there may move', () => assert.equal(judgeMove(attempt, 38, 'admin'), null));
await check('a plain member there may not', () =>
    assert.deepEqual(judgeMove(attempt, 38, 'member'), { canMove: false, reason: 'not_admin_there' }));
await check('a non-member there may not', () =>
    assert.deepEqual(judgeMove(attempt, 38, null), { canMove: false, reason: 'not_admin_there' }));
await check('someone else\'s attempt cannot be used (wrong active workspace)', () =>
    assert.deepEqual(judgeMove(attempt, 99, 'owner'), { canMove: false, reason: 'not_yours' }));
await check('a missing attempt is refused', () =>
    assert.deepEqual(judgeMove(null, 38, 'owner'), { canMove: false, reason: 'not_found' }));

console.log('wiring');
await check('every OAuth collision redirect carries the attempt id', () => {
    const meta = read('netlify/functions/meta-oauth.ts');
    assert.ok(meta.includes("metaErr('tenant_collision') + collisionParam(attemptId)"));
    const social = read('netlify/functions/social-oauth-callback.ts');
    assert.equal(social.match(/tenant_collision&platform=\w+\$\{collisionParam\(attemptId\)\}/g)?.length, 2);
});
await check('a move does NOT revoke the token at the provider', () => {
    const src = read('src/utils/connection-move.ts').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/fetch\(/.test(src), 'connection-move.ts must not call any provider');
    assert.ok(!src.includes('/permissions'));
});
await check('a move re-checks eligibility before writing', () => {
    const src = read('src/utils/connection-move.ts');
    const body = src.slice(src.indexOf('export async function moveConnectionOut'));
    assert.ok(body.indexOf('await checkMove(') < body.indexOf('db.update(systemConnections)'));
});
await check('the endpoint refuses without saying who holds the account', () => {
    const src = read('netlify/functions/move-connection.ts');
    assert.ok(src.includes("if (!check.canMove) return json(200, { canMove: false });"));
    assert.ok(src.includes("This account cannot be moved from here."));
});
await check('the modal passes the collision id and offers Move only when allowed', () => {
    const html = read('workspace.html');
    assert.ok(html.includes("qs.get('collision')"));
    assert.ok(html.includes("_showCollisionModal?.(label, (platform || '').toLowerCase(), collisionId, assistantId)"));
    assert.ok(html.includes('id="collision-move-btn" type="button" class="hidden'));
    assert.ok(html.includes('if (!d || !d.canMove) return;'));
    assert.ok(read('integrations.js').includes('window._intOAuthUrlFor = function'));
});
await check('the v2 index excludes LinkedIn, has a new name, and sorts after the drop', () => {
    const sql = read('db/system-connections-tenant-unique-v2.sql').split('\n').filter(l => !l.startsWith('--')).join('\n');
    assert.ok(sql.includes('system_connections_tenant_unique_v2'));
    assert.ok(sql.includes("service_name <> 'linkedin'"));
    assert.ok('system-connections-tenant-unique-v2.sql' > 'system-connections-drop-provider-tenant-unique.sql');
    assert.ok(!read('db/system-connections-drop-provider-tenant-unique.sql').includes('_v2'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
})();
