// tests/resume-capacity.test.ts
// Resuming a paused assistant must not take a seat the plan does not have.
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// paused / system_paused do not occupy a seat (SEAT_OCCUPYING_STATUSES), so pausing frees one. The
// hire paths re-check the limit, but the routes back INTO a seat did not: kickoff-assistant.ts
// (paused → working, the UI's resume), manage-assistant's legacy PATCH `resume` (isActive=true,
// which the lifecycle trigger derives to working) and connection-recovery's automatic restore.
// On the one-assistant plan: hire A, pause A, hire B, pause B, hire C, kick off A and B → three
// working assistants.
//
// Run:  npx tsx tests/resume-capacity.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    checkAssistantCapacity, checkResumeCapacity, resumeRefusalMessage, SEAT_OCCUPYING_STATUSES,
} from '../src/utils/assistant-capacity';

let passed = 0, total = 0;
const deferred: Array<() => Promise<void>> = [];
/** Queued, not awaited inline: tsx compiles these to CJS, which has no top-level await. */
function check(name: string, fn: () => void | Promise<void>) {
    total++;
    deferred.push(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
    });
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

type Row = { id: number; name: string; lifecycleStatus: string };
const occupying = (s: string) => (SEAT_OCCUPYING_STATUSES as readonly string[]).includes(s);

/**
 * Stands in for the reads both checks make, in order: the plan, the org's bonus seats, then the
 * seat query (a count for hiring, the occupying rows minus `exclude` for resuming).
 */
function fakeDb(rows: Row[], opts: { plan?: unknown; bonus?: number; exclude?: number } = {}) {
    const plan = 'plan' in opts ? opts.plan : { assistantLimit: 1, featureOverrides: null };
    let call = 0;
    const chain: any = {
        from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain,
        limit: async () => (call === 1 ? (plan ? [plan] : []) : [{ bonusAssistants: opts.bonus ?? 0 }]),
        then: (res: (v: unknown) => void) => {
            const seated = rows.filter((r) => occupying(r.lifecycleStatus));
            res(opts.exclude === undefined
                ? [{ value: seated.length }]
                : seated.filter((r) => r.id !== opts.exclude).map(({ id, name }) => ({ id, name })));
        },
    };
    return { select: () => { call++; return chain; } } as any;
}

console.log('\nresume capacity\n');

// ── The repro, end to end over the two gates ───────────────────────────────────────────────────
check('pause-hire-pause-hire cannot stack three working assistants on a one-seat plan', async () => {
    const rows: Row[] = [];
    let nextId = 1;
    const hire = async (name: string) => {
        assert.strictEqual(await checkAssistantCapacity(fakeDb(rows), 1, 1), null, `hiring ${name} should be allowed`);
        rows.push({ id: nextId++, name, lifecycleStatus: 'working' });
    };
    const pause = (name: string) => { rows.find((r) => r.name === name)!.lifecycleStatus = 'paused'; };
    const resume = async (name: string) => {
        const r = rows.find((x) => x.name === name)!;
        const refusal = await checkResumeCapacity(fakeDb(rows, { exclude: r.id }), 1, 1, r.id, r.lifecycleStatus);
        if (!refusal) r.lifecycleStatus = 'working';
        return refusal;
    };

    await hire('Ava'); pause('Ava');
    await hire('Ben'); pause('Ben');
    await hire('Cleo');

    const a = await resume('Ava');
    const b = await resume('Ben');
    assert.strictEqual(a?.code, 'CAPACITY', 'resuming Ava while Cleo works must be refused');
    assert.strictEqual(a?.status, 409);
    assert.strictEqual(b?.code, 'CAPACITY');
    assert.match(a!.error, /one assistant at a time/);
    assert.match(a!.error, /Cleo/, 'the refusal names what to pause or archive');
    assert.strictEqual(rows.filter((r) => r.lifecycleStatus === 'working').length, 1);

    // …and once Cleo is paused, Ava may come back.
    pause('Cleo');
    assert.strictEqual(await resume('Ava'), null);
});

// ── The rule ───────────────────────────────────────────────────────────────────────────────────
check('an assistant already in a seat is never refused (ready_for_work → working is the kick-off)', async () => {
    const rows: Row[] = [{ id: 1, name: 'Ava', lifecycleStatus: 'ready_for_work' }, { id: 2, name: 'Ben', lifecycleStatus: 'working' }];
    assert.strictEqual(await checkResumeCapacity(fakeDb(rows, { exclude: 1 }), 1, 1, 1, 'ready_for_work'), null);
});

check('the assistant being resumed is not counted against itself', async () => {
    // Defensive: even if the row still reads as occupying, it must not block its own resume.
    const rows: Row[] = [{ id: 1, name: 'Ava', lifecycleStatus: 'working' }];
    assert.strictEqual(await checkResumeCapacity(fakeDb(rows, { exclude: 1 }), 1, 1, 1, 'paused'), null);
});

check('system_paused is checked too (connection restore / kick-off after reconnect)', async () => {
    const rows: Row[] = [{ id: 1, name: 'Ava', lifecycleStatus: 'system_paused' }, { id: 2, name: 'Ben', lifecycleStatus: 'working' }];
    assert.strictEqual((await checkResumeCapacity(fakeDb(rows, { exclude: 1 }), 1, 1, 1, 'system_paused'))?.code, 'CAPACITY');
});

check('bonus seats and uncapped plans let the resume through', async () => {
    const rows: Row[] = [{ id: 1, name: 'Ava', lifecycleStatus: 'paused' }, { id: 2, name: 'Ben', lifecycleStatus: 'working' }];
    assert.strictEqual(await checkResumeCapacity(fakeDb(rows, { exclude: 1, bonus: 1 }), 1, 1, 1, 'paused'), null);
    const uncapped = { assistantLimit: null, featureOverrides: null };
    assert.strictEqual(await checkResumeCapacity(fakeDb(rows, { exclude: 1, plan: uncapped }), 1, 1, 1, 'paused'), null);
});

check('no plan row does not switch a resume off (that is the hire gate\'s rule)', async () => {
    const rows: Row[] = [{ id: 1, name: 'Ava', lifecycleStatus: 'paused' }, { id: 2, name: 'Ben', lifecycleStatus: 'working' }];
    assert.strictEqual(await checkResumeCapacity(fakeDb(rows, { exclude: 1, plan: null }), 1, 1, 1, 'paused'), null);
});

check('the refusal copy reads naturally for one and several seats', () => {
    assert.strictEqual(resumeRefusalMessage(1, ['Cleo']),
        'Your plan runs one assistant at a time. Pause or archive Cleo first, or upgrade your plan.');
    assert.strictEqual(resumeRefusalMessage(3, ['A', 'B', 'C']),
        'Your plan runs 3 assistants at a time. Pause or archive one of A, B or C first, or upgrade your plan.');
});

// ── Every route back into a seat asks, before it writes ────────────────────────────────────────
check('kickoff-assistant checks capacity before the transition to working', () => {
    const src = read('netlify/functions/kickoff-assistant.ts');
    const gate = src.indexOf('checkResumeCapacity(db, userId, orgId, assistantId, state)');
    const write = src.indexOf("transitionAssistantStatus(db, assistantId, 'working'");
    assert.ok(gate > 0, 'kickoff-assistant must call checkResumeCapacity');
    assert.ok(write > gate, 'the check must come before the transition');
});

check("manage-assistant's legacy resume checks capacity before setting isActive", () => {
    const src = read('netlify/functions/manage-assistant.ts');
    const gate = src.indexOf('checkResumeCapacity(db, ctx.userId, orgId, id, existing.lifecycleStatus)');
    const write = src.indexOf('.set({ isActive: true, updatedAt: new Date() })');
    assert.ok(gate > 0, 'the resume action must call checkResumeCapacity');
    assert.ok(write > gate, 'the check must come before the write');
});

check('connection-recovery checks capacity before restoring to working', () => {
    const src = read('src/utils/connection-recovery.ts');
    const gate = src.indexOf('checkResumeCapacity(db, a.userId, organisationId, a.id');
    const write = src.indexOf("transitionAssistantStatus(db, a.id, 'working'");
    assert.ok(gate > 0, 'connection-recovery must call checkResumeCapacity');
    assert.ok(write > gate, 'the check must come before the transition');
});

check('both resume buttons show the server refusal, not a generic error', () => {
    // The kick-off card (assistants.js) and the setup wizard (workspace.html) both POST to
    // kickoff-assistant; the CAPACITY message must reach the toast.
    for (const file of ['assistants.js', 'workspace.html']) {
        const src = read(file);
        const call = src.indexOf('/.netlify/functions/kickoff-assistant?id=');
        assert.ok(call > 0, `${file} calls kickoff-assistant`);
        const window = src.slice(call, call + 600);
        assert.match(window, /d\.error \|\|/, `${file} must prefer the server's error message`);
    }
});

(async () => {
    for (const run of deferred) await run();
    console.log(`\n${passed}/${total} passed\n`);
})();
