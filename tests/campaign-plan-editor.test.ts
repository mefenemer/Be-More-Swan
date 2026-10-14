// tests/campaign-plan-editor.test.ts
// A waiting campaign plan can be edited before it is approved (2026-10-13).
//
// Before: a plan was approved whole or turned down whole. The chat could only re-plan from memory —
// its snapshot said "a plan of 6 briefs is waiting" and nothing more — and since a new plan
// SUPERSEDES the waiting one, any item it forgot was silently dropped.
//
// Now: "Edit plan" on the Campaigns tab (and "Edit this plan" on the Decisions card) edits each
// brief, quantity and wait, or removes items; `revise_plan` files the result as a NEW pending plan
// that replaces the old one. Nothing is placed, nothing is spent — approval is still separate.
//
// Run:  npx tsx tests/campaign-plan-editor.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategyProposal, normalisePlanOrders } from '../src/utils/campaign-plan';

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
const plan = read('src/utils/campaign-plan.ts');
const fn = read('netlify/functions/campaigns.ts');
const prompt = read('netlify/functions/chat-orchestrator.ts');
const tab = read('src/components/assistant-campaigns.js');
const queue = read('assistants.js');

/** The source of one `if (action === '<name>')` branch, up to the next action. */
function actionBody(name: string): string {
    const start = fn.indexOf(`if (action === '${name}')`);
    assert.ok(start >= 0, `no ${name} action`);
    const next = fn.indexOf("if (action === '", start + 10);
    return fn.slice(start, next < 0 ? undefined : next);
}

console.log('campaign plan editor');

const orders = normalisePlanOrders([{ action: 'draft_social_posts', quantity: 3, angle: 'x' }]);

check('a plan says honestly where it came from', () => {
    const where = (src?: 'chat' | 'edited') =>
        (buildStrategyProposal(orders, 'active', src).evidence as Array<{ label: string; value: string }>)
            .find((e) => e.label === 'Where this came from')?.value;
    assert.match(where() ?? '', /conversation/);
    assert.match(where('edited') ?? '', /Edited by you/);
});

check('the waiting plan carries each whole brief', () => {
    assert.ok(/brief: o\.brief,/.test(plan), 'pendingPlanFor does not return the brief');
});

check('the chat snapshot lists the waiting plan item by item', () => {
    assert.ok(plan.includes('waitingPlanLines(plan.orders)'), 'snapshot still only counts the briefs');
    assert.ok(!/a plan of \$\{plan\.orders\.length\} briefs is waiting/.test(plan), 'old count-only line is back');
});

check('the chat is told a proposal REPLACES a waiting plan, and to repeat what it keeps', () => {
    assert.ok(/REPLACES the waiting plan/.test(prompt) && /every item the user is keeping/.test(prompt));
    assert.ok(prompt.includes('"Edit plan"'), 'prompt does not name the GUI control');
});

check('revise_plan files a superseding plan marked as edited, and places nothing', () => {
    const b = actionBody('revise_plan');
    assert.ok(b.includes("fileStrategyPlan(") && b.includes("'edited'"), 'not filed as an edited plan');
    for (const bad of ['placeOrder', "verdict: 'approve'", 'update(campaigns)']) assert.ok(!b.includes(bad), `revise_plan contains ${bad}`);
});

check('revise_plan refuses a plan that has moved on, and an empty plan', () => {
    const b = actionBody('revise_plan');
    assert.ok(/d\.status !== 'pending'/.test(b) && b.includes('json(409'), 'no stale-plan 409');
    assert.ok(/d\.kind !== 'strategy'/.test(b), 'could revise a non-plan decision');
    assert.ok(/eq\(campaignDecisions\.organisationId, orgId\)/.test(b), 'decision lookup not tenant-scoped');
    assert.ok(/!orders\.length/.test(b) && /Turn down/.test(b), 'an empty plan is not refused');
});

check('revise_plan validates and budgets like propose_plan', () => {
    const b = actionBody('revise_plan');
    for (const k of ['normalisePlanOrders(', 'planProblem(', 'fitsBudget(', 'PLANNABLE_STATUSES']) assert.ok(b.includes(k), `missing ${k}`);
});

check('the Campaigns tab offers Edit plan and saves through revise_plan', () => {
    assert.ok(tab.includes('data-cmp-plan-edit='), 'no Edit plan button');
    assert.ok(tab.includes("action: 'revise_plan'"), 'editor does not save through revise_plan');
    assert.ok(tab.includes('data-cmp-pe-remove='), 'no Remove per item');
});

check('removing an item re-numbers the waits, and asks first when something waits on it', () => {
    const start = tab.indexOf('if (remove) {');
    const b = tab.slice(start, tab.indexOf('if (save) {', start));
    assert.ok(/o\.after === n\) o\.after = null/.test(b) && /o\.after > n\) o\.after -= 1/.test(b), 'waits not re-numbered');
    assert.ok(b.includes('await window.confirmModal('), 'removes a prerequisite silently');
    assert.ok(b.includes('ed.gen += 1'), 'kept field values could land on the wrong item after a removal');
});

check('the Decisions card links to the editor for a waiting plan', () => {
    assert.ok(queue.includes('_rqEditCampaignPlan(') && queue.includes('AssistantCampaigns.editPlan('), 'no Edit this plan link');
    assert.ok(tab.includes('async editPlan(decisionId)'), 'AssistantCampaigns.editPlan missing');
});

console.log(`\n${passed} passed`);
