// tests/blog-writer-linkedin-binding.test.ts
// BEHAVIOUR (not source text) of a LinkedIn Company Page bind made from the Blog Writer's card
// (PR #691 review notes 1 + 3). Runs bindLinkedInPage against a recording fake DB:
//   - a pool bind (assistantId null) never overwrites the existing connection's assistant
//   - the reconnect clean-up is scoped to the connection's OWN assistant (the Social Media
//     Manager), not the whole workspace, so a paused SMM is resumed as it would be from its own tab
//   - a new pool connection is inserted with assistantId null
//
// Run:  npx tsx tests/blog-writer-linkedin-binding.test.ts

import assert from 'node:assert';
import { bindLinkedInPage } from '../src/utils/linkedin-page-bind';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

type Rec = { kind: string; prop: string; arg: any };

// A chainable stand-in for the Drizzle client: every builder method returns the chain, awaiting it
// yields rows. The existing-connection lookup is the only select that asks for metadata.
function fakeDb(existing: any[]) {
    const log: Rec[] = [];
    const chain = (kind: string, rows: () => any[]): any => {
        const p: any = new Proxy(function () { /* callable target */ }, {
            get(_t, prop) {
                if (prop === 'then') return (res: any, rej: any) => Promise.resolve(rows()).then(res, rej);
                return (...args: any[]) => { log.push({ kind, prop: String(prop), arg: args[0] }); return p; };
            },
        });
        return p;
    };
    const db: any = {
        select: (fields?: any) => chain('select', () => (fields && 'metadata' in fields) ? existing : []),
        update: () => chain('update', () => []),
        insert: () => chain('insert', () => []),
        delete: () => chain('delete', () => []),
        execute: async () => ({ rows: [] }),
    };
    return { db, log };
}

// Does a Drizzle SQL tree carry a bound parameter with this value?
function hasParam(node: any, value: unknown, seen = new Set<any>()): boolean {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (node.constructor?.name === 'Param' && node.value === value) return true;
    for (const k of Object.keys(node)) if (hasParam(node[k], value, seen)) return true;
    return false;
}

const page = { urn: 'urn:li:organization:7', name: 'Be More Swan' } as any;
const SMM = 5;

(async () => {
    await check('pool reconnect keeps the Social Media Manager binding', async () => {
        const { db, log } = fakeDb([{ id: 9, metadata: null, assistantId: SMM }]);
        const r = await bindLinkedInPage(db, { organisationId: 1, userId: 2, assistantId: null, page, tokenExpiresAt: null });
        assert.deepEqual(r, { ok: true, reconnected: true });
        const conn = log.find(l => l.kind === 'update' && l.prop === 'set' && 'vaultRefKey' in (l.arg || {}));
        assert.ok(conn, 'connection row not updated');
        assert.ok(!('assistantId' in conn!.arg), 'pool reconnect overwrote the assistant binding');
    });

    await check('reconnect clean-up is scoped to the connection\'s own assistant', async () => {
        const { db, log } = fakeDb([{ id: 9, metadata: null, assistantId: SMM }]);
        await bindLinkedInPage(db, { organisationId: 1, userId: 2, assistantId: null, page, tokenExpiresAt: null });
        const scoped = log.filter(l => l.prop === 'where' && hasParam(l.arg, SMM));
        assert.ok(scoped.length > 0, 'resume guard ran workspace-wide instead of for the SMM');
    });

    await check('a first connection from the Blog Writer is inserted into the pool', async () => {
        const { db, log } = fakeDb([]);
        const r = await bindLinkedInPage(db, { organisationId: 1, userId: 2, assistantId: null, page, tokenExpiresAt: null });
        assert.deepEqual(r, { ok: true, reconnected: false });
        const ins = log.find(l => l.kind === 'insert' && l.prop === 'values' && l.arg?.serviceName === 'linkedin');
        assert.ok(ins, 'connection row not inserted');
        assert.equal(ins!.arg.assistantId, null);
    });

    await check('an SMM-started bind still binds to the SMM', async () => {
        const { db, log } = fakeDb([{ id: 9, metadata: null, assistantId: null }]);
        await bindLinkedInPage(db, { organisationId: 1, userId: 2, assistantId: SMM, page, tokenExpiresAt: null });
        const conn = log.find(l => l.kind === 'update' && l.prop === 'set' && 'vaultRefKey' in (l.arg || {}));
        assert.equal(conn!.arg.assistantId, SMM);
    });

    console.log(`\n${passed} passed`);
})();
