// Timing test on staging (2026-11-17): three different 60-minute meetings the model titled alike all landed in
// ONE record, because records were matched on the title forever — and a later meeting could rewrite an approved
// one. Now only a waiting record from the last hour is refreshed. Run: npx tsx tests/hub-records-same-title.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFRESH_WINDOW_MS, hubWriteDecision, titleWithTime } from '../src/utils/hub-records';

const now = new Date('2026-11-17T17:12:40Z');
const t = 'Weekly leadership meeting — 17 Nov 2026';
const ago = (ms: number) => new Date(now.getTime() - ms);

// No record with this title → a new one, title as written.
assert.deepEqual(hubWriteDecision(null, t, now), { insert: t });
// The same notes again a few minutes later, still waiting → refresh it (no duplicate).
assert.deepEqual(hubWriteDecision({ id: 925, approvalStatus: 'pending_approval', createdAt: ago(5 * 60_000) }, t, now), { refresh: 925 });
assert.deepEqual(hubWriteDecision({ id: 925, approvalStatus: 'pending_approval', createdAt: ago(REFRESH_WINDOW_MS) }, t, now), { refresh: 925 }, 'the edge of the window still refreshes');
// An APPROVED (or rejected, or scheduled) meeting is never rewritten.
for (const s of ['approved', 'scheduled', 'rejected']) {
    assert.deepEqual(hubWriteDecision({ id: 920, approvalStatus: s, createdAt: ago(60_000) }, t, now), { insert: `${t} (17 Nov 2026, 17:12)` }, s);
}
// A waiting one from yesterday is another meeting.
assert.deepEqual(hubWriteDecision({ id: 900, approvalStatus: 'pending_approval', createdAt: ago(REFRESH_WINDOW_MS + 1) }, t, now), { insert: `${t} (17 Nov 2026, 17:12)` });
// The time is UK time (here GMT), and the title never passes the column's 300 characters.
assert.equal(titleWithTime('Weekly team meeting', new Date('2026-07-01T09:05:00Z')), 'Weekly team meeting (1 Jul 2026, 10:05)', 'BST in summer');
assert.ok(titleWithTime('x'.repeat(400), now).length <= 300);

// The writer asks for the NEWEST record with the title and follows the decision.
const src = readFileSync('src/utils/hub-records.ts', 'utf8');
assert.ok(src.includes('.orderBy(desc(assistantRecords.createdAt))'));
assert.ok(src.includes("const decision = hubWriteDecision(existing ?? null, rec.title, new Date());"));
assert.ok(src.includes('title: decision.insert,'));
console.log('hub-records-same-title: all checks passed');
