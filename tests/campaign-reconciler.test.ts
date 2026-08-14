// tests/campaign-reconciler.test.ts
// The Campaign Assistant's RETURN path: how an order settles, and what the reconciler must never do.
//
// Two halves, mirroring tests/campaign-proposer.test.ts.
//
//   1. THE VERDICT IS PURE, so it is unit-tested directly. `verdictFromArtefactStatuses` is the
//      whole decision — everything else in the file is plumbing that fetches rows and writes the
//      answer down. Getting the precedence wrong is invisible in types and expensive in practice:
//      an order that reads 'delivered' while three of its posts sit unapproved drops them off the
//      user's radar permanently, because nothing re-examines a terminal order.
//
//   2. THE MANDATE MUST HOLD, which types cannot express, so it is source-scanned. The reconciler
//      is allowed to act, unlike the proposer, and that makes the boundary of what it may act on
//      the load-bearing claim of the whole file: it may record what happened, and it may release an
//      order a human already approved. It may NOT start a campaign, un-pause one, raise a budget or
//      call a model. Each of those would compile and pass every other test.
//
// No database: pure functions plus source-consistency checks, matching every other file in tests/
// except rls-enforcement.
// Run:  npx tsx tests/campaign-reconciler.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictFromArtefactStatuses } from '../src/utils/campaign-reconciler';
import { CAMPAIGN_ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../src/config/campaign-vocab';
import { SCHEDULE_ACTIVE_STATUSES, SCHEDULE_INACTIVE_STATUSES } from '../src/config/post-status';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Blank out comments, preserving length — the files below EXPLAIN the bans they must not violate. */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const reconcilerSrc = stripComments(read('src/utils/campaign-reconciler.ts'));
const functionSrc = stripComments(read('netlify/functions/reconcile-campaigns.ts'));

console.log('\n──── the verdict reads the artefacts correctly ────');

check('a batch still awaiting approval is in_review, not delivered', () => {
    // The precedence that matters most. A half-approved batch is still asking the user for
    // something, and 'delivered' would settle the order and stop anything re-examining it.
    const v = verdictFromArtefactStatuses(['published', 'pending_approval', 'scheduled'], 'post');
    assert.equal(v.kind, 'in_review');
    assert.match((v as { summary: string }).summary, /1 post waiting/);
});

check('a fully approved batch delivers', () => {
    const v = verdictFromArtefactStatuses(['approved', 'scheduled', 'published'], 'post');
    assert.equal(v.kind, 'delivered');
    assert.match((v as { summary: string }).summary, /3 posts/);
});

check('a batch the user turned down is rejected, not delivered', () => {
    const v = verdictFromArtefactStatuses(['rejected', 'cancelled'], 'post');
    assert.equal(v.kind, 'rejected');
});

check('a post that failed to PUBLISH still counts as delivered', () => {
    // The campaign produced the work and the user committed it; a publish failure is a delivery
    // problem with its own recovery path. Calling it 'not delivered' would blame the campaign for
    // an expired access token.
    assert.equal(verdictFromArtefactStatuses(['failed'], 'post').kind, 'delivered');
});

check('the X credit park is delivered, not lost', () => {
    // paused_credits was invisible to two status lists once already (post-status.ts documents it).
    // A committed post waiting on quota must not read as an undelivered order.
    assert.equal(verdictFromArtefactStatuses(['paused_credits'], 'post').kind, 'delivered');
});

check('no artefacts at all is unknowable, never a delivery', () => {
    assert.equal(verdictFromArtefactStatuses([], 'post').kind, 'unknowable');
    assert.equal(verdictFromArtefactStatuses([], 'blog').kind, 'unknowable');
});

check('blog statuses are judged on the blog vocabulary, not the social one', () => {
    // 'archived' exists only for blog_posts; asking isScheduleActive about it returns false, so a
    // shared list would mark an archived article as never delivered.
    assert.equal(verdictFromArtefactStatuses(['archived'], 'blog').kind, 'delivered');
    assert.equal(verdictFromArtefactStatuses(['pending_approval'], 'blog').kind, 'in_review');
    assert.match((verdictFromArtefactStatuses(['approved'], 'blog') as { summary: string }).summary, /article/);
});

check('every social status the platform can hold produces a verdict', () => {
    // A status nobody classified would fall through to 'failed' and refund an order whose work is
    // fine. This pins the reconciler to post-status.ts rather than to a list typed from memory.
    const all = [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES];
    for (const status of all) {
        const v = verdictFromArtefactStatuses([status], 'post');
        assert.ok(
            ['in_review', 'delivered', 'rejected', 'failed'].includes(v.kind),
            `${status} produced ${v.kind}`,
        );
        if (status === 'admin_test') continue;
        assert.notEqual(v.kind, 'failed', `${status} was silently treated as a failure`);
    }
});

console.log('\n──── every status it writes is one the database allows ────');

check('the statuses the reconciler sets are all in the CHECK constraint', () => {
    const written = [...reconcilerSrc.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(written.length > 0, 'no status writes found — did the file move?');
    for (const s of written) {
        assert.ok(
            (CAMPAIGN_ORDER_STATUSES as readonly string[]).includes(s)
            || ['finished', 'active', 'throttled'].includes(s),
            `'${s}' is not a campaign order status`,
        );
    }
});

check('in_review and delivered are actually reachable now', () => {
    // They were in the constraint and in the client label map since Phase 1, and unreachable.
    assert.ok(reconcilerSrc.includes("'in_review'"), 'nothing sets in_review');
    assert.ok(reconcilerSrc.includes("'delivered'"), 'nothing sets delivered');
    assert.ok((TERMINAL_ORDER_STATUSES as readonly string[]).includes('delivered'));
});

check('a campaign can now reach finished', () => {
    assert.match(reconcilerSrc, /status:\s*'finished'/, 'nothing sets campaigns.status = finished');
});

console.log('\n──── the mandate: it records, it does not decide ────');

check('it makes no model call', () => {
    for (const src of [reconcilerSrc, functionSrc]) {
        assert.ok(!/anthropic|claude-|messages\.create|generateText/i.test(src), 'a model call appeared');
    }
});

check('it never starts, resumes or re-budgets a campaign', () => {
    // active/throttled appear only in WHERE clauses selecting what to finish. A campaign moving
    // INTO a running state from here would mean an unattended process started spending the user's
    // allowance.
    assert.ok(!/status:\s*'active'/.test(reconcilerSrc), 'something sets a campaign active');
    assert.ok(!/status:\s*'paused'/.test(reconcilerSrc), 'something sets a campaign paused');
    assert.ok(!/update\(campaignBudgets\)|maxWorkItems:/.test(reconcilerSrc), 'something touches the budget');
});

check('a paused campaign is never swept to finished', () => {
    // The sweep must select only live campaigns: pausing was a human decision with a recorded
    // reason, and finishing it here would erase that.
    const sweep = reconcilerSrc.slice(landmark(reconcilerSrc, 'async function sweepExpiredCampaigns'));
    assert.ok(sweep.includes("['active', 'throttled']"), 'the sweep is not restricted to live campaigns');
    assert.ok(!sweep.includes("'paused'"), 'the sweep can reach a paused campaign');
});

check('the only work it commissions is an order a human already approved', () => {
    // issueOrder is reachable from exactly one function, and that function only ever releases an
    // order that was created, costed and approved alongside the predecessor it waited on.
    const calls = [...reconcilerSrc.matchAll(/issueOrder\(/g)];
    assert.equal(calls.length, 1, `issueOrder is called ${calls.length} times; expected exactly 1`);
    const unblock = reconcilerSrc.slice(
        landmark(reconcilerSrc, 'async function unblockChain'),
        landmark(reconcilerSrc, 'async function settleOrder'),
    );
    assert.ok(unblock.includes('issueOrder('), 'issueOrder moved out of unblockChain');
    assert.ok(unblock.includes("eq(campaignOrders.status, 'blocked')"), 'unblock is not restricted to blocked orders');
});

check('it never calls placeOrder — a new order is a new decision', () => {
    assert.ok(!/placeOrder/.test(reconcilerSrc), 'placeOrder reached the reconciler');
    assert.ok(!/placeOrder/.test(functionSrc), 'placeOrder reached the scheduled function');
});

check('a chain does not resume behind a campaign that stopped', () => {
    const unblock = reconcilerSrc.slice(
        landmark(reconcilerSrc, 'async function unblockChain'),
        landmark(reconcilerSrc, 'async function settleOrder'),
    );
    assert.ok(
        unblock.includes("campaign.status !== 'active'") && unblock.includes("campaign.status !== 'throttled'"),
        'a blocked order could be issued into a paused or finished campaign',
    );
});

console.log('\n──── the ledger stays honest ────');

check('a failed order refunds, and a rejected one does not', () => {
    const settle = reconcilerSrc.slice(landmark(reconcilerSrc, 'async function settleOrder'));
    assert.ok(/amount:\s*-order\.costWorkItems/.test(settle), 'nothing refunds work items');
    // The refund must be gated on 'failed' specifically. Refunding a rejected order would hide
    // capacity the assistants genuinely consumed.
    assert.ok(
        /verdict\.kind === 'failed' && order\.costWorkItems > 0/.test(settle),
        'the refund is not gated on the failed verdict alone',
    );
});

check('the refund is a compensating row, never an edit', () => {
    // campaign_spend_events is append-only by design (phase-4-5-outcome-capture).
    assert.ok(!/update\(campaignSpendEvents\)|delete\(campaignSpendEvents\)/.test(reconcilerSrc));
    assert.ok(reconcilerSrc.includes('recordCampaignSpend('), 'the refund does not go through the ledger helper');
});

console.log('\n──── the run is reachable on staging ────');

check('the scheduled function has a staging poke, and it is secret-guarded', () => {
    // Netlify fires scheduled functions only on the production deploy. Without this, every staging
    // order would sit at 'issued' for ever — the exact bug this feature fixes.
    const poke = read('netlify/functions/run-campaign-reconciler.ts');
    assert.ok(poke.includes('runCampaignReconciler'), 'the poke does not call the same run');
    assert.ok(poke.includes('CRON_TRIGGER_SECRET'), 'the poke is unguarded');
    assert.ok(poke.includes('statusCode: 503'), 'the poke does not fail closed without a secret');
    const workflow = read('.github/workflows/staging-crons.yml');
    assert.ok(workflow.includes('run-campaign-reconciler'), 'the staging cron does not poke it');
});

check('production has a native schedule for it', () => {
    const toml = read('netlify.toml');
    assert.ok(toml.includes('[functions.reconcile-campaigns]'), 'no prod schedule');
});

check('the tracing column the whole file depends on is declared in both places', () => {
    // The reconciler is blind without it: no link from an order to the jobs it created.
    assert.ok(read('db/schema.ts').includes('campaignOrderId: integer("campaign_order_id")'), 'not in schema.ts');
    assert.ok(read('db/campaign-order-tracing.sql').includes('ADD COLUMN IF NOT EXISTS campaign_order_id'), 'no DDL');
    const orders = stripComments(read('src/utils/campaign-orders.ts'));
    const stamps = [...orders.matchAll(/campaignOrderId:\s*orderId/g)];
    assert.equal(stamps.length, 2, `expected both content executors to stamp the order id, found ${stamps.length}`);
});

console.log(`\n${passed} checks passed.\n`);
