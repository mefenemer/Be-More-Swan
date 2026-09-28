// tests/auto-publish-stale-slot.test.ts
// Autopilot will not publish a draft that was written for a moment which has already gone.
//
// ── The hole this closes ────────────────────────────────────────────────────────────────────────
// decideAutoPublish weighed publish mode, media, confidence, factual claims, a live connection and
// the weekly ceiling — and had NO notion of time. It promoted the draft to 'scheduled', and
// publish-social-posts takes anything scheduled with `publish_date <= now()` on its next tick. So a
// post drafted after its slot published INSTANTLY, unread, and read to the customer as the product
// deciding by itself to post something stale.
//
// Theoretical until 2026-09-28, when 1,834 jobs were requeued after an eleven-day outage. Slots
// already in the past were shifted forward before release — but the drain manages about twelve jobs
// an hour, so the backlog runs for days, and slots comfortably in the future at release go stale
// while they wait. No guard in the release script could cover that; only one at the decision can.
//
// These are source-text checks: decideAutoPublish needs a database, and what matters is the ORDER of
// the guards and that both call sites pass the slot. Ordering uses `landmark`, because -1 is less
// than every real index and a stale anchor would report green.
//
// Run:  npx tsx tests/auto-publish-stale-slot.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landmark } from './landmark';
import { AUTO_PUBLISH_STALE_AFTER_H, type GateReason } from '../src/utils/publish-policy';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(import.meta.dirname, '..');
const runtime = readFileSync(join(root, 'src/utils/auto-publish-runtime.ts'), 'utf8');
const policy  = readFileSync(join(root, 'src/utils/publish-policy.ts'), 'utf8');
const drain   = readFileSync(join(root, 'netlify/functions/process-content-jobs.ts'), 'utf8');

console.log('\na draft that is late for its own slot goes to review');

check('the window is a stated constant, not a number buried in a condition', () => {
    assert.strictEqual(typeof AUTO_PUBLISH_STALE_AFTER_H, 'number');
    assert.ok(AUTO_PUBLISH_STALE_AFTER_H > 0, 'a zero window would refuse every draft');
    // An autopilot slot means "post around this time", so an hour or two late is the system working.
    // A window under an hour would send ordinary on-time drafts to review and train people to ignore
    // the reason.
    assert.ok(AUTO_PUBLISH_STALE_AFTER_H >= 1, 'punctual drafts would be held back');
});

check('being late DOWNGRADES to review — it never drops the post', () => {
    // ⚠️ A UNIQUE end marker. 'return { ...gate, connectionId };' appears twice and the first is the
    // early return ABOVE this guard, so slicing to it measured backwards and reported the guard
    // missing — the trap logged in source-scan-markers-must-be-unique.
    const guard = runtime.slice(landmark(runtime, 'const dueAt = args.publishDate'),
                                landmark(runtime, '/** Human-readable trail'));
    assert.ok(guard.includes("status: 'pending_approval'"), 'a late draft is not routed to review');
    assert.ok(guard.includes("reason: 'slot_has_passed'"), 'the reason is not recorded');
    assert.ok(!/status: 'rejected'|delete|drop/i.test(guard),
        'the post is discarded rather than offered to a human');
});

check('an absent slot is treated as on time', () => {
    // ⚠️ A caller that cannot say when a post is due must not have its drafts silently held back —
    // on-demand and admin-test drafting have no slot at all, and failing closed there would quietly
    // disable auto-publish for them.
    const guard = runtime.slice(landmark(runtime, 'const dueAt = args.publishDate'),
                                landmark(runtime, '/** Human-readable trail'));
    assert.ok(guard.includes('dueAt != null && Number.isFinite(dueAt)'),
        'an unknown or unparseable slot changes the decision');
});

check('the guard runs AFTER the cheap refusals, and before publishing', () => {
    // Order matters for what the reviewer is told: a post that is both late and on a platform in
    // review mode should say "review mode", because that is the thing its owner can act on. Lateness
    // is the last question asked of a draft that would otherwise have gone out.
    assert.ok(landmark(runtime, "reason: 'no_live_connection'") < landmark(runtime, "reason: 'slot_has_passed'"),
        'a late post with no connection now blames its lateness');
    assert.ok(landmark(runtime, "reason: 'weekly_cap_reached'") < landmark(runtime, "reason: 'slot_has_passed'"),
        'a capped assistant now blames its lateness');
    // The success return is the LAST one in the function, so its position is a lastIndexOf — the
    // first occurrence is the early bail-out near the top.
    assert.ok(landmark(runtime, "reason: 'slot_has_passed'") < runtime.lastIndexOf('return { ...gate, connectionId };'),
        'the guard sits after the success return, so it is never reached');
});

console.log('\nboth ways a post is drafted pass the slot');

check('the primary draft passes the job\'s slot', () => {
    assert.ok(drain.includes('publishDate: job.target_publish_date ? new Date(job.target_publish_date) : null'),
        'the primary post is judged with no idea when it was due');
    assert.ok(drain.includes('publishDate: args.publishDate ?? null'),
        'runAutoPublishGate accepts a slot and then does not forward it');
});

check('a fanned-out sibling is judged against the SAME moment as the primary', () => {
    // Otherwise half a cross-post publishes itself while the other half goes to review, which reads
    // as a deliberate two-platform post and says nothing — the exact failure the per-sibling error
    // handling in this loop already exists to prevent.
    assert.ok(drain.includes('publishDate: primary?.publishDate ?? (job.target_publish_date'),
        'a sibling is judged against a different slot from its primary');
});

console.log('\nthe reviewer is told something they can act on');

check('the reason is spelled out, not left as a slug', () => {
    // Every other reason names something its owner already knows about — their publish mode, their
    // connection, their ceiling. This one names something they have never seen, so "slot has passed"
    // reads as a fault rather than as a decision.
    const desc = runtime.slice(landmark(runtime, 'export function describeDecision('), runtime.length);
    assert.ok(desc.includes("decision.reason === 'slot_has_passed'"), 'the new reason has no wording of its own');
    assert.ok(/written for a time that has already passed/.test(desc), 'it does not say what happened');
    // ⚠️ And what approving it will DO. Approving a post whose slot has passed publishes it at once,
    // which is not what "approve" means anywhere else in the queue.
    assert.ok(/publish straight away/.test(desc), 'the consequence of approving it is not stated');
});

check('slot_has_passed is a real member of the reason union', () => {
    const reason: GateReason = 'slot_has_passed';
    assert.strictEqual(reason, 'slot_has_passed');
    assert.ok(policy.includes("| 'slot_has_passed'"), 'the reason is not in the union');
});

console.log(`\n${passed} checks passed.\n`);
