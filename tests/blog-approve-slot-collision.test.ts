// tests/blog-approve-slot-collision.test.ts
// Locks the fix for: "I reviewed two blogs and asked my assistant to schedule them, and it scheduled
// them for the same time and date."
//
// schedule-blog.ts's approve path (pickCadenceSlot) used to search only the DRAFT HORIZON for a free
// cadence slot and then, when every slot in it was taken, `?? slots[0]` — the first slot of the
// window, which is precisely the one the previous approval had just claimed. A weekly Blog Writer on
// the default 7-day horizon has exactly ONE slot in that window, so the second approval always
// collided with the first. approve-post.ts (social) had already been fixed for this; the blog path
// had not.
//
// Run:  npx tsx tests/blog-approve-slot-collision.test.ts

import assert from 'node:assert';
import { pickCadenceSlot } from '../netlify/functions/schedule-blog';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log(`  ✓ ${name}`); passed++; })
        .catch((e) => { console.error(`  ✗ ${name}\n    ${e && e.message}`); failed++; });
}

// ── Stub db ──────────────────────────────────────────────────────────────────
// pickCadenceSlot makes exactly two reads, both drizzle-shaped:
//   select().from(aiAssistants).where().limit(1)   → [assistant]
//   select().from(blogPosts).where()               → awaited directly (thenable)
function makeDb(assistant: unknown, takenDates: Date[]) {
    let call = 0;
    const rows = takenDates.map(d => ({ publishDate: d }));
    return {
        select() {
            call++;
            const isAssistantRead = call === 1;
            const result: any = isAssistantRead ? (assistant ? [assistant] : []) : rows;
            const chain: any = {
                from: () => chain,
                where: () => chain,
                limit: () => Promise.resolve(result),
                then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
            };
            return chain;
        },
    } as any;
}

// A weekly Blog Writer: one slot a week, default 7-day horizon. The exact case from the report.
const WEEKLY = {
    onboardingContext: {
        posting_frequency: 'Weekly',
        posting_days: ['tue'],
        posting_times: ['09:00'],
        posting_timezone: 'Europe/London',
    },
    draftHorizonDays: 7,
};

const post = (id: number, publishDate: Date | null) => ({ id, assistantId: 1, publishDate });
// A Monday, so "next Tuesday 09:00" is one day out and unambiguous.
const NOW = new Date('2026-09-07T08:00:00.000Z');

async function main() {
    await check('two approvals in a row never land on the same instant', async () => {
        // Post A approves first, onto the only slot in the horizon.
        const a = await pickCadenceSlot(makeDb(WEEKLY, []), 5, post(101, null), NOW);
        // Post B approves next. A now occupies that slot.
        const b = await pickCadenceSlot(makeDb(WEEKLY, [a]), 5, post(102, null), NOW);
        assert.notEqual(a.getTime(), b.getTime(), `both landed on ${a.toISOString()}`);
        assert.ok(b.getTime() > a.getTime(), 'the second post should land after the first');
    });

    await check('the overflow slot is a real cadence slot, not an arbitrary instant', async () => {
        const a = await pickCadenceSlot(makeDb(WEEKLY, []), 5, post(101, null), NOW);
        const b = await pickCadenceSlot(makeDb(WEEKLY, [a]), 5, post(102, null), NOW);
        // Weekly on Tuesdays at 09:00 Europe/London (BST in September → 08:00 UTC).
        assert.equal(a.toISOString(), '2026-09-08T08:00:00.000Z');
        assert.equal(b.toISOString(), '2026-09-15T08:00:00.000Z');
    });

    await check('a run of approvals keeps stepping, one slot each', async () => {
        const taken: Date[] = [];
        for (let i = 0; i < 5; i++) {
            taken.push(await pickCadenceSlot(makeDb(WEEKLY, taken.slice()), 5, post(200 + i, null), NOW));
        }
        assert.equal(new Set(taken.map(d => d.getTime())).size, 5, 'every approval needs its own slot');
    });

    await check('a draft already sitting on its own cadence slot keeps it', async () => {
        // process-blog-jobs stamps the job's target slot onto the draft, so approving must not
        // rehome it to the earliest opening — that churn is what tore the two posts apart before it
        // piled them up.
        const own = new Date('2026-09-15T08:00:00.000Z');
        const kept = await pickCadenceSlot(makeDb(WEEKLY, []), 5, post(101, own), NOW);
        assert.equal(kept.getTime(), own.getTime());
    });

    await check('but a slot someone else has taken is not kept', async () => {
        const own = new Date('2026-09-15T08:00:00.000Z');
        const moved = await pickCadenceSlot(makeDb(WEEKLY, [own]), 5, post(101, own), NOW);
        assert.notEqual(moved.getTime(), own.getTime());
    });

    await check('a past date on the draft is rehomed forward', async () => {
        const stale = new Date('2026-08-04T08:00:00.000Z');
        const when = await pickCadenceSlot(makeDb(WEEKLY, []), 5, post(101, stale), NOW);
        assert.ok(when.getTime() > NOW.getTime());
    });

    await check('multi-slot cadences still fill their own slots first', async () => {
        const twice = {
            onboardingContext: {
                posting_frequency: '2x per week',
                posting_days: ['tue', 'thu'],
                posting_times: ['09:00'],
                posting_timezone: 'Europe/London',
            },
            draftHorizonDays: 7,
        };
        const a = await pickCadenceSlot(makeDb(twice, []), 5, post(101, null), NOW);
        const b = await pickCadenceSlot(makeDb(twice, [a]), 5, post(102, null), NOW);
        assert.equal(a.toISOString(), '2026-09-08T08:00:00.000Z');   // Tue
        assert.equal(b.toISOString(), '2026-09-10T08:00:00.000Z');   // Thu
    });

    await check('on-demand cadence still falls back to now+24h', async () => {
        const onDemand = { onboardingContext: { posting_frequency: 'On demand' }, draftHorizonDays: 7 };
        const when = await pickCadenceSlot(makeDb(onDemand, []), 5, post(101, null), NOW);
        assert.equal(when.getTime(), NOW.getTime() + 24 * 60 * 60 * 1000);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
}

main();
