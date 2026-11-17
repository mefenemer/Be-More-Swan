// tests/hub-records-same-title.test.ts
// Records filed from the chat and the "New meeting" form (src/utils/hub-records.ts), two rules:
//   • leads / enrichment / invoices / tickets: the title is the identity — refreshed in place, whatever its
//     age or status (as before #719; #719 put them under the meeting rule — review: Changes needed).
//   • meetings: never overwritten by a DIFFERENT meeting (staging timing test, record #925, 2026-11-17); only an
//     identical waiting re-run is refreshed; a taken title gets the date and time added.
// BEHAVIOUR: the pure decisions, plus persistHubRecords run against a recording stand-in database.
//
// Run:  npx tsx tests/hub-records-same-title.test.ts

import assert from 'node:assert/strict';
import { meetingWriteDecision, titleWithTime, stableJson, timedTitlePattern, persistHubRecords, type HubRecord } from '../src/utils/hub-records';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const now = new Date('2026-11-17T17:12:40Z');
const t = 'Weekly leadership meeting — 17 Nov 2026';
const meeting = (data: unknown): HubRecord => ({ recordType: 'meeting', title: t, status: 'open', data });
const A = { summary: 'Budget agreed', tasks: [{ who: 'Sam', what: 'Send deck' }] };
const B = { summary: 'Hiring plan', tasks: [{ who: 'Ali', what: 'Post the job' }] };

// A recording stand-in for the Drizzle client: selects answer from `rows` by which columns they ask for.
function fakeDb(rows: { meeting?: unknown[]; byTitle?: unknown[] }) {
    const log: Array<{ kind: string; prop: string; arg: any }> = [];
    const chain = (kind: string, result: () => unknown[]): any => {
        const p: any = new Proxy(function () { /* callable */ }, {
            get(_t, prop) {
                if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result()).then(res, rej);
                return (...args: any[]) => { log.push({ kind, prop: String(prop), arg: args[0] }); return p; };
            },
        });
        return p;
    };
    let nextId = 1000;
    const db: any = {
        select: (fields: Record<string, unknown>) => chain('select', () => ('data' in fields ? rows.meeting ?? [] : rows.byTitle ?? [])),
        update: () => chain('update', () => []),
        insert: () => chain('insert', () => [{ id: nextId++ }]),
    };
    const writes = () => log.filter((l) => (l.kind === 'update' && l.prop === 'set') || (l.kind === 'insert' && l.prop === 'values'));
    return { db, log, writes };
}

(async () => {
    await check('meeting: a new title is filed as written', () => {
        assert.deepEqual(meetingWriteDecision([], meeting(A), now), { insert: t });
    });

    await check('meeting: a DIFFERENT meeting with a taken title is a new record — even minutes later, still waiting', () => {
        const waiting = [{ id: 925, title: t, approvalStatus: 'pending_approval', data: A }];
        assert.deepEqual(meetingWriteDecision(waiting, meeting(B), now), { insert: `${t} (17 Nov 2026, 17:12)` });
    });

    await check('meeting: an identical waiting re-run refreshes (no duplicate), key order ignored', () => {
        const waiting = [{ id: 925, title: `${t} (17 Nov 2026, 16:40)`, approvalStatus: 'pending_approval', data: { tasks: A.tasks, summary: A.summary } }];
        assert.deepEqual(meetingWriteDecision(waiting, meeting(A), now), { refresh: 925 });
    });

    await check('meeting: an approved, scheduled or rejected meeting is never rewritten, even by identical content', () => {
        for (const s of ['approved', 'scheduled', 'rejected']) {
            assert.deepEqual(meetingWriteDecision([{ id: 920, title: t, approvalStatus: s, data: A }], meeting(A), now), { insert: `${t} (17 Nov 2026, 17:12)` }, s);
        }
    });

    await check('meeting: a free plain title stays plain even when dated copies exist', () => {
        assert.deepEqual(meetingWriteDecision([{ id: 1, title: `${t} (16 Nov 2026, 09:00)`, approvalStatus: 'approved', data: A }], meeting(B), now), { insert: t });
    });

    await check('UK time, 300-character cap, stable JSON, literal LIKE pattern', () => {
        assert.equal(titleWithTime('Weekly team meeting', new Date('2026-07-01T09:05:00Z')), 'Weekly team meeting (1 Jul 2026, 10:05)', 'BST in summer');
        assert.ok(titleWithTime('x'.repeat(400), now).length <= 300);
        assert.equal(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] }), stableJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
        assert.equal(timedTitlePattern('50% off_now \\ x'), '50\\% off\\_now \\\\ x (%');
    });

    await check('persist: a LEAD with a taken title is refreshed in place — never a new dated row (#719 review)', async () => {
        const { db, writes } = fakeDb({ byTitle: [{ id: 77 }] });
        const ids = await persistHubRecords(db, 1, 2, [{ recordType: 'lead', title: 'Acme Ltd', status: 'hot', data: { score: 9 } }]);
        assert.deepEqual(ids, [77]);
        const w = writes();
        assert.equal(w.length, 1);
        assert.equal(w[0].kind, 'update');
        assert.deepEqual(w[0].arg.data, { score: 9 });
    });

    await check('persist: invoices and enrichment follow the same title rule', async () => {
        for (const recordType of ['invoice', 'enrichment', 'ticket']) {
            const { db, writes } = fakeDb({ byTitle: [{ id: 5 }] });
            assert.deepEqual(await persistHubRecords(db, 1, 2, [{ recordType, title: 'Client X', status: null, data: {} }]), [5], recordType);
            assert.equal(writes()[0].kind, 'update', recordType);
        }
    });

    await check('persist: a lead with a new title is inserted under its own title', async () => {
        const { db, writes } = fakeDb({ byTitle: [] });
        await persistHubRecords(db, 1, 2, [{ recordType: 'lead', title: 'New Co', status: 'warm', data: {} }]);
        assert.equal(writes()[0].kind, 'insert');
        assert.equal(writes()[0].arg.title, 'New Co');
    });

    await check('persist: a different meeting with a taken title is inserted with the time added', async () => {
        const { db, writes } = fakeDb({ meeting: [{ id: 925, title: t, approvalStatus: 'pending_approval', data: A }] });
        const ids = await persistHubRecords(db, 1, 2, [meeting(B)]);
        assert.equal(ids.length, 1);
        const w = writes();
        assert.equal(w.length, 1);
        assert.equal(w[0].kind, 'insert');
        assert.match(w[0].arg.title, /^Weekly leadership meeting — 17 Nov 2026 \(\d{1,2} \w{3} \d{4}, \d{2}:\d{2}\)$/);
        assert.deepEqual(w[0].arg.data, B, 'the earlier meeting keeps its own content');
    });

    await check('persist: an identical waiting meeting re-run refreshes that record', async () => {
        const { db, writes } = fakeDb({ meeting: [{ id: 925, title: t, approvalStatus: 'pending_approval', data: A }] });
        assert.deepEqual(await persistHubRecords(db, 1, 2, [meeting(A)]), [925]);
        assert.equal(writes()[0].kind, 'update');
    });

    console.log(`\n${passed} passed`);
})();
