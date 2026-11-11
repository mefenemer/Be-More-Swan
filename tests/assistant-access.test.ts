// tests/assistant-access.test.ts
// A teammate given some assistants, not all (src/utils/assistant-access.ts), and requireTenant
// refusing a request that names another one (src/utils/tenant.ts).
//
// Run:  npx tsx tests/assistant-access.test.ts

process.env.JWT_SECRET = 'test-secret-for-assistant-access';

import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import {
    accessForMembership, canAccessAssistant, filterToAccessible, parseRequestedAccess,
    assistantIdsInRequest, firstBlockedAssistant,
} from '../src/utils/assistant-access';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

function mockDb(queue: unknown[][]): any {
    let i = 0;
    const b: any = {
        select: () => b, from: () => b, where: () => b, orderBy: () => b, limit: () => b,
        then: (res: any, rej: any) => Promise.resolve(queue[i++] ?? []).then(res, rej),
    };
    return b;
}
function event(over: Record<string, unknown> = {}): any {
    const token = jwt.sign({ userId: 7, activeOrganisationId: 3 }, process.env.JWT_SECRET!);
    return { httpMethod: 'GET', headers: { cookie: `aura_session=${token}` }, queryStringParameters: {}, path: '/.netlify/functions/x', ...over };
}

(async () => {
    // session.ts reads JWT_SECRET as it loads, and static imports run before the line above.
    const { requireTenant } = await import('../src/utils/tenant');
    console.log('assistant-access');

    await check('owners and admins always get every assistant', () => {
        assert.strictEqual(accessForMembership('owner', [1]), null);
        assert.strictEqual(accessForMembership('admin', [1]), null);
    });
    await check('a member with no list (every row before the column) gets every assistant', () => {
        assert.strictEqual(accessForMembership('member', null), null);
    });
    await check('a member with a list gets only those', () => {
        const a = accessForMembership('viewer', [4, 9]);
        assert.deepStrictEqual(a, [4, 9]);
        assert.ok(canAccessAssistant(a, 4));
        assert.ok(!canAccessAssistant(a, 5));
        assert.deepStrictEqual(filterToAccessible(a, [{ id: 4 }, { id: 5 }, { id: 9 }]).map((r) => r.id), [4, 9]);
    });

    await check('an invite must choose at least one of the workspace\'s own assistants', () => {
        assert.deepStrictEqual(parseRequestedAccess('member', [9, 4, 4], [4, 9, 12]), { access: [4, 9] });
        assert.ok('error' in parseRequestedAccess('member', [], [4]));
        assert.ok('error' in parseRequestedAccess('member', [99], [4]));
        assert.ok('error' in parseRequestedAccess('viewer', 'x', [4]));
        assert.deepStrictEqual(parseRequestedAccess('admin', [4], [4]), { access: null });
    });
    await check('ticking every assistant stores the list, so one hired later is not handed over', () => {
        assert.deepStrictEqual(parseRequestedAccess('member', [4, 9], [4, 9]), { access: [4, 9] });
    });

    await check('finds the assistant in the query, body, and ?id= of assistant functions only', () => {
        assert.deepStrictEqual(assistantIdsInRequest({ queryStringParameters: { assistantId: '5' } }), [5]);
        assert.deepStrictEqual(assistantIdsInRequest({ body: JSON.stringify({ assistant_id: 6, assistantIds: [7, '8'] }) }), [6, 7, 8]);
        assert.deepStrictEqual(assistantIdsInRequest({ path: '/.netlify/functions/manage-assistant', queryStringParameters: { id: '9' } }), [9]);
        assert.deepStrictEqual(assistantIdsInRequest({ path: '/.netlify/functions/scheduled-posts', queryStringParameters: { id: '9' } }), []);
        assert.deepStrictEqual(assistantIdsInRequest({ body: 'not json' }), []);
        assert.strictEqual(firstBlockedAssistant([5], { queryStringParameters: { assistantId: '6' } }), 6);
        assert.strictEqual(firstBlockedAssistant(null, { queryStringParameters: { assistantId: '6' } }), null);
    });

    await check('requireTenant refuses a limited member naming another assistant', async () => {
        const db = mockDb([[{ role: 'member', assistantIds: [5] }]]);
        const ctx = await requireTenant(event({ queryStringParameters: { assistantId: '6' } }), db);
        assert.ok('error' in ctx);
        assert.strictEqual((ctx as any).error.statusCode, 403, (ctx as any).error.body);
        assert.match((ctx as any).error.body, /ASSISTANT_ACCESS/);
    });
    await check('requireTenant lets a limited member use their own assistant, and says which', async () => {
        const db = mockDb([[{ role: 'member', assistantIds: [5] }]]);
        const ctx = await requireTenant(event({ httpMethod: 'POST', body: JSON.stringify({ assistantId: 5 }) }), db);
        assert.ok(!('error' in ctx));
        assert.deepStrictEqual((ctx as any).assistantAccess, [5]);
    });
    await check('requireTenant ignores a stale list on an admin', async () => {
        const db = mockDb([[{ role: 'admin', assistantIds: [5] }]]);
        const ctx = await requireTenant(event({ queryStringParameters: { assistantId: '6' } }), db);
        assert.ok(!('error' in ctx));
        assert.strictEqual((ctx as any).assistantAccess, null);
    });

    console.log(`\n${passed} passed`);
})();
