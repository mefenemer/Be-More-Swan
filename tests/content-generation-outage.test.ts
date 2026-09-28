// tests/content-generation-outage.test.ts
// The three things that turned an exhausted API balance into eleven days of lost work.
//
// Between 2026-09-17 and 2026-09-28 every AI draft on production failed. The Anthropic account's
// credit balance ran out, and three separate decisions — each defensible on its own — compounded
// into 1,829 permanently lost posts across all five organisations:
//
//   1. A failure that could never succeed still spent all three of the job's attempts, because
//      failover only covered 429 and 503 and a credit failure arrives as a 400. At max_attempts the
//      job marked itself 'failed', and nothing requeues a failed job — so the loss was permanent,
//      and a top-up would not have undone it.
//   2. Every one of those customers was told to "please try again", advice that could not work.
//   3. Nothing watched. Each failure notified the owner of the workspace it happened in, and nobody
//      sees five workspaces at once, so the outage was visible five times over and invisible in
//      aggregate.
//
// These are source-text checks by necessity: the failure is a Netlify function's catch block against
// a live database, and what matters is the ORDER of the guards inside it. The ordering assertions
// use `landmark`, because -1 is less than every real index and a stale anchor would report green.
//
// Run:  npx tsx tests/content-generation-outage.test.ts

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
const drain = readFileSync(join(root, 'netlify/functions/process-content-jobs.ts'), 'utf8');
const health = readFileSync(join(root, 'netlify/functions/check-content-generation-health.ts'), 'utf8');
const catalog = readFileSync(join(root, 'src/utils/notification-templates-catalog.ts'), 'utf8');
const gateway = readFileSync(join(root, 'src/lib/ai-gateway.ts'), 'utf8');
const requeue = readFileSync(join(root, 'scripts/requeue-failed-content-jobs.ts'), 'utf8');
const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');

console.log('\nan outage at our end does not spend the customer\'s retries');

check('the upstream check runs BEFORE the give-up check', () => {
    // ⚠️ The whole fix is this ordering. Below the max_attempts branch it would never be reached:
    // three attempts against a refusing API take seconds, so the job is already at max_attempts by
    // the time anyone asks whose fault it was.
    assert.ok(
        landmark(drain, 'if (isUpstreamBlocked(err)) {') < landmark(drain, 'if (attempt >= job.max_attempts) {'),
        'a job still fails terminally before anyone asks whether the fault was ours',
    );
});

check('a parked job gets its attempt back', () => {
    const park = drain.slice(landmark(drain, 'if (isUpstreamBlocked(err)) {'),
                             landmark(drain, 'if (attempt >= job.max_attempts) {'));
    assert.ok(park.includes("status = 'queued'"), 'a parked job is not put back in the queue');
    assert.ok(park.includes('attempt = GREATEST(attempt - 1, 0)'),
        'our outage still consumes one of the three tries that exist for the job being bad');
    assert.ok(park.includes('next_retry_at'), 'the parked job re-runs immediately and spins');
});

check('parking is bounded, because a revoked key never comes back', () => {
    assert.ok(/const PARK_MAX_HOURS = \d+;/.test(drain), 'a job can be parked forever');
    assert.ok(/const PARK_RETRY_MINS = \d+;/.test(drain), 'the park interval is not stated');
    const park = drain.slice(landmark(drain, 'if (isUpstreamBlocked(err)) {'),
                             landmark(drain, 'if (attempt >= job.max_attempts) {'));
    assert.ok(park.includes('ageHours < PARK_MAX_HOURS'), 'the age ceiling is not applied');
    // Past the ceiling it fails for real — and says whose fault it was.
    assert.ok(park.includes("'post_generation_blocked_upstream'"),
        'giving up after an outage still blames the customer');
});

check('one classifier, shared with the two functions that already use it', () => {
    assert.ok(drain.includes("import { gatewayGenerate, isUpstreamBlocked } from '../../src/lib/ai-gateway';"),
        'the drain classifies upstream failures on its own');
    // ⚠️ 429/503 only, which is exactly why a 400 credit failure got no failover. The classifier is
    // the thing that knows better, and it has to keep knowing.
    assert.ok(gateway.includes('export function isUpstreamBlocked('), 'the shared classifier is gone');
    assert.ok(/credit balance/.test(gateway), 'an exhausted balance is no longer recognised');
});

console.log('\nnobody is told to retry a failure that cannot clear');

check('the outage template exists, says it is ours, and carries no variables', () => {
    const i = landmark(catalog, "templateKey: 'post_generation_blocked_upstream'");
    const tpl = catalog.slice(i, i + 900);
    assert.ok(tpl.includes('this is at our end, not yours'), 'the customer is still blamed');
    assert.ok(!/Please try again/.test(tpl), 'it still advises a retry that cannot work');
    // ⚠️ No variables: the stored error is the upstream body verbatim, carrying our billing state.
    assert.ok(tpl.includes('variables: []'), 'the upstream error can reach the customer');
    // Same TYPE on purpose — a new type touches five places and none of them needed to change.
    assert.ok(tpl.includes("type: 'post_generation_failed'"), 'a new notification type was introduced');
});

console.log('\nsomething watches the whole platform, not one workspace at a time');

check('it alerts on the SPREAD across organisations, not a job count', () => {
    // One workspace failing is that workspace's content problem. Several at once is ours, always —
    // they share nothing except us — and waiting for a volume threshold misses the first morning.
    assert.ok(/const ORGS_THAT_MEAN_PLATFORM = \d+;/.test(health), 'the threshold is not stated');
    assert.ok(health.includes('organisationsAffected >= ORGS_THAT_MEAN_PLATFORM'),
        'the alert is keyed on something other than the spread');
    assert.ok(health.includes('GROUP BY organisation_id'), 'it cannot see across workspaces');
});

check('it reads the success log too, and never reads it alone', () => {
    // ai_usage_log is written only on success, which makes it the cheapest liveness check there is.
    // ⚠️ But 10 of the platform's 13 successful calls that week landed in the final 24 hours WHILE
    // failures continued — so a nonzero count is not health, and it has to be reported beside them.
    assert.ok(health.includes('FROM ai_usage_log'), 'the success side is not checked at all');
    assert.ok(health.includes('successes24h'), 'the success count is not reported to the reader');
    assert.ok(health.includes('failedJobs24h'), 'the failure count is not reported beside it');
});

check('an ongoing incident does not email on every run, and a failed alert is loud', () => {
    assert.ok(/const ALERT_COOLDOWN_HOURS = \d+;/.test(health), 'there is no cooldown');
    assert.ok(landmark(health, 'sinceAlert < ALERT_COOLDOWN_HOURS') < landmark(health, 'await sendEmail({'),
        'the email is sent before the cooldown is consulted');
    assert.ok(/ALERT SEND FAILED/.test(health),
        'a failed alert reads as a clean run, which is how an outage stays quiet twice over');
});

check('it is scheduled, on its own entry, away from the drain it watches', () => {
    const i = landmark(toml, '[functions.check-content-generation-health]');
    assert.match(toml.slice(i, i + 120), /schedule = "/, 'the watchdog is not scheduled');
    // A different entry from the thing it watches, so one broken entry cannot take both.
    assert.ok(!toml.slice(i, i + 120).includes('*/10 * * * *'),
        'the watchdog shares the drain\'s schedule, so one fault takes both');
});

console.log('\nthe biggest AI consumer in the product is finally metered');

check('the gateway logs usage, because it is the one place every call passes through', () => {
    // ⚠️ Post generation was recorded NOWHERE — neither process-content-jobs nor the gateway called
    // logAiUsage, so ai_usage_log held only the ad-hoc paths. Measured on production 2026-09-28: ten
    // drafting jobs completed in thirty minutes while the table recorded four calls in two hours.
    // Token and cost attribution for the largest consumer did not exist, which takes billing, task
    // credits and per-workspace COGS with it.
    assert.ok(gateway.includes('function recordUsage('), 'the gateway still meters nothing');
    assert.ok(gateway.includes('logAiUsage({'), 'no usage row is written');
    // Both entry points, or the grounded path is a hole in the same shape.
    assert.strictEqual(gateway.split('recordUsage(req, response').length - 1, 2,
        'only one of the two generate paths records usage');
});

check('it records the model KEY WE INVOKED, not the dated id the API returns', () => {
    // The API resolves 'claude-sonnet-4-6' into a dated id, ai_model_pricing is keyed on the undated
    // constant, and every other caller logs its own MODEL constant — so recording response.model
    // would match no pricing row and write every drafting call in at $0.00. Which is the hole.
    assert.ok(gateway.includes('recordUsage(req, response, usedFallback ? FALLBACK_MODEL : PRIMARY_MODEL)'),
        'the plain path records a model key that will not price');
    assert.ok(gateway.includes('model:        modelKey,'), 'recordUsage ignores the key it was given');
    assert.ok(!/model:\s+response\.model,\n\s+inputTokens/.test(gateway),
        'the dated model id is back, and prices at zero');
});

check('book-keeping can never fail a job', () => {
    const fn = gateway.slice(landmark(gateway, 'function recordUsage('),
                             landmark(gateway, 'export async function gatewayGenerateGrounded('));
    assert.ok(fn.includes('void logAiUsage('), 'the usage write is awaited, so it can delay a draft');
    assert.ok(fn.includes('catch (err)'), 'a logging failure can still take the generated post down');
});

check('the drain opts in, and counts the near-duplicate re-ask separately', () => {
    // Opt-in on purpose: about a dozen callers already log for themselves, and making it
    // unconditional would double-count every one of them.
    assert.ok(drain.includes('const jobUsage = {'), 'drafting is unmetered again');
    assert.strictEqual(drain.split('usage: jobUsage').length - 1, 2,
        'one of the two billable calls per post is still invisible');
    assert.ok(drain.includes('workspaceId: job.organisation_id'), 'the cost is not attributed to a workspace');
});

console.log('\nthe lost work can be brought back, carefully');

check('the requeue only touches jobs the outage failed', () => {
    // A job that failed on a missing blueprint, or a model that would not produce JSON, is a real
    // failure. Requeuing those runs them three more times to reach the same answer and buries the
    // genuine problem in the noise.
    assert.ok(requeue.includes("--match"), 'it cannot be scoped to the outage');
    assert.ok(requeue.includes('credit balance is too low'), 'the default scope is not this outage');
    assert.ok(requeue.includes('result_post_id IS NULL'),
        'a job that already wrote a post could be run again — which is how one job wrote two');
});

check('it is a dry run by default and released in batches', () => {
    assert.ok(requeue.includes("args.includes('--apply')"), 'it writes without being asked');
    assert.ok(landmark(requeue, 'if (!apply) {') < landmark(requeue, 'UPDATE content_generation_jobs'),
        'the write happens before the dry-run check');
    // ⚠️ The drain takes 20 per 10-minute tick. Releasing 1,829 at once is a thundering herd at a
    // provider that has just come back, and a fortnight of backdated posts in five review queues.
    assert.ok(/const limit = Number\(flag\('limit'\)\) \|\| \d+;/.test(requeue), 'there is no batch limit');
    assert.ok(requeue.includes('LIMIT ${limit}'), 'the limit is not applied to the update');
});

check('the match cannot be widened into "every failed job" by accident', () => {
    // An operator passing --match with a % would otherwise silently widen the LIKE, and the widest
    // version of that query requeues everything that has ever failed.
    assert.ok(requeue.includes("replace(/[%_\\\\]/g"), 'a wildcard in --match widens the scope silently');
    assert.ok(requeue.includes("ESCAPE '\\\\'"), 'the escaped pattern is not declared to postgres');
});

check('it refuses to release backdated slots without being told to', () => {
    // ⚠️ THE DANGEROUS PART, and it is not the API spend. A job carries the slot it was meant to
    // publish in, the draft inherits it, runAutoPublishGate can promote a draft to 'scheduled' and
    // has NO staleness check, and publish-social-posts takes everything scheduled with
    // publish_date <= now(). Requeued unmodified, this backlog posts a fortnight of old content to
    // five customers' real accounts within five minutes, unread.
    assert.ok(requeue.includes('--shift-days'), 'the slots cannot be moved out of the past');
    assert.ok(requeue.includes('REFUSING'), 'it releases backdated slots silently');
    assert.ok(landmark(requeue, 'if (stale && shiftDays == null && !keepDates) {')
              < landmark(requeue, 'UPDATE content_generation_jobs\n            SET'),
        'the refusal is checked after the write');
    // Refused rather than defaulted: the right shift depends on when it is run and must be the same
    // for every batch, so guessing it for the operator is the incident this prevents.
    assert.ok(requeue.includes('--keep-dates'), 'there is no way to say "yes, I meant that"');
    assert.ok(requeue.includes("target_publish_date + interval '${shiftDays} days'"),
        'the shift is computed but never applied');
    // ⚠️ ONLY the slots that have passed. A job is enqueued AHEAD of its slot, so most of a backlog
    // is still correctly dated — the first real dry run found 275 stale out of 1,834. Shifting the
    // batch wholesale would move fifteen hundred good posts later than the customer asked for.
    assert.ok(requeue.includes('WHEN target_publish_date < now()'),
        'it shifts correctly-dated posts too, and calls that a recovery');
    assert.ok(requeue.includes('ELSE target_publish_date'), 'a future slot is not preserved');
    // Applied to the slot, not to created_at — the oldest waiting customer still goes first.
    assert.ok(requeue.includes('ORDER BY created_at LIMIT'), 'the release order changed');
});

check('the dry run computes the shift so the operator does not have to', () => {
    assert.ok(requeue.includes('const recommended'), 'the operator is asked for a number with no way to know it');
    assert.ok(requeue.includes('target_publish_date < now()'), 'it cannot tell which slots have passed');
});

check('--url-var takes a NAME, never a connection string', () => {
    assert.ok(requeue.includes("flag('url-var') ?? 'NETLIFY_DATABASE_URL'"), 'the target cannot be chosen');
    assert.ok(requeue.includes('describeTarget'), 'it does not announce which database it will write to');
    assert.ok(/never a connection string/.test(requeue), 'the convention is not stated where it is read');
});

console.log(`\n${passed} checks passed.\n`);
