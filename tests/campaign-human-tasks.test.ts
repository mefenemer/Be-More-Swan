// tests/campaign-human-tasks.test.ts
// §9.5 of docs/campaign-orchestrator-plan.md: a campaign can wait on a PERSON.
//
// WHY THIS EXISTS. "AI can't do everything. We have an in-house designer, an SEO agency and
// Legal who need to review claims." A campaign can now hold a task for a person, make other work
// wait for it, and release that work when the user marks it done. Three properties matter more
// than the rest, and each was one wrong line away:
//   1. NOTHING IS SENT TO THE PERSON. The brief may carry an email so the user knows who to tell;
//      a plan the model drafted must never become a message from this business to anyone.
//   2. A waiting person's task is RELEASED, not cancelled. The release path assumed every order
//      had an assistant and cancelled any that did not — every human task behind earlier work.
//   3. "Wait for" means wait. If the thing waited on could not be placed, the dependent is skipped,
//      never run early — running the posts before Legal is exactly what the wait exists to stop.
//
// Run:  npx tsx tests/campaign-human-tasks.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategyProposal, normalisePlanOrders, planOrderProblem, planWorkItems } from '../src/utils/campaign-plan';
import { HUMAN_ROLE_KEY, ORDER_ACTION_SPECS } from '../src/config/campaign-vocab';
import { humanTaskSummary } from '../src/utils/campaign-orders';

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
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone.`);
    return text.slice(a, b);
}

const orders = code(read('src/utils/campaign-orders.ts'));
const reconciler = code(read('src/utils/campaign-reconciler.ts'));
const api = code(read('netlify/functions/campaigns.ts'));

console.log('\n──── nothing is sent to the person ────');

check('placing and issuing a person\'s task touches no mail, message or ledger code', () => {
    const place = span(orders, 'async function placeHumanTask', '\ninterface IssueContext', 'the human task path');
    assert.ok(!/send|Gmail|Resend|notify|createNotification|fetch\(|recordCampaignSpend/i.test(place),
        'A person\'s task must be a row on the campaign, nothing more — no message to them, no task charge.');
    assert.match(place, /costWorkItems: 0/);
});

check('a person\'s task uses none of the monthly allowance', () => {
    assert.strictEqual(ORDER_ACTION_SPECS.request_human_task.workItemsPerUnit, 0);
    const [t] = normalisePlanOrders([{ action: 'request_human_task', assignee: 'Legal', task: 'Check claims' }]);
    assert.strictEqual(planWorkItems([t]), 0);
});

check('the chat, the card and the row all say the user tells them', () => {
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /you do NOT contact that person, and you must say the user tells them/);
    assert.match(code(read('src/components/disruptive-ui-registry.js')), /you tell them; nothing is sent/);
    assert.match(code(read('src/components/assistant-campaigns.js')), /nothing is sent automatically/);
});

console.log('\n──── the brief ────');

check('who, what, a real due date and a valid email survive; junk does not', () => {
    const [t] = normalisePlanOrders([{
        action: 'request_human_task', assignee: 'Sam (designer)', task: 'Record the launch video',
        dueDate: '2026-10-20', assigneeEmail: 'Sam@Example.com',
    }]);
    assert.deepStrictEqual(t.brief, {
        assignee: 'Sam (designer)', task: 'Record the launch video', dueDate: '2026-10-20', assigneeEmail: 'sam@example.com',
    });
    const [bad] = normalisePlanOrders([{ action: 'request_human_task', assignee: 'Sam', task: 'x', dueDate: 'by Friday', assigneeEmail: 'not an email' }]);
    assert.ok(!('dueDate' in bad.brief), '"by Friday" is not a date the row can show as overdue.');
    assert.ok(!('assigneeEmail' in bad.brief));
});

check('a task with no person or no task is refused before it is filed', () => {
    const [noWho] = normalisePlanOrders([{ action: 'request_human_task', task: 'Check claims' }]);
    const [noWhat] = normalisePlanOrders([{ action: 'request_human_task', assignee: 'Legal' }]);
    assert.match(planOrderProblem(noWho) ?? '', /who to ask/);
    assert.match(planOrderProblem(noWhat) ?? '', /who to ask/);
});

check('"after" only ever points backwards', () => {
    const plan = normalisePlanOrders([
        { action: 'request_human_task', assignee: 'Legal', task: 'Check claims', after: 1 },   // itself
        { action: 'draft_social_posts', quantity: 3, after: 1 },                              // ok
        { action: 'draft_blog_pillar', after: 5 },                                            // forward
    ]);
    assert.strictEqual(plan[0].after, undefined, 'An item cannot wait for itself.');
    assert.strictEqual(plan[1].after, 1);
    assert.strictEqual(plan[2].after, undefined, 'An item cannot wait for one later in the plan — that is how a cycle starts.');
});

check('"after" survives an invented item earlier in the plan — positions are translated', () => {
    // Found in the browser: the card and server both DROP an action they do not know, and "after"
    // counts the model's raw list. Without translation, every later "after" slid onto the wrong item.
    const plan = normalisePlanOrders([
        { action: 'buy_billboard' },                                                   // raw 1 — dropped
        { action: 'request_human_task', assignee: 'Legal', task: 'Approve claims' },   // raw 2
        { action: 'draft_social_posts', quantity: 2, after: 2 },                       // waits for Legal
    ]);
    assert.strictEqual(plan.length, 2);
    assert.strictEqual(plan[1].after, 1, 'raw item 2 is the 1st kept item — "after" must point at Legal, not slide.');
});

check('an item waiting on something that was dropped is skipped, never run early', () => {
    const plan = normalisePlanOrders([
        { action: 'buy_billboard' },                                  // raw 1 — dropped
        { action: 'draft_social_posts', quantity: 2, after: 1 },      // waited for the dropped one
        { action: 'draft_blog_pillar', after: 2 },                    // waited for THAT one
    ]);
    assert.strictEqual(plan.length, 0,
        'A dependent whose precondition can never be met must not be placed without its wait — and neither must ITS dependents.');
});

check('both surfaces name what an item waits for, never a bare number', () => {
    const card = code(read('src/components/disruptive-ui-registry.js'));
    assert.match(card, /Waits until: \$\{actionSpec\(prereq\.action\)\.label\}/);
    assert.match(card, /will be skipped/);
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /waits until: \$\{esc\(plan\.orders\[o\.after - 1\]\.label\)\}/);
});

check('the decision carries "after", and its evidence names no person', () => {
    const plan = normalisePlanOrders([
        { action: 'request_human_task', assignee: 'Jo Bloggs', task: 'Approve the claims' },
        { action: 'draft_social_posts', quantity: 2, after: 1 },
    ]);
    const p = buildStrategyProposal(plan, 'active');
    assert.strictEqual(p.orders[1].after, 1);
    assert.ok(!JSON.stringify(p.evidence).includes('Jo Bloggs'),
        'Evidence is built from the vocabulary; names and tasks are shown on the row, not stated as fact on a decision card.');
    assert.match(JSON.stringify(p.evidence), /waits for item 1/);
});

check('the row\'s sentence names who and when', () => {
    assert.strictEqual(humanTaskSummary({ assignee: 'Legal', dueDate: '2026-10-20' }), 'Waiting on Legal — due 2026-10-20');
    assert.strictEqual(humanTaskSummary({}), 'Waiting on someone on your team');
});

console.log('\n──── waiting, and being released ────');

check('a waiting person\'s task is RELEASED, before the no-assistant cancellation', () => {
    const fn = span(reconciler, 'async function unblockChain', 'async function settleOrder', 'unblockChain');
    const human = fn.indexOf("next.action === 'request_human_task'");
    const noAssistant = fn.indexOf('if (!next.targetAssistantId)');
    assert.ok(human !== -1 && noAssistant !== -1 && human < noAssistant,
        'The human branch must run first — otherwise every task a person was asked to do after earlier work is cancelled as "assistant no longer in the workspace".');
    assert.match(fn, /issueHumanTask\(db, next\.id/);
});

check('approval wires "after" to the real order, and never runs a dependent early', () => {
    const decide = span(api, "action === 'decide'", "return json(400, { error: 'Unknown action.' })", 'decide');
    assert.match(decide, /blockedOnOrderId = placedByPosition\[after - 1\]/);
    assert.match(decide, /if \(!blockedOnOrderId\) \{[\s\S]{0,400}continue;/,
        'If the item waited on could not be placed, the dependent must be SKIPPED — placing it unblocked would run it early.');
});

check('Add work can only wait on an open order of the same campaign and organisation', () => {
    const fn = span(api, "action === 'place_order'", "action === 'create_link'", 'place_order');
    assert.match(fn, /eq\(campaignOrders\.campaignId, campaign\.id\)/);
    assert.match(fn, /eq\(campaignOrders\.organisationId, orgId\)/);
    assert.match(fn, /inArray\(campaignOrders\.status, \['queued', 'issued', 'in_review', 'blocked'\]\)/,
        'Waiting on a settled order would wait for ever.');
});

check('marking done delivers (releasing work); won\'t happen rejects (cancelling it)', () => {
    const fn = span(api, "action === 'complete_task'", "action === 'list_orders'", 'complete_task');
    assert.match(fn, /order\.action !== 'request_human_task'/, 'Only a person\'s task can be marked done by hand.');
    assert.match(fn, /order\.status === 'blocked'/, 'A task still waiting for earlier work cannot be done yet.');
    assert.match(fn, /kind: 'delivered'/);
    assert.match(fn, /kind: 'rejected'/);
    assert.match(fn, /settleOrderNow\(db, order\.id/);
    const settle = span(reconciler, 'async function settleOrder(', '\n}\n', 'settleOrder');
    assert.match(settle, /if \(status === 'delivered'\) result\.unblocked \+= await unblockChain/,
        'Delivering is what releases the waiting work — settleOrderNow must go through settleOrder.');
});

console.log('\n──── both surfaces ────');

check('every workspace can ask a person — no hire needed', () => {
    const list = span(api, "action === 'list'", "action === 'create'", 'list');
    assert.match(list, /ORDER_ACTION_SPECS\[a\]\.roleKey === HUMAN_ROLE_KEY \|\| hired\.has/);
    assert.match(list, /humanTasks/);
    assert.strictEqual(ORDER_ACTION_SPECS.request_human_task.roleKey, HUMAN_ROLE_KEY);
});

check('the Campaigns tab shows tasks with Mark done / Won\'t happen, and Add work can hold until one', () => {
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /function humanTasksBlock/);
    assert.match(tab, /data-cmp-task-done/);
    assert.match(tab, /data-cmp-task-wont/);
    assert.match(tab, /function waitForField/);
    assert.match(tab, /waitFor: waitFor \|\| undefined/);
    assert.match(tab, /Overdue — was due/);
});

check('the chat can propose marking a task done, through the same action', () => {
    const card = code(read('src/components/disruptive-ui-registry.js'));
    assert.match(card, /register\('campaign_task_update'/);
    const chat = code(read('src/components/chat-session.js'));
    const fn = span(chat, 'function onCampaignTaskUpdate', '\n    }\n', 'the task update handler');
    assert.match(fn, /action: 'complete_task'/);
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /"type": "campaign_task_update"/);
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /Open tasks for people/, 'The chat can only name a task it has been shown, with its orderId.');
});

console.log(`\n${passed} checks passed.`);
