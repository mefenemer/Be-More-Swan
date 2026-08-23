// tests/assistant-pause-defects.test.ts
// The two pause defects found on 2026-08-23 (docs/assistant-pause-defects.md).
//
//   1. `paused_limit` had ONE writer and NO releaser. A user who archived an assistant to get back
//      under their plan stayed paused, with no route out except a billing change.
//   2. The discovery worker had no reference to lifecycleStatus, isActive or archivedAt, so a
//      paused assistant kept spending on searches and model calls while its own dashboard said it
//      was paused.
//
// Source-scanned, because both are about which code paths exist and what they are gated on — an
// integration test would need a Stripe webhook and a paid search provider to prove the same thing.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nAssistant pause defects\n');

const RELEASE = read('src/utils/release-paused-limit.ts');
const ARCHIVE = read('netlify/functions/manage-assistant.ts');
const WEBHOOK = read('netlify/functions/stripe-webhook.ts');
const WORKER = read('netlify/functions/process-discovery-jobs.ts');
const SWEEP = read('netlify/functions/lead-enrichment-sweep.ts');

// ── 1. paused_limit can now be released ────────────────────────────────────────────────────────

check('a releaser exists at all', () => {
    assert.match(RELEASE, /export async function releasePausedLimit/);
});

check('it resumes ONLY paused_limit', () => {
    // ⚠️ paused_payment is another system's gate, paused_quota clears itself on the 1st, and an
    // assistant the user switched off is `complete` + isActive=false and must stay off. Keeping
    // those apart is the whole reason the statuses are distinct.
    assert.match(RELEASE, /eq\(aiAssistants\.provisioningStatus, 'paused_limit'\)/);
    for (const other of ['paused_payment', 'paused_quota']) {
        assert.ok(!new RegExp(`provisioningStatus, '${other}'`).test(RELEASE), `${other} must not be touched`);
    }
});

check('the marker is re-asserted inside the UPDATE', () => {
    // Same guard resume-quota-paused.ts uses: a row that changed between the SELECT and the write
    // must not be resurrected.
    const i = RELEASE.indexOf('.update(aiAssistants)');
    assert.ok(i > 0);
    assert.match(RELEASE.slice(i, i + 600), /eq\(aiAssistants\.provisioningStatus, 'paused_limit'\)/);
});

check('lifecycleStatus is left to the trigger', () => {
    // ai_assistants_lifecycle_sync derives it from (provisioningStatus, isActive). Writing it here
    // too would give one column two authors that can disagree.
    assert.ok(!/lifecycleStatus:/.test(RELEASE), 'the derived column must not be hand-written');
});

check('free seats are counted excluding archived assistants', () => {
    // An archived assistant sits in its reinstate window still flagged active, so isActive alone
    // under-reports the free seats and would release nothing.
    assert.match(RELEASE, /isNull\(aiAssistants\.archivedAt\)/);
});

check('the limit is resolved the same way the capacity gate resolves it', () => {
    // A frozen "new subscribers only" snapshot wins over the live master limit, and referral bonus
    // seats stack on top. Resolving it differently would let one surface hand back a seat the
    // other refuses.
    assert.match(RELEASE, /effectiveLimit\(/);
    assert.match(RELEASE, /bonusAssistants/);
});

check('resuming is the inverse of pausing', () => {
    // The downgrade sorts newest-first and pauses from the END (the oldest). Restoring newest-first
    // among the paused gives back the last one taken away, first.
    assert.match(RELEASE, /orderBy\(desc\(aiAssistants\.createdAt\)\)/);
    assert.match(WEBHOOK, /orderBy\(desc\(aiAssistants\.createdAt\)\); \/\/ newest first/);
});

check('archiving an assistant releases the seat it frees', () => {
    // The obvious way to comply with a limit did nothing about a pause caused BY that limit.
    assert.match(ARCHIVE, /releasePausedLimit\(db, ctx\.userId, orgId\)/);
});

check('a plan change that makes room releases too', () => {
    assert.match(WEBHOOK, /releasePausedLimit\(db, userId, uo\.organisationId\)/);
});

check('an upgrade to an UNLIMITED plan releases as well', () => {
    // ⚠️ My first version sat as an `else` inside `if (assistantLimit !== null)`, so the most
    // generous change a customer can make — upgrading to a plan with no assistant cap — skipped the
    // whole block and released nothing.
    const guard = WEBHOOK.indexOf("newMasterPlan?.assistantLimit !== null");
    const release = WEBHOOK.indexOf('releasePausedLimit(db, userId');
    const blockEnd = WEBHOOK.indexOf('if (newMasterPlan && !pausedForLimit)');
    assert.ok(guard > 0 && release > 0 && blockEnd > 0);
    assert.ok(release > blockEnd, 'the release must sit outside the limit guard, not inside it');
});

check('a downgrade does not hand back the seats it just took', () => {
    // The same event pauses and then reaches the release. Without the flag it would undo itself.
    assert.match(WEBHOOK, /let pausedForLimit = false;/);
    assert.match(WEBHOOK, /pausedForLimit = true;/);
    assert.match(WEBHOOK, /if \(newMasterPlan && !pausedForLimit\)/);
});

check('releasing never fails the action that triggered it', () => {
    assert.match(RELEASE, /catch \(err\)/, 'an archive must not fail because a courtesy resume did');
});

// ── 2. a paused assistant no longer spends ─────────────────────────────────────────────────────

check('the discovery worker checks whether its assistant is active', () => {
    // It had NO reference to any of these. Assistant 21 was paused from 2026-08-19 and still ran
    // 8 paid searches on 2026-08-23.
    assert.match(WORKER, /owner\.isActive !== true \|\| owner\.archivedAt !== null/);
});

check('the gate matches the one the enrichment sweep already had', () => {
    // Same subsystem, same money, and only one of the two spenders was gated.
    assert.match(SWEEP, /eq\(aiAssistants\.isActive, true\)/);
    assert.match(WORKER, /archivedAt: aiAssistants\.archivedAt/);
});

check('a paused run is DEFERRED, not failed', () => {
    // ⚠️ A pause is a fixable configuration state, not a verdict about the campaign. Failing would
    // kill a run the user can resume in one click, and a failed job is not resumable — the same
    // choice process-sequence-sends.ts makes for a missing postal address.
    const i = WORKER.indexOf("owner.isActive !== true");
    const block = WORKER.slice(i, i + 900);
    assert.match(block, /status: 'queued'/, 'the job must go back to the queue');
    assert.match(block, /nextRetryAt/, 'and back off rather than spin on every drain tick');
    assert.ok(!/finishJob\(db, job\.id, 'failed'/.test(block), 'a pause must not fail the job');
});

check('the deferral says why, in words a user could read', () => {
    const i = WORKER.indexOf("owner.isActive !== true");
    assert.match(WORKER.slice(i, i + 900), /errorMessage: 'Paused —/);
});

check('the gate runs before any spending', () => {
    // After the campaign load, but before query generation, search or scoring — otherwise it would
    // gate the second slice while the first had already been paid for.
    const gate = WORKER.indexOf("owner.isActive !== true");
    for (const spender of ['await generateQueries({', 'await search(query,', 'await scoreCandidates(']) {
        assert.ok(gate < WORKER.indexOf(spender), `the gate must precede ${spender}`);
    }
});

console.log(`\n${passed} checks passed\n`);
