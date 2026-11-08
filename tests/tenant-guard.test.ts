// tests/tenant-guard.test.ts
// US-DB-1.3.1: Unit tests for the session + tenant guard utilities.
//
// Run:  npx tsx tests/tenant-guard.test.ts
//
// Verifies the security-critical behaviour:
//   - the activeOrganisationId claim is decoded but NEVER trusted for authz
//   - a stale claim (org the user has left) is ignored and falls back to membership
//   - role gating rejects insufficient roles
// No live DB is required — userOrganisations queries are served by a small mock
// that returns canned rows per query in order.

// JWT_SECRET must exist before session.ts is imported (it reads it at module load).
process.env.JWT_SECRET = 'test-secret-for-tenant-guard';

import assert from 'node:assert';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; });
}

// A drizzle-like query builder whose every method is chainable and which resolves
// (when awaited) to the next canned result in `queue`. One full chain == one item.
function mockDb(queue: unknown[][]): any {
    let i = 0;
    const builder: any = {
        select: () => builder,
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(queue[i++] ?? []).then(resolve, reject),
    };
    return builder;
}

(async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { getSession } = await import('../src/utils/session');
    const { resolveActiveOrg, requireOrgMembership, getOrgMembers } = await import('../src/utils/tenant');

    const SECRET = process.env.JWT_SECRET!;
    const ev = (token?: string) => ({ headers: token ? { cookie: `aura_session=${token}` } : {} }) as any;

    console.log('US-DB-1.3.1 — session + tenant guard');

    // ── session.ts ────────────────────────────────────────────────────────────
    await check('decodes userId + activeOrganisationId from a valid token', () => {
        const token = jwt.sign({ userId: 42, activeOrganisationId: 7 }, SECRET);
        const s = getSession(ev(token));
        assert.strictEqual(s?.userId, 42);
        assert.strictEqual(s?.activeOrganisationId, 7);
    });

    await check('legacy token without org claim yields undefined activeOrganisationId', () => {
        const token = jwt.sign({ userId: 42 }, SECRET);
        const s = getSession(ev(token));
        assert.strictEqual(s?.userId, 42);
        assert.strictEqual(s?.activeOrganisationId, undefined);
    });

    await check('rejects a token signed with the wrong secret', () => {
        const forged = jwt.sign({ userId: 99, activeOrganisationId: 1 }, 'wrong-secret');
        assert.strictEqual(getSession(ev(forged)), null);
    });

    await check('returns null when no cookie present', () => {
        assert.strictEqual(getSession(ev()), null);
    });

    // ── resolveActiveOrg ─────────────────────────────────────────────────────
    await check('valid claim is honoured (membership confirmed)', async () => {
        const db = mockDb([[{ role: 'admin' }]]); // requireOrgMembership → member
        const org = await resolveActiveOrg(db, 42, 5);
        assert.deepStrictEqual(org, { organisationId: 5, role: 'admin', assistantIds: null });
    });

    await check('STALE claim is ignored, falls back to current membership', async () => {
        // 1st query (membership check for claimed org) → empty (not a member)
        // 2nd query (fallback most-recent membership) → org 7
        const db = mockDb([[], [{ organisationId: 7, role: 'member' }]]);
        const org = await resolveActiveOrg(db, 42, 999 /* org they left */);
        assert.deepStrictEqual(org, { organisationId: 7, role: 'member' },
            'must not trust the claimed org; must use real membership');
    });

    await check('no claim → uses most-recent membership', async () => {
        const db = mockDb([[{ organisationId: 3, role: 'owner' }]]);
        const org = await resolveActiveOrg(db, 42);
        assert.deepStrictEqual(org, { organisationId: 3, role: 'owner' });
    });

    await check('no membership anywhere → null', async () => {
        const db = mockDb([[]]);
        assert.strictEqual(await resolveActiveOrg(db, 42), null);
    });

    // ── requireOrgMembership role gating ───────────────────────────────────────
    await check('role gating rejects insufficient role', async () => {
        const db = mockDb([[{ role: 'viewer' }]]);
        assert.strictEqual(await requireOrgMembership(db, 42, 5, ['owner', 'admin']), null);
    });

    await check('role gating accepts allowed role', async () => {
        const db = mockDb([[{ role: 'admin' }]]);
        assert.deepStrictEqual(await requireOrgMembership(db, 42, 5, ['owner', 'admin']), { role: 'admin' });
    });

    await check('non-member → null', async () => {
        const db = mockDb([[]]);
        assert.strictEqual(await requireOrgMembership(db, 42, 5), null);
    });

    // ── getOrgMembers ──────────────────────────────────────────────────────────
    await check('getOrgMembers returns the member ids', async () => {
        const db = mockDb([[{ userId: 1 }, { userId: 2 }, { userId: 3 }]]);
        assert.deepStrictEqual(await getOrgMembers(db, 5), [1, 2, 3]);
    });

    console.log(`\n${passed} checks passed`);
})();
