// tests/rbac-matrix.test.ts
// src/utils/rbac.ts is the single source of truth for admin authorisation. It earned that
// role by replacing four parallel schemes that had silently drifted apart: rank-based
// checks in some functions, hand-rolled ALLOWED_ROLES arrays in others, bare
// `role === 'super_admin'` string checks elsewhere, and a fifth copy of the role lists in
// the admin.html nav. The drift was not theoretical — Communications was gated to roles
// the API refused, and Manage Emails was unreachable entirely.
//
// These checks lock the properties that keep the four from drifting again.
// Run:  npx tsx tests/rbac-matrix.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_ROLES, hasPermission, permissionsForRole, isAdminRole } from '../src/utils/rbac';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Ascending privilege. 'admin' is a legacy alias sitting at billing_admin level.
const ASCENDING = ['support_agent', 'billing_admin', 'platform_admin', 'super_admin'];

check('privilege is monotonic — each role holds everything below it', () => {
    for (let i = 1; i < ASCENDING.length; i++) {
        const lower = new Set(permissionsForRole(ASCENDING[i - 1]));
        const higher = new Set(permissionsForRole(ASCENDING[i]));
        for (const p of lower) {
            assert.ok(
                higher.has(p),
                `${ASCENDING[i]} is missing '${p}', which ${ASCENDING[i - 1]} holds — the hierarchy is not a superset chain`,
            );
        }
        assert.ok(higher.size > lower.size, `${ASCENDING[i]} should hold strictly more than ${ASCENDING[i - 1]}`);
    }
});

check('legacy admin alias resolves to billing_admin level', () => {
    assert.deepEqual(permissionsForRole('admin'), permissionsForRole('billing_admin'));
});

check('super_admin holds every permission', () => {
    const all = permissionsForRole('super_admin');
    for (const role of ADMIN_ROLES) {
        for (const p of permissionsForRole(role)) {
            assert.ok(all.includes(p), `super_admin is missing '${p}' held by ${role}`);
        }
    }
});

check('unknown / absent roles hold nothing', () => {
    assert.deepEqual(permissionsForRole(null), []);
    assert.deepEqual(permissionsForRole(undefined), []);
    assert.deepEqual(permissionsForRole('user'), []);
    assert.deepEqual(permissionsForRole('not_a_role'), []);
    assert.equal(hasPermission('user', 'view_users'), false);
    assert.equal(hasPermission(null, 'view_users'), false);
});

check('unknown permissions are denied, even to super_admin', () => {
    // A typo'd permission key must fail closed rather than sail through.
    assert.equal(hasPermission('super_admin', 'nonexistent_permission'), false);
});

check('isAdminRole covers exactly the admin roles', () => {
    for (const role of ADMIN_ROLES) assert.ok(isAdminRole(role), `${role} should be an admin role`);
    assert.equal(isAdminRole('user'), false);
    assert.equal(isAdminRole(null), false);
});

// The nav is the surface that drifted the furthest, because its gate lived in a separate
// file from the matrix it was supposed to mirror. admin.html now declares a permission key
// per child; if one is misspelled or renamed in rbac.ts, _can() silently denies it and the
// page vanishes from the portal with no error. That is precisely how Manage Emails was lost,
// so assert every key the nav references actually exists.
check('every permission referenced by the admin.html nav exists in the matrix', () => {
    const html = readFileSync(join(root, 'admin.html'), 'utf8');
    const navBlock = html.slice(landmark(html, 'const ADMIN_CATS'), landmark(html, 'function _getAdminRole'));
    assert.ok(navBlock.length > 0, 'could not locate the ADMIN_CATS block in admin.html');

    const referenced = [...navBlock.matchAll(/perm:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(referenced.length > 20, `expected the nav to declare many perms, found ${referenced.length}`);

    const known = new Set(permissionsForRole('super_admin'));
    for (const perm of new Set(referenced)) {
        assert.ok(known.has(perm), `admin.html nav references '${perm}', which is not in the rbac.ts matrix`);
    }
});

check('no nav child is orphaned — every child declares a perm or is explicitly open', () => {
    const html = readFileSync(join(root, 'admin.html'), 'utf8');
    const navBlock = html.slice(landmark(html, 'const ADMIN_CATS'), landmark(html, 'function _getAdminRole'));
    const children = [...navBlock.matchAll(/\{\s*view:\s*'[a-z-]+'[^}]*\}/g)].map((m) => m[0]);
    assert.ok(children.length > 20, `expected many nav children, found ${children.length}`);
    for (const child of children) {
        assert.ok(/perm:\s*('[a-z_]+'|null)/.test(child), `nav child has no perm key: ${child.trim()}`);
    }
});

console.log(`\n${passed} checks passed.`);
