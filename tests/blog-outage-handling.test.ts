// tests/blog-outage-handling.test.ts
// The blog pipeline's half of the September outage lesson.
//
// ── What it got wrong ───────────────────────────────────────────────────────────────────────────
// Between 2026-09-19 and 09-28 the Anthropic balance was exhausted and every ideation call failed.
// ideateBlogTopic swallowed the error into `null`; the caller reads `null` as "no topic could be
// grounded"; so 36 jobs across three organisations told their owners:
//
//     "Could not ground a topic for this slot."
//
// All three organisations had a business description AND a target audience. The topic was groundable
// every time. That sentence names the one cause the reader can act on, so when it is wrong it sends
// them to edit a profile that was never the problem — and it blamed them for our unpaid bill.
//
// Proven three ways when it was investigated: every failure fell inside the outage window and ramped
// with it, all three orgs had the context the message blamed, and there have been none since the
// balance was topped up.
//
// ── And what it still lacked ────────────────────────────────────────────────────────────────────
// The blog worker had none of the social worker's protections — no upstream classification, no
// parking — so the next outage would have burned blog jobs terminally exactly as this one burned
// 1,829 social ones. Nothing requeues a failed job.
//
// Run:  npx tsx tests/blog-outage-handling.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(import.meta.dirname, '..');
const ideation = readFileSync(join(root, 'src/utils/blog-topic-ideation.ts'), 'utf8');
const worker = readFileSync(join(root, 'netlify/functions/process-blog-jobs.ts'), 'utf8');

console.log('\nan outage is not an ungroundable topic');

check('an API failure THROWS rather than becoming null', () => {
    // ⚠️ The whole misreporting. Four causes — no context, an unreadable reply, a dead API, a revoked
    // key — collapsed into one return value, and the caller could only describe the first.
    const tail = ideation.slice(landmark(ideation, 'ideateBlogTopic: assistant ${assistantId} failed'));
    assert.ok(tail.includes('throw err;'), 'an API failure is still swallowed into null');
    assert.ok(!/return null;\s*\n\s*\}\s*\n\}/.test(tail), 'the catch still returns null');
});

check('null is kept for the cases where it is TRUE', () => {
    // "No business context to ground on" and "the reply was unreadable" really are skip-this-slot,
    // and turning those into throws would park jobs that have a real content problem.
    // Setup's Blog Topics also grounds a topic (2026-10-09), so it joins the two signals here.
    assert.ok(ideation.includes('if (!hasOrgContext && !inspoBlock && !setupTopics) return null;'),
        'the genuinely ungroundable case no longer returns null');
    assert.ok(ideation.includes('if (!parsed) return null;'), 'an unreadable reply no longer returns null');
    assert.ok(ideation.includes('if (!title) return null;'), 'a title-less reply no longer returns null');
});

console.log('\nthe blog worker waits out an outage instead of burning the job');

check('the upstream check runs BEFORE the ordinary failure path', () => {
    // Below failJob it would never be reached: three attempts against a refusing API take minutes,
    // and a failed blog job is as unrecoverable as a failed social one.
    assert.ok(landmark(worker, 'if (isUpstreamBlocked(err)) {')
              < landmark(worker, 'await failJob(db, job, attempt, message, { orphanPostId: createdPostId });'),
        'the job fails terminally before anyone asks whose fault it was');
});

check('a parked job gets its attempt back, and waits', () => {
    const fj = worker.slice(landmark(worker, 'async function failJob('), landmark(worker, 'export default withLambda('));
    assert.ok(fj.includes('attempt: Math.max(0, attempt - 1)'),
        'our outage still consumes one of the three tries that exist for the job being bad');
    assert.ok(fj.includes('PARK_RETRY_MINS * 60'), 'a parked job re-runs on the ordinary backoff and spins');
    // ⚠️ A park is never "exhausted", whatever the attempt count says.
    assert.ok(fj.includes('!opts.park && (opts.terminal || attempt >= job.max_attempts)'),
        'a park at max attempts is still treated as terminal');
});

check('parking cleans up the half-built draft, exactly as a retry does', () => {
    // ⚠️ Routed through failJob rather than written inline for this reason: a park that skipped the
    // orphan cleanup would leave an empty post row per attempt, and a 72-hour outage would fill the
    // Blogs tab with them.
    const park = worker.slice(landmark(worker, 'if (isUpstreamBlocked(err)) {'), landmark(worker, 'const UPSTREAM_GIVE_UP'));
    assert.ok(park.includes('orphanPostId: createdPostId, park: true'),
        'the park path bypasses failJob, so the empty draft is left behind');
});

check('parking is bounded, because a revoked key never comes back', () => {
    assert.ok(/const PARK_MAX_HOURS = \d+;/.test(worker), 'a blog job can be parked forever');
    assert.ok(worker.includes('ageHours < PARK_MAX_HOURS'), 'the age ceiling is not applied');
    // Same numbers as the social worker on purpose — two waiting policies is two things to reason
    // about during an incident.
    const social = readFileSync(join(root, 'netlify/functions/process-content-jobs.ts'), 'utf8');
    const grab = (src: string, name: string) => {
        const m = src.match(new RegExp('const ' + name + ' = (\\d+);'));
        return m ? m[1] : undefined;
    };
    for (const k of ['PARK_RETRY_MINS', 'PARK_MAX_HOURS']) {
        // ⚠️ Asserted PRESENT before asserted equal: two undefineds are strictEqual, so a renamed
        // constant on both sides would report green while guarding nothing.
        assert.ok(grab(worker, k), `${k} not found in the blog worker`);
        assert.ok(grab(social, k), `${k} not found in the social worker`);
        assert.strictEqual(grab(worker, k), grab(social, k), `${k} differs between the two workers`);
    }
});

check('giving up says whose fault it was', () => {
    // ⚠️ Never "Could not ground a topic for this slot." again on this path — that sentence sends the
    // reader to fix a business profile that was never the problem.
    assert.ok(worker.includes('const UPSTREAM_GIVE_UP'), 'there is no separate wording for an outage');
    const msg = worker.slice(landmark(worker, 'const UPSTREAM_GIVE_UP'));
    assert.ok(msg.includes('this is at our end, not '), 'the customer is still blamed for an outage');
    assert.ok(msg.includes('nothing about your setup needs changing'),
        'it does not say the thing the old message got wrong — that their profile is fine');
    assert.ok(!/ground a topic/.test(msg), 'the misleading sentence is back on the outage path');
    assert.ok(worker.includes('terminal: true'), 'the give-up is not terminal, so the job loops forever');
});

console.log(`\n${passed} checks passed.\n`);
