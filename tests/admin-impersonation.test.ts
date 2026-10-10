// tests/admin-impersonation.test.ts
// US-ADM-1.2.1: admin impersonation, end to end.
//
// Impersonation had NEVER worked until 2026-10-10, for three independent reasons — each pinned below:
//   1. admin.html POSTed without `action: 'start'`, so admin-impersonate 400'd every attempt.
//   2. Nothing honoured the aura_impersonation cookie: tenant resolution read only aura_session, so
//      even a successful start landed the admin in their own (empty) workspace.
//   3. workspace.html never called action 'end' (it called a different, unauthenticated function
//      that trusted an UNVERIFIED token), so the audit trail never recorded an end.
//
// And the safety contract: an impersonated workspace is READ-ONLY. requireTenant refuses every
// write, and the dangerous endpoints that never touch requireTenant block explicitly.
//
// Run: npx tsx tests/admin-impersonation.test.ts

process.env.JWT_SECRET = 'test-secret-for-impersonation';

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; });
}

// Drizzle-like builder: every chain resolves (when awaited) to the next canned result.
function mockDb(queue: unknown[][]): any {
    let i = 0;
    const builder: any = {
        select: () => builder, from: () => builder, where: () => builder,
        orderBy: () => builder, limit: () => builder,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(queue[i++] ?? []).then(resolve, reject),
        get calls() { return i; },
    };
    return builder;
}

const ADMIN = 37;      // super_admin, deliberately no user_organisations row
const TARGET = 38;     // the customer
const TARGET_ORG = 37;

(async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const imp = await import('../src/utils/impersonation');
    const { requireTenant } = await import('../src/utils/tenant');
    const SECRET = process.env.JWT_SECRET!;

    const session = (userId: number, extra: object = {}) => jwt.sign({ userId, ...extra }, SECRET);
    const impToken = (over: object = {}, secret = SECRET, expiresIn = 900) => jwt.sign({
        scope: 'impersonate', userId: TARGET, realAdminId: ADMIN, realAdminEmail: 'admin@x',
        impersonatingUserId: TARGET, targetUserEmail: 'hello@x', targetUserName: 'Hello',
        sessionId: 'sess-1', reason: 'support_investigation', activeOrganisationId: TARGET_ORG, ...over,
    }, secret, { expiresIn });
    const cookie = (s?: string, i?: string) => [s && `aura_session=${s}`, i && `aura_impersonation=${i}`].filter(Boolean).join('; ');
    const ev = (c: string, httpMethod = 'GET') => ({ httpMethod, headers: { cookie: c } }) as any;
    const usersRows = (adminRole = 'super_admin', targetRole: string | null = null) =>
        [{ id: ADMIN, role: adminRole }, { id: TARGET, role: targetRole }];

    console.log('\nAdmin impersonation — the cookie\n');

    await check('a valid cookie parses; a forged, expired or wrong-scope one does not', () => {
        assert.strictEqual(imp.getImpersonationSession(cookie(undefined, impToken()))?.impersonatingUserId, TARGET);
        assert.strictEqual(imp.getImpersonationSession(cookie(undefined, impToken({}, 'wrong-secret'))), null);
        assert.strictEqual(imp.getImpersonationSession(cookie(undefined, impToken({}, SECRET, -10))), null);
        assert.strictEqual(imp.getImpersonationSession(cookie(undefined, impToken({ scope: 'other' }))), null);
        assert.strictEqual(imp.getImpersonationSession(undefined), null);
    });

    await check('honoured only for the admin who started it, and only while they hold `impersonate`', async () => {
        const c = cookie(session(ADMIN), impToken());
        assert.ok(await imp.resolveImpersonation(mockDb([usersRows()]), c, ADMIN));
        // A cookie carried into someone else's session (e.g. left behind after a logout) is inert.
        assert.strictEqual(await imp.resolveImpersonation(mockDb([usersRows()]), c, 999), null);
        // Demoted mid-session: the very next request stops resolving the customer.
        assert.strictEqual(await imp.resolveImpersonation(mockDb([usersRows('platform_admin')]), c, ADMIN), null);
        // Target became an admin, or was deleted.
        assert.strictEqual(await imp.resolveImpersonation(mockDb([usersRows('super_admin', 'support_agent')]), c, ADMIN), null);
        assert.strictEqual(await imp.resolveImpersonation(mockDb([[{ id: ADMIN, role: 'super_admin' }]]), c, ADMIN), null);
    });

    await check('no cookie → no DB query at all (every ordinary request stays free)', async () => {
        const db = mockDb([]);
        assert.strictEqual(await imp.resolveImpersonation(db, cookie(session(ADMIN)), ADMIN), null);
        assert.strictEqual(db.calls, 0);
    });

    console.log('\nrequireTenant under impersonation\n');

    await check('a GET resolves the TARGET user and the TARGET org, and says so', async () => {
        const db = mockDb([usersRows(), [{ role: 'owner' }]]);
        const ctx = await requireTenant(ev(cookie(session(ADMIN), impToken())), db);
        assert.ok(!('error' in ctx), JSON.stringify(ctx));
        assert.deepStrictEqual(ctx, {
            userId: TARGET, organisationId: TARGET_ORG, role: 'owner',
            impersonation: { realAdminId: ADMIN, sessionId: 'sess-1' },
        });
    });

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await check(`a ${method} is refused 403 { impersonation: true } before any org lookup`, async () => {
            const db = mockDb([usersRows()]);
            const ctx = await requireTenant(ev(cookie(session(ADMIN), impToken()), method), db);
            assert.ok('error' in ctx);
            assert.strictEqual(ctx.error.statusCode, 403);
            assert.strictEqual(JSON.parse(ctx.error.body).impersonation, true);
            assert.strictEqual(db.calls, 1, 'must stop before resolving the org');
        });
    }

    await check('a GET declared `mutates` (OAuth connect start) is refused too', async () => {
        const ctx = await requireTenant(ev(cookie(session(ADMIN), impToken())), mockDb([usersRows()]), { mutates: true });
        assert.ok('error' in ctx && ctx.error.statusCode === 403);
    });

    await check('without impersonation `mutates` changes nothing', async () => {
        const ctx = await requireTenant(ev(cookie(session(TARGET))), mockDb([[{ organisationId: 5, role: 'owner' }]]), { mutates: true });
        assert.ok(!('error' in ctx) && ctx.userId === TARGET && ctx.organisationId === 5 && !ctx.impersonation);
    });

    await check('an unbound cookie falls through to the caller\'s OWN identity', async () => {
        // Session user 50 holds a cookie issued to admin 37: ignored; user 50 resolves their own org.
        // (The binding check runs before any query, so the only query is user 50's own membership.)
        const db = mockDb([[{ organisationId: 9, role: 'member' }]]);
        const ctx = await requireTenant(ev(cookie(session(50), impToken())), db);
        assert.ok(!('error' in ctx) && ctx.userId === 50 && ctx.organisationId === 9 && !ctx.impersonation);
    });

    await check('the impersonation cookie alone (no aura_session) authenticates nothing', async () => {
        const ctx = await requireTenant(ev(cookie(undefined, impToken())), mockDb([]));
        assert.ok('error' in ctx && ctx.error.statusCode === 401);
    });

    await check('role gating applies to the TARGET\'s role', async () => {
        const ctx = await requireTenant(ev(cookie(session(ADMIN), impToken())), mockDb([usersRows(), [{ role: 'viewer' }]]), { roles: ['owner'] });
        assert.ok('error' in ctx && ctx.error.statusCode === 403);
    });

    console.log('\nThe dangerous-action block\n');

    await check('checkImpersonationBlock fires on the cookie AND on the legacy replaced-session token', () => {
        assert.strictEqual(imp.checkImpersonationBlock(cookie(session(ADMIN), impToken()), 'x')?.statusCode, 403);
        assert.strictEqual(imp.checkImpersonationBlock({ headers: { cookie: cookie(session(ADMIN), impToken()) } }, 'x')?.statusCode, 403);
        assert.strictEqual(imp.checkImpersonationBlock(cookie(session(ADMIN, { scope: 'impersonate' })), 'x')?.statusCode, 403);
        assert.strictEqual(imp.checkImpersonationBlock(cookie(session(ADMIN)), 'x'), null);
        assert.strictEqual(imp.checkImpersonationBlock(cookie(session(ADMIN), impToken({}, SECRET, -10)), 'x'), null);
    });

    // Every endpoint that moves money, deletes, exports, changes identity, publishes, sends or
    // revokes on the customer's behalf. Most never call requireTenant, so its write block cannot
    // reach them — each must call checkImpersonationBlock itself.
    const MUST_BLOCK = [
        'billing-upgrade', 'billing-downgrade', 'billing-cancel', 'billing-attach-payment', 'billing-setup-intent',
        'billing-portal', 'billing-information', 'confirm-payment', 'create-plan-checkout-intent', 'create-x-credit-checkout',
        'account-delete-request', 'delete-workspace-asset', 'admin-delete-record',
        'data-export', 'data-export-download', 'admin-sar-export', 'update-profile', 'confirm-email-change', 'admin-api',
        'revoke-connections', 'revoke-integration-authorization',
        'publish-blog', 'unpublish-blog', 'send-outbound-email', 'approve-post', 'bias-audit',
    ];
    for (const fn of MUST_BLOCK) {
        await check(`${fn} blocks during impersonation`, () => {
            const src = read(`netlify/functions/${fn}.ts`);
            assert.match(src, /import \{ checkImpersonationBlock \} from '\.\.\/\.\.\/src\/utils\/impersonation';/);
            assert.match(src, /checkImpersonationBlock\(event(\.headers\.cookie)?, '[a-z_]+'\)/);
        });
    }

    for (const fn of ['meta-oauth', 'social-oauth-init', 'linkedin-ads-oauth-init']) {
        await check(`${fn}: the connect start is declared \`mutates\``, () => {
            assert.match(read(`netlify/functions/${fn}.ts`), /requireTenant\(event, (db|getDb\(\)), \{ mutates: true \}\)/);
        });
    }

    console.log('\nThe wiring\n');

    await check('ONE module reads the cookie: the old guard and the unauthenticated end function are gone', () => {
        assert.ok(!existsSync(join(root, 'src/utils/impersonation-guard.ts')));
        assert.ok(!existsSync(join(root, 'netlify/functions/admin-end-impersonation.ts')));
        assert.ok(!read('workspace.html').includes('admin-end-impersonation'));
    });

    await check('requireTenant consults resolveImpersonation before the caller\'s own org', () => {
        const t = read('src/utils/tenant.ts');
        const fn = t.slice(landmark(t, 'export async function requireTenant('));
        assert.ok(landmark(fn, 'resolveImpersonation(') < landmark(fn, 'resolveActiveOrg(db, session.userId'));
        assert.ok(landmark(fn, 'impersonationWriteBlock(') < landmark(fn, 'resolveActiveOrg(db, imp.impersonatingUserId'));
    });

    await check('admin.html sends action: \'start\' and stores no session token client-side', () => {
        const a = read('admin.html');
        const fn = a.slice(landmark(a, 'async function startImpersonation('), landmark(a, '// ── Send Login Link'));
        assert.match(fn, /action: 'start'/);
        assert.ok(!fn.includes('admin_original_token'), 'the admin token must not be copied into sessionStorage');
        assert.ok(!fn.includes('has already replaced aura_session'), 'the false comment is back');
    });

    await check('admin-impersonate: start needs `impersonate`; end and status do not', () => {
        const f = read('netlify/functions/admin-impersonate.ts');
        const perm = landmark(f, "requirePermission(adminUser?.role, 'impersonate')");
        assert.ok(landmark(f, "body.action === 'start'") < perm, 'permission must be checked inside start');
        assert.ok(landmark(f, "body.action === 'end'") < landmark(f, "body.action === 'start'"));
        assert.ok(landmark(f, "event.httpMethod === 'GET'") < perm);
        // end records the audit only for the admin who started the session
        const end = f.slice(landmark(f, "body.action === 'end'"), landmark(f, "body.action === 'start'"));
        assert.match(end, /imp\.realAdminId === adminId/);
        assert.match(end, /action: 'impersonate_end'/);
        assert.match(end, /'Set-Cookie': CLEAR_COOKIE/);
        assert.match(f, /const CLEAR_COOKIE = `\$\{IMPERSONATION_COOKIE\}=; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0`/);
        assert.match(f, /action: 'impersonate_start'/);
        assert.match(f, /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=\$\{IMPERSONATION_TTL_SECONDS\}/);
    });

    await check('workspace.html asks status by GET, ends with action \'end\', and binds the button at parse time', () => {
        const w = read('workspace.html');
        const block = w.slice(landmark(w, '// US-ADM-1.2.1: defined at parse time'), landmark(w, '<!-- US-AUD-5.2.1'));
        assert.match(block, /fetch\('\/\.netlify\/functions\/admin-impersonate', \{ credentials: 'same-origin'/);
        assert.match(block, /JSON\.stringify\(\{ action: 'end' \}\)/);
        assert.match(block, /getElementById\('end-impersonation-btn'\)\?\.addEventListener\('click'/);
        assert.match(block, /read-only/);
        // the banner must not carry `hidden` and `flex` together (hidden-class-loses-to-inline-flex)
        const banner = w.slice(landmark(w, '<div id="impersonation-banner"'), landmark(w, '<script>\n// US-ADM-1.2.1'));
        assert.ok(!/class="[^"]*\bhidden\b[^"]*\bflex\b[^"]*"/.test(banner.split('\n')[0]));
        assert.match(w, /window\.initImpersonationBanner\(\);/);
    });

    console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
})();
