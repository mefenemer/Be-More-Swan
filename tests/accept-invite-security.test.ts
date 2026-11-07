// tests/accept-invite-security.test.ts
// accept-invite.ts used to trust orgId and role from the URL with any token in the column shared by
// the sign-up and magic-link emails: anyone with an account could join any workspace as an admin.
// This drives the real handler with a stubbed database and tries each way in.
//
// Accepting is a POST sent only by a person's click, because email scanners open links and run page
// scripts. Opening the link (GET) must write nothing, whatever the link says.
//
// Run:  npx tsx tests/accept-invite-security.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { PgDialect } from 'drizzle-orm/pg-core';
import { signInvite, verifyInviteSignature } from '../src/utils/invite-link';
import { users, userOrganisations } from '../db/schema';

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
        from: (table: unknown) => ({
            where: () => ({
                limit: async () => {
                    state.selects++;
                    if (table === users) return state.tokenFindsUser ? [state.user] : [];
                    if (table === userOrganisations) return state.hasInvitedRow ? [{ id: 1 }] : [];
                    return [{ name: 'Acme' }];
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

const URL_BASE = 'https://example.test/.netlify/functions/accept-invite';
/** Accepting: what the Join button sends. */
function call(params: Record<string, string>): Promise<Response> {
    return handler(new Request(URL_BASE, { method: 'POST', headers: { host: 'example.test', 'content-type': 'application/json' }, body: JSON.stringify(params) }), { requestId: 'test' });
}
/** Opening the link: what a scanner, or the page on load, sends. */
function open(params: Record<string, string>, method = 'GET'): Promise<Response> {
    return handler(new Request(`${URL_BASE}?${new URLSearchParams(params)}`, { method, headers: { host: 'example.test' } }), { requestId: 'test' });
}
function assertNothingWritten(res: Response) {
    assert.equal(res.headers.get('set-cookie'), null, 'opening a link must not sign anyone in');
    assert.equal(state.updates.length, 0, 'opening a link must not update anything');
    assert.equal(state.inserts, 0, 'opening a link must not add anything');
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
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('set-cookie')?.includes('aura_session='));
        assert.ok((await res.json()).redirect.includes('/workspace.html'));
        assert.deepEqual(state.updates[0].set, { role: 'viewer' }, 'the membership is claimed first');
        assert.ok('status' in state.updates[1].set, 'then the user is activated');
    });

    await test('a plain GET of a valid invite writes nothing and only describes it', async () => {
        const res = await open(signed('tok', 42, 'viewer'));
        assert.equal(res.status, 200);
        assertNothingWritten(res);
        assert.deepEqual(await res.json(), { orgName: 'Acme', role: 'viewer', email: 's•••@example.test' });
    });

    await test('a scanner opening a link twice leaves it working for the person', async () => {
        await open(signed('tok', 42, 'viewer'));
        await open(signed('tok', 42, 'viewer'));
        assert.equal(state.updates.length, 0);
        assert.equal((await call(signed('tok', 42, 'viewer'))).status, 200);
    });

    await test('a plain GET refuses a bad link the same way, and writes nothing', async () => {
        for (const params of [
            { token: 'login-token', orgId: '42', role: 'admin' },
            { ...signed('tok', 42, 'viewer'), role: 'admin' },
            { ...signed('tok', 42, 'member'), orgId: '43' },
            signed('tok', 42, 'owner'),
        ]) {
            reset();
            const res = await open(params);
            assert.equal(res.status, 400);
            assert.equal(state.selects, 0, 'refused before reading the database');
            assertNothingWritten(res);
        }
    });

    await test('a plain GET with no pending invite row, or an expired one, writes nothing', async () => {
        reset({ hasInvitedRow: false });
        let res = await open(signed('tok', 42, 'admin'));
        assert.equal(res.status, 400);
        assertNothingWritten(res);

        reset({ user: { ...USER, tokenExpiresAt: new Date(Date.now() - 1000) } });
        res = await open(signed('tok', 42, 'member'));
        assert.equal(res.status, 410);
        assert.equal((await res.json()).expired, true);
        assertNothingWritten(res);
    });

    await test('no other method accepts an invite', async () => {
        for (const method of ['PUT', 'DELETE', 'PATCH']) {
            reset();
            const res = await open(signed('tok', 42, 'member'), method);
            assert.equal(res.status, 405);
            assertNothingWritten(res);
        }
    });

    await test('a malformed POST body is refused without throwing', async () => {
        const post = (body: string) => handler(new Request(URL_BASE, { method: 'POST', headers: { host: 'example.test' }, body }), { requestId: 'test' });
        for (const body of ['not json', 'null', '{"token":1,"orgId":42,"role":"admin","sig":{}}']) {
            reset();
            assertRefused(await post(body));
        }
    });

    await test('the session cookie is one auth-check.js can read, or the person lands on the login page', async () => {
        const res = await call(signed('tok', 42, 'viewer'));
        assert.ok(!/httponly/i.test(res.headers.get('set-cookie') || ''), 'must not be HttpOnly');
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
        const page = readFileSync(path.join(root, 'accept-invite.html'), 'utf8');
        assert.ok(page.includes("sig:   params.get('sig')"), 'the page reads the signature from the link');
        assert.equal(page.match(/method: 'POST'/g)?.length, 1, 'the page has one POST');
        assert.ok(/joinBtn\.addEventListener\('click'[\s\S]{0,300}method: 'POST'[\s\S]{0,120}JSON\.stringify\(link\)/.test(page), 'it sits in the click and sends the whole link');
    });

    console.log(`\n${passed}/${total} passed`);
})();
