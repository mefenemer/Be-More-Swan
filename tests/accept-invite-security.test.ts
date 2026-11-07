// tests/accept-invite-security.test.ts
// accept-invite.ts used to trust orgId and role from the URL with any token in the column shared by
// the sign-up and magic-link emails: anyone with an account could join any workspace as an admin.
// This drives the real handler with a stubbed database and tries each way in.
//
// Run:  npx tsx tests/accept-invite-security.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { PgDialect } from 'drizzle-orm/pg-core';
import { signInvite, verifyInviteSignature } from '../src/utils/invite-link';

const SECRET = 'test-secret-for-invite-links';
process.env.JWT_SECRET = SECRET;
process.env.BASE_URL = 'https://example.test';

const USER = { id: 7, email: 'someone@example.test', firstName: null, tokenExpiresAt: new Date(Date.now() + 60_000), status: 'pending_verification' };

// What the stubbed database holds and what the handler did to it.
let state: { tokenFindsUser: boolean; user: typeof USER; hasInvitedRow: boolean; selects: number; updates: Array<{ set: Record<string, unknown>; where: string }>; inserts: number };
function reset(over: Partial<typeof state> = {}) {
    state = { tokenFindsUser: true, user: USER, hasInvitedRow: true, selects: 0, updates: [], inserts: 0, ...over };
}
const dialect = new PgDialect();
const whereText = (cond: any) => { const q = dialect.sqlToQuery(cond); return `${q.sql} ${JSON.stringify(q.params)}`; };

const fakeDb = {
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => {
                    state.selects++;
                    return state.selects === 1 ? (state.tokenFindsUser ? [state.user] : []) : [{ name: 'Acme' }];
                },
            }),
        }),
    }),
    update: () => ({
        set: (set: Record<string, unknown>) => ({
            where: (cond: any) => {
                const entry = { set, where: whereText(cond) };
                state.updates.push(entry);
                const isClaim = 'role' in set;
                return {
                    returning: async () => (isClaim && state.hasInvitedRow ? [{ id: 1 }] : []),
                    then: (ok: (v: unknown) => void) => ok(undefined),
                };
            },
        }),
    }),
    insert: () => { state.inserts++; return { values: () => ({ onConflictDoNothing: async () => undefined }) }; },
};

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (/db\/client$/.test(request)) return { getDb: () => fakeDb };
    if (/utils\/notify$/.test(request)) return { createNotification: async () => undefined };
    if (/utils\/login-events$/.test(request)) return { recordLogin: async () => undefined };
    return load.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require('../netlify/functions/accept-invite').default as (r: Request, c: unknown) => Promise<Response>;

function call(params: Record<string, string>): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    return handler(new Request(`https://example.test/.netlify/functions/accept-invite?${qs}`, { headers: { host: 'example.test' } }), { requestId: 'test' });
}
const signed = (token: string, orgId: number, role: string) =>
    ({ token, orgId: String(orgId), role, sig: signInvite(token, orgId, role, SECRET) });

function assertRefused(res: Response) {
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('set-cookie'), null, 'a refused link must not sign anyone in');
    assert.equal(state.inserts, 0, 'a refused link must not add a membership');
    assert.ok(!state.updates.some((u) => 'status' in u.set), 'a refused link must not activate or clear the token');
}

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    total++;
    reset();
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    await test('a login or sign-up token with no signature cannot join a workspace', async () => {
        assertRefused(await call({ token: 'login-token', orgId: '42', role: 'admin' }));
        assert.equal(state.selects, 0, 'refused before reading the database');
    });

    await test('an invited viewer cannot change the role to admin', async () => {
        const link = signed('tok', 42, 'viewer');
        assertRefused(await call({ ...link, role: 'admin' }));
    });

    await test('an invite to one workspace cannot be pointed at another', async () => {
        const link = signed('tok', 42, 'member');
        assertRefused(await call({ ...link, orgId: '43' }));
    });

    await test('a signature from another secret is refused', async () => {
        assertRefused(await call({ token: 'tok', orgId: '42', role: 'admin', sig: signInvite('tok', 42, 'admin', 'other-secret') }));
    });

    await test('the owner role can never be granted, even when signed', async () => {
        assertRefused(await call(signed('tok', 42, 'owner')));
    });

    await test('a validly signed link with no pending invite row joins nothing', async () => {
        reset({ hasInvitedRow: false });
        assertRefused(await call(signed('tok', 42, 'admin')));
    });

    await test('only an invited row can be claimed, so an existing role is never overwritten', async () => {
        await call(signed('tok', 42, 'viewer'));
        const claim = state.updates.find((u) => 'role' in u.set)!;
        assert.ok(claim.where.includes('"invited"'), `claim must require the invited role: ${claim.where}`);
        assert.ok(claim.where.includes('42'), `claim must be for this workspace: ${claim.where}`);
        assert.ok(claim.where.includes('7'), `claim must be for this user: ${claim.where}`);
    });

    await test('an unknown token is refused', async () => {
        reset({ tokenFindsUser: false });
        assertRefused(await call(signed('tok', 42, 'member')));
    });

    await test('an expired invite is refused', async () => {
        reset({ user: { ...USER, tokenExpiresAt: new Date(Date.now() - 1000) } });
        const res = await call(signed('tok', 42, 'member'));
        assert.equal(res.status, 410);
        assert.equal(res.headers.get('set-cookie'), null);
        assert.equal(state.updates.length, 0);
    });

    await test('a real invite still works: signed in with the invited role', async () => {
        const res = await call(signed('tok', 42, 'viewer'));
        assert.equal(res.status, 302);
        assert.ok(res.headers.get('set-cookie')?.includes('aura_session='));
        assert.ok(res.headers.get('location')?.includes('/workspace.html'));
        assert.deepEqual(state.updates[0].set, { role: 'viewer' }, 'the membership is claimed first');
        assert.ok('status' in state.updates[1].set, 'then the user is activated');
    });

    await test('signature helper rejects missing and malformed values', () => {
        const good = signInvite('tok', 42, 'member', SECRET);
        assert.equal(verifyInviteSignature('tok', 42, 'member', good, SECRET), true);
        assert.equal(verifyInviteSignature('tok', 42, 'member', null, SECRET), false);
        assert.equal(verifyInviteSignature('tok', 42, 'member', 'short', SECRET), false);
    });

    await test('the invite email and the page both carry the signature', () => {
        const root = path.resolve(__dirname, '..');
        assert.ok(readFileSync(path.join(root, 'netlify/functions/invite-member.ts'), 'utf8').includes('&sig=${sig}'));
        assert.ok(readFileSync(path.join(root, 'accept-invite.html'), 'utf8').includes('&sig=${encodeURIComponent(sig)}'));
    });

    console.log(`\n${passed}/${total} passed`);
})();
