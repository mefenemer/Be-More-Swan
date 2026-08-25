// tests/discovery-drain-handoff.test.ts
// A run longer than the platform's function budget must carry on, not drop its tail on the cron.
//
// ── The gap this closes ──────────────────────────────────────────────────────
// run-discovery-jobs-background loops the drain so one poke carries a whole run. Its budget is 12
// minutes — Netlify allows a background function 15, and the margin lets the final slice finish
// rather than being killed mid-write. A run needing more slice-time than that simply STOPPED, and
// its remainder fell back to the ten-minute cron: one slice per tick, mid-run, after the user had
// already been told a search was running. The original defect, arriving late.
//
// Rare today. It becomes the normal case the moment contact lookup widens beyond hot/warm — 500
// leads at ENRICH_BATCH = 5 is 100 enrichment slices, roughly 17 minutes of consecutive work.
// docs/lead-generator-completeness-plan.md §2.2.
//
// ⚠️ WHAT MUST NOT REGRESS: the three ways out of that loop are NOT equivalent, and collapsing
// them into "work remains, so chain" reads as obviously correct while turning a broken queue into
// an unbounded chain of invocations that outlives the process. That distinction is the whole of
// this file.
//
// Run:  npx tsx tests/discovery-drain-handoff.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideLoopExit, parseHandoff, HANDOFF_LIMITS } from '../netlify/functions/run-discovery-jobs-background';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MAX_HANDOFFS, MAX_PASSES } = HANDOFF_LIMITS;
const exit = (o: Partial<Parameters<typeof decideLoopExit>[0]>) =>
    decideLoopExit({ drained: false, passes: 3, maxPasses: MAX_PASSES, handoff: 0, ...o });

console.log('\n──── the three exits are different decisions ────');

check('an emptied queue hands off nothing', () => {
    // A poke here would start an invocation that finds no work and returns. Free, but it is a
    // loop with no stopping condition of its own if anything ever makes `drained` sticky.
    assert.equal(exit({ drained: true }), 'queue_empty');
    assert.equal(exit({ drained: true, handoff: 0 }), 'queue_empty');
    // Even at the pass ceiling, empty wins — there is genuinely nothing left.
    assert.equal(exit({ drained: true, passes: MAX_PASSES }), 'queue_empty');
});

check('a budget-exhausted run with work left hands off', () => {
    // The one legitimate case: real work, interrupted by a platform limit.
    assert.equal(exit({ drained: false, passes: 50 }), 'hand_off');
    assert.equal(exit({ drained: false, passes: 1 }), 'hand_off');
});

check('a queue burning passes without draining is left to the cron', () => {
    // ⚠️ THE ONE THAT MATTERS. MAX_PASSES exists to stop a pathological queue — every job erroring
    // instantly, say. Chaining here converts the safety net into a spin loop, and each link is a
    // fresh 12-minute invocation. The cron is the right owner of a queue behaving badly.
    assert.equal(exit({ drained: false, passes: MAX_PASSES }), 'leave_to_cron');
    assert.equal(exit({ drained: false, passes: MAX_PASSES + 10 }), 'leave_to_cron');
    // And it stays true at every chain depth — the pass ceiling is not negotiable by depth.
    for (let h = 0; h <= MAX_HANDOFFS; h++) {
        assert.equal(exit({ passes: MAX_PASSES, handoff: h }), 'leave_to_cron',
            `a spinning queue chained at depth ${h}`);
    }
});

console.log('\n──── the chain terminates ────');

check('the chain stops at the cap and says so', () => {
    for (let h = 0; h < MAX_HANDOFFS; h++) {
        assert.equal(exit({ handoff: h }), 'hand_off', `depth ${h} should still continue`);
    }
    assert.equal(exit({ handoff: MAX_HANDOFFS }), 'leave_to_cron', 'the cap does not stop the chain');
    assert.equal(exit({ handoff: MAX_HANDOFFS + 5 }), 'leave_to_cron');
});

check('the cap keeps one chain inside the hourly dispatch window', () => {
    // Not arbitrary: a chain still running when the next hourly dispatch fires overlaps it. That
    // is safe (the claim is one atomic UPDATE ... RETURNING) but it is compute nobody asked for,
    // and unbounded chaining is the shape that exhausted the project-wide quota on 2026-07-11.
    const chainMinutes = (MAX_HANDOFFS + 1) * (HANDOFF_LIMITS.BUDGET_MS / 60000);
    assert.ok(chainMinutes <= 60,
        `a full chain runs ${chainMinutes} minutes, past the hourly dispatch — lower MAX_HANDOFFS or raise the dispatch interval`);
});

console.log('\n──── depth cannot be forged ────');

check('a malformed or hostile body reads as a first poke', () => {
    // This endpoint is reachable by anything holding the shared secret, so the depth counter is
    // attacker-adjacent input, not just our own field.
    assert.equal(parseHandoff(null), 0);
    assert.equal(parseHandoff(undefined), 0);
    assert.equal(parseHandoff(''), 0);
    assert.equal(parseHandoff('not json at all'), 0);
    assert.equal(parseHandoff('{}'), 0);
    assert.equal(parseHandoff('{"handoff":"banana"}'), 0);
    assert.equal(parseHandoff('{"handoff":-5}'), 0, 'a negative depth would grant extra links');
    assert.equal(parseHandoff('{"handoff":null}'), 0);
});

check('a depth beyond the cap is clamped, never trusted upward', () => {
    // Clamping rather than rejecting: a too-large value must not wrap around into "continue".
    assert.equal(parseHandoff(`{"handoff":${MAX_HANDOFFS + 99}}`), MAX_HANDOFFS);
    assert.equal(parseHandoff('{"handoff":1e400}'), MAX_HANDOFFS, 'Infinity must not become a valid depth');
    assert.equal(parseHandoff('{"handoff":2.9}'), 2, 'a fractional depth truncates rather than rounding up');
});

check('a legitimate depth survives the round trip', () => {
    for (let h = 1; h <= MAX_HANDOFFS; h++) {
        assert.equal(parseHandoff(JSON.stringify({ reason: 'on_demand', jobId: 'x', handoff: h })), h);
    }
});

console.log('\n──── it is wired into the handler ────');

check('the handler uses the shared decision and carries depth forward', () => {
    const SRC = readFileSync(join(root, 'netlify/functions/run-discovery-jobs-background.ts'), 'utf8');
    assert.ok(/decideLoopExit\(\{ drained, passes/.test(SRC), 'the handler no longer asks the shared decision');
    assert.ok(/handoff: handoff \+ 1/.test(SRC), 'the chain depth is not incremented — the chain would never terminate');
    assert.ok(/drained = true; break/.test(SRC), 'an emptied queue no longer records that it emptied');
    // The poke must go through the shared trigger, which owns auth, the base URL and the
    // fail-to-cron promise that makes every one of these safe.
    assert.ok(/triggerDiscoveryDrain\(/.test(SRC), 'the hand-off no longer goes through the shared trigger');
    const TRIGGER = readFileSync(join(root, 'src/utils/trigger-drain.ts'), 'utf8');
    assert.ok(/\.\.\.extra/.test(TRIGGER), 'the trigger no longer forwards extra body fields — depth cannot travel');
});

console.log(`\n${passed} checks passed.`);
