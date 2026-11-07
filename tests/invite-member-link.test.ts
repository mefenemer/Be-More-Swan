// tests/invite-member-link.test.ts
// An invite link names a pending membership row, not users.verification_token, which sign-up and
// login emails share. Drives the real invite-member handler with a stubbed database and reads the
// link it emails. accept-invite.ts is covered by accept-invite-security.test.ts.
//
// Run:  npx tsx tests/invite-member-link.test.ts

import assert from 'node:assert';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import { users, userOrganisations, organisations, aiAssistants } from '../db/schema';
import { verifyInviteLink } from '../src/utils/invite-link';

const SECRET = 'test-secret-for-invite-member';
process.env.JWT_SECRET = SECRET;
process.env.BASE_URL = 'https://example.test';

const OLD_JOIN_DATE = new Date('2026-11-01T09:00:00.000Z');

type Existing = { id: number; email: string; firstName: null; status: string } | null;
let state: {
    existing: Existing;
    membership: { role: string; userId: number } | null;
    userSelects: number;
    userUpdates: Array<Record<string, unknown>>;
    userInserts: Array<Record<string, unknown>>;
    rowInserts: Array<Record<string, any>>;
    rowDeletes: number;
    nextRowId: number;
    emails: Array<{ to: string; html: string }>;
};
function reset(over: Partial<typeof state> = {}) {
    state = { existing: null, membership: null, userSelects: 0, userUpdates: [], userInserts: [], rowInserts: [], rowDeletes: 0, nextRowId: 500, emails: [], ...over };
}

const rowsFor = (table: unknown) => {
    if (table === users) {
        state.userSelects++;
        return state.userSelects === 1 ? [{ email: 'owner@example.test', firstName: 'Olive', lastName: null }] : (state.existing ? [state.existing] : []);
    }
    if (table === userOrganisations) return state.membership ? [state.membership] : [];
    if (table === organisations) return [{ name: 'Acme' }];
    return [];
};
// The workspace's assistants, which an invite chooses from (src/utils/assistant-access.ts).
const WORKSPACE_ASSISTANTS = [{ id: 11, name: 'Sam' }, { id: 12, name: 'Jo' }];
const thenable = (get: () => unknown[], table?: unknown) => ({
    limit: async () => get(),
    then: (ok: (v: unknown) => void) => ok(table === aiAssistants ? WORKSPACE_ASSISTANTS : [{ value: 1 }]), // else the seat count
});
const insertInto = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
        const isUser = table === users;
        (isUser ? state.userInserts : state.rowInserts).push(values);
        const done = { returning: async () => [{ id: isUser ? 900 : state.nextRowId }], onConflictDoNothing: async () => undefined };
        return done;
    },
});
const fakeDb = {
    select: () => ({
        from: (table: unknown) => {
            const chain = { innerJoin: () => chain, where: () => thenable(() => rowsFor(table), table) };
            return chain;
        },
    }),
    update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
            where: async () => { if (table === users) state.userUpdates.push(values); },
        }),
    }),
    insert: insertInto,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        delete: () => ({
            where: () => ({
                returning: async () => { state.rowDeletes++; return [{ joinedAt: OLD_JOIN_DATE }]; },
            }),
        }),
        insert: insertInto,
    }),
};

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (/db\/client$/.test(request)) return { getDb: () => fakeDb };
    if (/utils\/notify$/.test(request)) return { createNotification: async () => undefined };
    if (/utils\/tenant$/.test(request)) return { requireTenant: async () => ({ userId: 1, organisationId: 42 }) };
    if (/utils\/team-seats$/.test(request)) return { getTeamAllowance: async () => ({}), canAddSeat: () => true, seatRefusal: () => ({}) };
    if (/utils\/email$/.test(request)) return { sendEmail: async (m: { to: string; html: string }) => { state.emails.push(m); } };
    return load.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require('../netlify/functions/invite-member').default as (r: Request, c: unknown) => Promise<Response>;

const invite = (body: Record<string, unknown>) => handler(new Request('https://example.test/.netlify/functions/invite-member', {
    method: 'POST',
    headers: { host: 'example.test', 'content-type': 'application/json', cookie: `aura_session=${jwt.sign({ userId: 1 }, SECRET)}` },
    body: JSON.stringify(body),
}), { requestId: 'test' });

function emailedLink(): URL {
    assert.equal(state.emails.length, 1, 'one email goes out');
    const href = /href="([^"]*accept-invite[^"]*)"/.exec(state.emails[0].html)?.[1];
    assert.ok(href, 'the email links to the invite page');
    return new URL(href.replace(/&amp;/g, '&'));
}
function assertLinkVerifies(link: URL, inviteId: number, role: string) {
    const q = link.searchParams;
    assert.equal(q.get('invite'), String(inviteId));
    assert.equal(q.get('token'), null, 'the link carries no token');
    assert.ok(verifyInviteLink(inviteId, Number(q.get('orgId')), q.get('role')!, Number(q.get('exp')), q.get('sig'), SECRET), 'accept-invite would accept this signature');
    assert.equal(q.get('orgId'), '42');
    assert.equal(q.get('role'), role);
}
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const aboutAWeekOut = (when: unknown) => Math.abs((when as Date).getTime() - Date.now() - SEVEN_DAYS) < 60_000;

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    total++;
    reset();
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    await test('a new person gets a stub with no token, a purge date, and a signed link to their row', async () => {
        assert.equal((await invite({ email: 'new@example.test', role: 'viewer', assistantIds: [12] })).status, 200);
        assert.equal(state.userInserts.length, 1);
        assert.ok(!('verificationToken' in state.userInserts[0]), 'no shared token');
        assert.equal(state.userInserts[0].status, 'pending_verification');
        assert.ok(aboutAWeekOut(state.userInserts[0].tokenExpiresAt), 'purge-ghost-accounts must not delete it before the invite ends');
        assert.equal(state.rowInserts[0].role, 'invited');
        assertLinkVerifies(emailedLink(), 500, 'viewer');
        assert.deepEqual(state.rowInserts[0].assistantIds, [12], 'only the assistant chosen');
        assert.ok(state.emails[0].html.includes('<strong>Jo</strong>') && !state.emails[0].html.includes('Sam'), 'the email names it');
    });

    await test('a new member or viewer must have their assistants chosen, never all by default', async () => {
        reset();
        const res = await invite({ email: 'new@example.test', role: 'member' });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, 'ASSISTANTS_REQUIRED');
        assert.equal((await invite({ email: 'new@example.test', role: 'member', assistantIds: [] })).status, 400);
        assert.equal((await invite({ email: 'new@example.test', role: 'member', assistantIds: [99] })).status, 400, 'not this workspace\'s');
        assert.equal(state.rowInserts.length + state.userInserts.length, 0);
    });

    await test('the expiry in the link is 7 days out, matching the email', async () => {
        await invite({ email: 'new@example.test', assistantIds: [11] });
        assert.ok(aboutAWeekOut(new Date(Number(emailedLink().searchParams.get('exp')))));
    });

    await test('a resend to an unverified person replaces the row, keeps its join date, and leaves the token', async () => {
        reset({
            existing: { id: 7, email: 'stub@example.test', firstName: null, status: 'pending_verification' },
            membership: { role: 'invited', userId: 7, assistantIds: [11] } as any,
            nextRowId: 501,
        });
        assert.equal((await invite({ email: 'stub@example.test', role: 'member', resend: true })).status, 200);
        assert.equal(state.rowDeletes, 1, 'the old link stops working');
        assert.equal(state.rowInserts[0].joinedAt, OLD_JOIN_DATE);
        assert.equal(state.rowInserts[0].role, 'invited');
        assert.equal(state.userUpdates.length, 1);
        assert.deepEqual(Object.keys(state.userUpdates[0]), ['tokenExpiresAt'], 'a sign-up link in flight keeps its token');
        assertLinkVerifies(emailedLink(), 501, 'member');
        assert.deepEqual(state.rowInserts[0].assistantIds, [11], 'a resend keeps the assistants first chosen');
    });

    await test('a resend to a verified person does not touch their account', async () => {
        reset({
            existing: { id: 7, email: 'active@example.test', firstName: null, status: 'active' },
            membership: { role: 'invited', userId: 7 },
        });
        assert.equal((await invite({ email: 'active@example.test' })).status, 200);
        assert.equal(state.userUpdates.length, 0, 'their login link keeps its own expiry');
        assert.equal(state.rowDeletes, 1);
    });

    await test('a registered person who is not a member is still added directly, with no link', async () => {
        reset({ existing: { id: 7, email: 'known@example.test', firstName: null, status: 'active' } });
        const res = await invite({ email: 'known@example.test', role: 'admin' });
        assert.equal((await res.json()).directAdd, true);
        assert.equal(state.rowInserts[0].role, 'admin');
        assert.equal(state.rowInserts[0].assistantIds, null, 'an admin has every assistant');
        assert.equal(state.rowDeletes, 0);
        assert.ok(!state.emails[0]?.html.includes('accept-invite'));
    });

    await test('an existing member is refused', async () => {
        reset({ existing: { id: 7, email: 'in@example.test', firstName: null, status: 'active' }, membership: { role: 'member', userId: 7 } });
        assert.equal((await invite({ email: 'in@example.test' })).status, 409);
        assert.equal(state.rowInserts.length + state.rowDeletes, 0);
    });

    console.log(`\n${passed}/${total} passed`);
})();
