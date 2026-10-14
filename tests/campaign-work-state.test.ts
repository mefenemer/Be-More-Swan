// tests/campaign-work-state.test.ts
// Each piece of a campaign's work states what it is doing, the campaign names ONE next step, and a
// waiting item can be started without waiting. docs/campaign-orchestrator-flow.md §2, step 1.
//
// Built from prod campaign 1 (2026-10-14): approved, "6 briefs sent", then nothing visible — two
// items waited on the user and three waited on one of those, and no screen said so.
//
// Run:  npx tsx tests/campaign-work-state.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeWork, nextStep, type WorkOrderRow } from '../src/utils/campaign-work-state';

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

const row = (o: Partial<WorkOrderRow> & { id: number; action: string; status: string }): WorkOrderRow => ({
    blockedOnOrderId: null, resultSummary: null, artefactKind: null, targetAssistantId: null, brief: {}, ...o,
});

// Campaign 1 exactly as prod held it.
const campaign1 = [
    row({ id: 1, action: 'adjust_messaging', status: 'delivered', resultSummary: 'Campaign angle updated' }),
    row({ id: 2, action: 'commission_visuals', status: 'in_review', artefactKind: 'visual_brief', targetAssistantId: 18, resultSummary: 'Waiting for you to press "Make options" on the Brand Designer\'s Briefs tab' }),
    row({ id: 3, action: 'draft_blog_pillar', status: 'blocked', blockedOnOrderId: 2 }),
    row({ id: 4, action: 'draft_social_posts', status: 'blocked', blockedOnOrderId: 2 }),
    row({ id: 5, action: 'ab_test_posts', status: 'blocked', blockedOnOrderId: 2 }),
    row({ id: 6, action: 'draft_email_campaign', status: 'in_review', artefactKind: 'newsletter_sequence', targetAssistantId: 9, resultSummary: '4 emails written' }),
];

console.log('campaign work state');

check('campaign 1: every item says what it is doing', () => {
    const w = describeWork(campaign1);
    assert.deepStrictEqual(w.map((x) => x.state), ['done', 'waiting_you', 'waiting_item', 'waiting_item', 'waiting_item', 'waiting_you']);
    assert.match(w[2].text, /Waiting for item 2, commission pictures/);
    assert.strictEqual(w[1].holding, 3);
    assert.deepStrictEqual(w[1].link, { assistantId: 18, tab: 'briefs', label: 'Open the brief' });
    assert.deepStrictEqual(w[5].link?.tab, 'email-campaigns');
    assert.ok(w.slice(2, 5).every((x) => x.canStartNow), 'waiting items cannot be started now');
});

check('campaign 1: the next step is the picture, because three items wait on it', () => {
    const n = nextStep({ status: 'active' }, false, describeWork(campaign1));
    assert.strictEqual(n.kind, 'act');
    assert.strictEqual(n.orderId, 2);
    assert.match(n.text, /3 items are waiting on it/);
    assert.match(n.text, /1 more thing needs you/);
});

check('drafting progress is read from the jobs, with an honest time', () => {
    const queued = describeWork([row({ id: 1, action: 'draft_social_posts', status: 'issued', jobs: { queued: 10, processing: 0, completed: 0, failed: 0 } })]);
    assert.strictEqual(queued[0].state, 'queued');
    assert.match(queued[0].text, /within about 10 minutes/);
    const working = describeWork([row({ id: 1, action: 'draft_social_posts', status: 'issued', jobs: { queued: 6, processing: 1, completed: 3, failed: 0 } })]);
    assert.strictEqual(working[0].state, 'working');
    assert.match(working[0].text, /3 of 10 done/);
    const n = nextStep({ status: 'active' }, false, working);
    assert.strictEqual(n.kind, 'wait');
    assert.match(n.text, /Nothing needed from you/);
});

check('a waiting plan comes first, and a draft says how to begin', () => {
    assert.strictEqual(nextStep({ status: 'draft' }, true, []).kind, 'plan');
    assert.strictEqual(nextStep({ status: 'draft' }, false, []).kind, 'start');
    assert.strictEqual(nextStep({ status: 'paused' }, false, describeWork(campaign1)).kind, 'resume');
});

check('a person\'s task names the person', () => {
    const w = describeWork([row({ id: 1, action: 'request_human_task', status: 'issued', brief: { assignee: 'Legal' } })]);
    assert.strictEqual(w[0].state, 'waiting_you');
    assert.match(w[0].text, /Waiting on Legal/);
});

const recon = read('src/utils/campaign-reconciler.ts');
const fn = read('netlify/functions/campaigns.ts');
const tab = read('src/components/assistant-campaigns.js');

check('release claims the order before issuing it, so a click and the reconciler cannot both issue it', () => {
    const b = recon.slice(recon.indexOf('export async function releaseBlockedOrder('));
    const claim = b.indexOf("eq(campaignOrders.status, 'blocked')");
    const issue = b.indexOf('issueOrder(');
    assert.ok(claim > 0 && issue > claim, 'no status-guarded claim before issueOrder');
    assert.ok(recon.includes('releaseBlockedOrder(db, next)'), 'the reconciler does not use the shared release');
});

check('start_now is tenant-scoped, only for waiting items on a live campaign, and uses the shared release', () => {
    const s = fn.indexOf("if (action === 'start_now')");
    const b = fn.slice(s, fn.indexOf("if (action === '", s + 10));
    assert.ok(/eq\(campaignOrders\.organisationId, orgId\)/.test(b), 'not tenant-scoped');
    assert.ok(b.includes("o.status !== 'blocked'") && b.includes('LIVE_CAMPAIGN_STATUSES'), 'missing a guard');
    assert.ok(b.includes('releaseBlockedOrder(db, o)'), 'does not use the shared release');
    assert.ok(b.includes('atCap'), 'starts work past the monthly cap');
});

check('approving, adding work and starting now all start drafting at once', () => {
    for (const caller of ['campaigns-decide', 'campaigns-place-order', 'campaigns-start-now']) {
        assert.ok(fn.includes(`'${caller}'`), `${caller} does not poke the drafting queue`);
    }
});

check('the Campaigns tab draws the next step, the work list and Start now', () => {
    assert.ok(tab.includes('nextStepHtml(c)') && tab.includes('workBlock(c)'), 'not rendered');
    assert.ok(tab.includes("action: 'start_now'"), 'Start now does not call the server');
});

check('the chat no longer makes drafting wait for a picture by default', () => {
    const prompt = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(!prompt.includes('give the posts "after" pointing at it'), 'old instruction is back');
    assert.ok(/Do NOT make posts, articles or emails wait for the picture/.test(prompt));
});

check('the Campaign Assistant hides Goals', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    const s = reg.indexOf('campaign_orchestrator: {');
    const e = reg.indexOf('\n    },', s);
    assert.ok(reg.slice(s, e).includes('hideGoals: true'), 'Goals still shown');
    assert.ok(read('assistants.js').includes("toggle('maintab-btn-goals', !cfg.hideGoals)"), 'flag is read by nothing');
});

console.log(`\n${passed} passed`);
