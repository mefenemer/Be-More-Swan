// tests/newsletter-ab-subjects.test.ts
// Two subject lines, a sample, and the winner to everyone else.
//
// An A/B test is the one feature here that deliberately sends a list two different things, and it
// runs unattended across hours. Five ways that goes wrong:
//
//   1. ⚠️ THE REMAINDER IS NEVER SENT. A decider that does not fire leaves 70% of a list holding
//      nothing — and two nightly sweeps in this codebase have never run once. So there is no new
//      schedule: the decision happens inside the send sweep that is already running the issue.
//   2. SOMEBODY GETS BOTH SUBJECTS. Re-cutting a split that already exists is how.
//   3. IT CLAIMS A WINNER FROM NOISE. Four opens against one on a sample of ninety is not a result,
//      and a tenant told "B won" will write next month's subject that way.
//   4. IT DECIDES ON DATA THAT CANNOT EXIST. A mailbox-sent issue reports no opens at all.
//   5. THE RECORD OF WHAT SOMEBODY WAS SENT CHANGES AFTERWARDS.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { decideWinner, MIN_LEAD_OPENS, prepareAbSample } from '../src/utils/newsletter-ab';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const AB = read('src/utils/newsletter-ab.ts');
const SEND = read('src/utils/newsletter-send.ts');
const API = read('netlify/functions/newsletter-issues.ts');
const SQL = read('db/newsletter-ab-subjects.sql');
const NEWSLETTER_SQL = read('db/newsletter.sql');
const UI = read('newsletter.js');

const tracked = { engagementTracked: true, sentA: 50, sentB: 50 };

/** Serves the two selects prepareAbSample makes, and records every update. */
function fakeDb(rows: { id: number }[], opts: { alreadySplit?: boolean } = {}) {
    const updates: { set: Record<string, unknown>; ids?: number[] }[] = [];
    let selectCall = 0;
    const db: any = {
        select: () => {
            const call = selectCall++;
            const chain: any = new Proxy({}, {
                get(_t, prop) {
                    if (prop === 'then') {
                        // 0: "has any row a variant already?"  1: the queued rows.
                        const result = call === 0 ? (opts.alreadySplit ? [{ id: 1 }] : []) : rows;
                        return (resolve: (r: unknown) => void) => resolve(result);
                    }
                    return () => chain;
                },
            });
            return chain;
        },
        update: () => {
            const entry: { set: Record<string, unknown>; ids?: number[] } = { set: {} };
            const chain: any = {
                set: (v: Record<string, unknown>) => { entry.set = v; return chain; },
                where: () => { updates.push(entry); return Promise.resolve([]); },
            };
            return chain;
        },
    };
    return { db, updates };
}

async function main() {

// ── 1. It always decides ────────────────────────────────────────────────────

await check('a clear win is called, and the numbers are in the note', () => {
    const d = decideWinner({ ...tracked, openedA: 8, openedB: 20 });
    assert.strictEqual(d.winner, 'B');
    assert.match(d.note, /Subject B won/);
    assert.match(d.note, /8 opened the first and 20 the second/, 'a claim a tenant cannot check is not a result');
});

await check('a margin too small to mean anything is called too close, and A is sent', () => {
    // ⚠️ Opens are inflated for some recipients and invisible for others. A tenant told "B won"
    // writes next month's subject that way.
    const d = decideWinner({ ...tracked, openedA: 20, openedB: 22 });
    assert.strictEqual(d.winner, 'A');
    assert.match(d.note, /Too close to call/);
    assert.match(d.note, /noise rather than a result/);
});

await check('a tie decides rather than hanging', () => {
    const d = decideWinner({ ...tracked, openedA: 15, openedB: 15 });
    assert.strictEqual(d.winner, 'A');
    assert.match(d.note, /Too close to call/);
});

await check('nobody opening either version still decides', () => {
    const d = decideWinner({ ...tracked, openedA: 0, openedB: 0 });
    assert.strictEqual(d.winner, 'A');
    assert.match(d.note, /Nobody in the sample opened either/);
});

await check('an issue that could not measure opens decides, and says why', () => {
    const d = decideWinner({ openedA: 0, openedB: 0, sentA: 50, sentB: 50, engagementTracked: false });
    assert.strictEqual(d.winner, 'A');
    assert.match(d.note, /cannot report opens/);
});

await check('the small-margin rule is a rule of thumb and says so', () => {
    // Calling it significance would dress up a number the input is not clean enough to support.
    assert.match(AB, /A RULE OF THUMB, AND SAID TO BE ONE/);
    assert.match(AB, /must never be described\n \* as one/);
    assert.ok(MIN_LEAD_OPENS >= 3);
    // A big absolute lead on a small base still counts.
    assert.strictEqual(decideWinner({ ...tracked, openedA: 2, openedB: 9 }).winner, 'B');
});

// ── 2. Nobody gets both subjects ────────────────────────────────────────────

await check('a split that already exists is never re-cut', () => {
    // ⚠️ Re-cutting under a part-sent issue is how one person receives both subject lines.
    return prepareAbSample(fakeDb([{ id: 1 }], { alreadySplit: true }).db,
        { id: 1, organisationId: 1, abSamplePercent: 30 })
        .then((r) => assert.strictEqual(r, null));
});

await check('the sample is split A/B and the rest is HELD', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const { db, updates } = fakeDb(rows);
    const res = await prepareAbSample(db, { id: 1, organisationId: 1, abSamplePercent: 30 });
    assert.deepStrictEqual(res, { sampled: 30, held: 70 });
    const variants = updates.filter((u) => u.set.variant).map((u) => u.set.variant);
    assert.deepStrictEqual(variants.sort(), ['A', 'B'], 'one update per variant');
    assert.ok(updates.some((u) => u.set.status === 'held'), 'the remainder is held, not left uncreated');
});

await check('the two groups are interleaved, not the first half and the second', () => {
    // ids are creation order, which is roughly subscription order — halving the list would compare
    // two different audiences rather than two subject lines.
    const fn = AB.slice(landmark(AB, 'export async function prepareAbSample'), landmark(AB, 'export async function sampleResults'));
    assert.match(fn, /i % 2 === 0/);
    assert.match(fn, /Interleaved rather than halved/);
});

await check('the remainder is materialised up front, so the audience is frozen', () => {
    assert.match(SQL, /Why 'held' is a send status and not an absence of rows/);
    // Matched as its own clause: a local-time send freezes for the same reason and shares the
    // expression, so anchoring on `const frozen = ` would break every time another mode is added.
    assert.match(SEND, /claimed\.abState === 'testing' && !!claimed\.abSampleSentAt/);
    assert.match(SEND, /const frozen =/);
});

// ── 3. No new schedule ──────────────────────────────────────────────────────

await check('the decision runs inside the send sweep, not on a cron of its own', () => {
    // ⚠️ A decider that never fires means 70% of a list never receives the issue.
    assert.match(SEND, /decideAndRelease/);
    assert.match(AB, /NO NEW SCHEDULE/);
    const toml = read('netlify.toml');
    assert.ok(!/newsletter-ab/.test(toml), 'no new scheduled function may appear for this');
});

await check('a test that is not due yet keeps the issue sending', () => {
    const branch = SEND.slice(landmark(SEND, 'AN A/B ISSUE IS NOT FINISHED'), landmark(SEND, 'const [{ delivered }]'));
    assert.match(branch, /if \(!outcome && held > 0\)/);
    assert.match(branch, /continue;/);
    // And it must not mark the issue sent while people are still held.
    assert.ok(landmark(branch, 'continue;') < branch.length);
});

// ── 4. What each person was sent is a fact, not a lookup ────────────────────

await check('the subject comes from the ROW, not the issue', () => {
    // ⚠️ Bounded FORWARDS on a marker inside the same call: an earlier `db.update(newsletterSends)`
    // (the skipped-consent branch) sits above this one, and slicing to it would run backwards.
    const from = landmark(SEND, 'const messageId = await deliver(');
    const fn = SEND.slice(from, landmark(SEND, 'providerMessageId: messageId', from));
    assert.match(fn, /row\.variant === 'B'/);
    assert.match(fn, /record of what this person was sent/);
});

await check('the winner is stamped onto the released rows', () => {
    const fn = AB.slice(landmark(AB, 'export async function decideAndRelease'));
    assert.match(fn, /variant: decision\.winner/);
    assert.match(fn, /STAMPED onto the held rows/);
});

await check('the send vocabulary gains "held" without dropping anything', () => {
    const before = [...NEWSLETTER_SQL.slice(landmark(NEWSLETTER_SQL, 'newsletter_sends_status_check'))
        .slice(0, 300).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(before.includes('queued') && before.includes('skipped'));
    const after = SQL.slice(landmark(SQL, 'ADD CONSTRAINT newsletter_sends_status_check'));
    for (const v of before) assert.ok(after.includes(`'${v}'`), `widening dropped '${v}'`);
    assert.match(after, /'held'/);
    assert.match(SQL, /DROP CONSTRAINT IF EXISTS newsletter_sends_status_check/);
});

// ── 5. Setting it up ────────────────────────────────────────────────────────

await check('two identical subject lines are refused', () => {
    // A test that cannot teach anything, run on real people.
    const fn = API.slice(landmark(API, "if (action === 'abTest')"), landmark(API, "if (action === 'update')"));
    assert.match(fn, /the same, so there would be nothing to compare/);
});

await check('a missing second subject is refused', () => {
    const fn = API.slice(landmark(API, "if (action === 'abTest')"), landmark(API, "if (action === 'update')"));
    assert.match(fn, /Write a second subject line/);
});

await check('the tenant is warned at SETUP that a mailbox send cannot be decided', () => {
    // ⚠️ Not discovered four hours later, when everyone held back has already been sent subject A.
    const fn = API.slice(landmark(API, "if (action === 'abTest')"), landmark(API, "if (action === 'update')"));
    assert.match(fn, /newsletterSendingDomains/);
    assert.match(fn, /nothing to pick a winner from/);
    assert.match(UI, /if \(res\.warning\)/);
});

await check('a sent test shows what it found, in the words the server wrote', () => {
    const shown = UI.slice(landmark(UI, 'function renderAb'), landmark(UI, 'function renderAbForm'));
    assert.match(shown, /issue\.abNote/, 'the note is rendered rather than a bare winner');
    assert.match(shown, /A:/);
    assert.match(shown, /B:/, 'and both subject lines are shown beside it');
    // The rule is explained where the test is set up, before it runs.
    const form = UI.slice(landmark(UI, 'function renderAbForm'), landmark(UI, 'function renderLinks'));
    assert.match(form, /too small to mean anything/i);
    assert.match(form, /whichever more people OPEN/i);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
