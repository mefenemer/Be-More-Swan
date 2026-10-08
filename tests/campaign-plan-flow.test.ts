// tests/campaign-plan-flow.test.ts
// §9.1 of docs/campaign-orchestrator-plan.md: a campaign's orders must actually flow.
//
// WHY THIS EXISTS. Prod's only campaign ran for eight days with zero orders. Every piece looked
// wired: the chat card listed briefs, `decide` knew how to place a 'strategy' decision's orders,
// placeOrder worked. But the chat handler dropped the orders, `create` ignored them, nothing ever
// inserted a 'strategy' decision, and `place_order` had no caller. Each file was correct on its
// own; the chain between them did not exist. These checks pin the chain.
//
// Also pinned, because both were found while building it:
//   • the executors read the post count from brief.quantity while the ledger priced a separate
//     quantity — a plan priced at six posts drafted one;
//   • a lead search or messaging change arriving from chat carried no brief, so it could never run.
//
// Pure functions are exercised directly; the wiring is source-scanned, matching the rest of tests/.
// Run:  npx tsx tests/campaign-plan-flow.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    MAX_PLAN_ORDERS, buildStrategyProposal, normalisePlanOrders, planOrderProblem, planProblem, planWorkItems,
} from '../src/utils/campaign-plan';
import { ORDER_ACTION_SPECS, orderWorkItems } from '../src/config/campaign-vocab';

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

/** Blank comments, keeping length — prose explaining a ban must not satisfy or trip a scan. */
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

const api = code(read('netlify/functions/campaigns.ts'));
const chat = code(read('src/components/chat-session.js'));
const card = code(read('src/components/disruptive-ui-registry.js'));
const tab = code(read('src/components/assistant-campaigns.js'));
const plan = code(read('src/utils/campaign-plan.ts'));
const orders = code(read('src/utils/campaign-orders.ts'));
const orchestrator = code(read('netlify/functions/chat-orchestrator.ts'));

console.log('\n──── normalising a plan ────');

check('unknown actions are dropped, known ones kept', () => {
    const out = normalisePlanOrders([
        { action: 'draft_social_posts', quantity: 3 },
        { action: 'buy_billboard', quantity: 1 },
        null, 'nonsense',
    ]);
    assert.deepStrictEqual(out.map((o) => o.action), ['draft_social_posts']);
});

check('quantity is capped per action at what its executor will actually write', () => {
    const [social, blog, search] = normalisePlanOrders([
        { action: 'draft_social_posts', quantity: 99 },
        { action: 'draft_blog_pillar', quantity: 9 },
        { action: 'run_lead_search', quantity: 7, idea: 'x' },
    ]);
    assert.strictEqual(social.quantity, ORDER_ACTION_SPECS.draft_social_posts.maxQuantity);
    assert.strictEqual(blog.quantity, 5,
        'The blog executor writes at most 5 articles. Pricing more would charge for articles nobody gets.');
    assert.strictEqual(search.quantity, 1, 'An action without a quantity is always one.');
});

check('every maxQuantity matches the clamp inside its executor', () => {
    // The executors clamp with Math.min(N, …). If the vocab and the executor disagree, the ledger
    // charges for work that is never queued.
    const social = span(orders, 'draft_social_posts: async', 'draft_blog_pillar: async', 'the social executor');
    const blog = span(orders, 'draft_blog_pillar: async', 'run_lead_search: async', 'the blog executor');
    assert.match(social, new RegExp(`Math\\.min\\(${ORDER_ACTION_SPECS.draft_social_posts.maxQuantity},`));
    assert.match(blog, new RegExp(`Math\\.min\\(${ORDER_ACTION_SPECS.draft_blog_pillar.maxQuantity},`));
});

check('the brief keeps only fields something reads, flat or nested', () => {
    const [o] = normalisePlanOrders([{
        action: 'draft_social_posts', angle: '  cost of churn  ', audience: 'founders',
        brief: { idea: 'nested idea' }, secret: 'dropped', quantity: 2,
    }]);
    assert.deepStrictEqual(o.brief, { angle: 'cost of churn', audience: 'founders', idea: 'nested idea' });
    assert.ok(!('quantity' in o.brief),
        'quantity must not ride in the normalised brief — placeOrder writes it from the PRICED number.');
});

check('a plan is capped at MAX_PLAN_ORDERS', () => {
    const many = Array.from({ length: 30 }, () => ({ action: 'adjust_messaging', angle: 'a' }));
    assert.strictEqual(normalisePlanOrders(many).length, MAX_PLAN_ORDERS);
});

check('orders that cannot run are named before the plan is filed', () => {
    const [search, narrow, msg, posts] = normalisePlanOrders([
        { action: 'run_lead_search' },
        { action: 'narrow_targeting', idea: 'x' },
        { action: 'adjust_messaging' },
        { action: 'draft_social_posts' },
    ]);
    assert.match(planOrderProblem(search) ?? '', /who to look for/);
    assert.match(planOrderProblem(narrow) ?? '', /which saved search/);
    assert.match(planOrderProblem(msg) ?? '', /angle/);
    assert.strictEqual(planOrderProblem(posts), null, 'Drafting work runs fine without an angle.');
    assert.ok(planProblem([posts, search]), 'planProblem must surface the first problem in the plan.');
});

check('a plan is priced the same way the ledger prices each order', () => {
    const o = normalisePlanOrders([
        { action: 'draft_social_posts', quantity: 4 },
        { action: 'draft_blog_pillar', quantity: 2 },
    ]);
    assert.strictEqual(planWorkItems(o),
        orderWorkItems('draft_social_posts', 4) + orderWorkItems('draft_blog_pillar', 2));
});

console.log('\n──── the decision a plan becomes ────');

check('a plan on a draft says it starts the campaign; on a running one, that it adds work', () => {
    const o = normalisePlanOrders([{ action: 'draft_social_posts', quantity: 2 }]);
    assert.match(buildStrategyProposal(o, 'draft').title, /^Start this campaign/);
    assert.match(buildStrategyProposal(o, 'active').title, /^Add 1 brief/);
    assert.strictEqual(buildStrategyProposal(o, 'draft').kind, 'strategy');
});

check('the decision carries the orders verbatim, quantity included', () => {
    const o = normalisePlanOrders([{ action: 'draft_social_posts', quantity: 6, angle: 'a' }]);
    const p = buildStrategyProposal(o, 'draft');
    assert.deepStrictEqual(p.orders, [{ action: 'draft_social_posts', brief: { angle: 'a' }, quantity: 6 }]);
});

check('evidence is built from the vocabulary, never from model prose', () => {
    const o = normalisePlanOrders([{ action: 'draft_blog_pillar', quantity: 1, angle: 'MODEL PROSE' }]);
    const p = buildStrategyProposal(o, 'draft');
    const text = JSON.stringify(p.evidence);
    assert.ok(!text.includes('MODEL PROSE'),
        'A decision card is a record of facts. Model-written text belongs on the chat card, not in evidence.');
    assert.ok(text.includes(ORDER_ACTION_SPECS.draft_blog_pillar.label));
});

console.log('\n──── the chain from chat card to placed order ────');

check('the chat card sends the orders it shows, and only those', () => {
    const fn = span(card, 'function renderCampaignStrategyProposalCard', '\n  register(', 'the proposal card');
    assert.match(fn, /orders: orders\.map\(\(o\) => o\.raw\)/,
        'The card must send the rendered orders. Before §9.1 it sent none, so every chat plan was lost.');
});

check('chat-session forwards the orders to create', () => {
    const fn = span(chat, 'function onCampaignCreate', '\n    }\n', 'the create handler');
    assert.match(fn, /orders:\s*Array\.isArray\(d\.orders\)/,
        'onCampaignCreate dropped the orders — that is the bug that left prod\'s first campaign idle.');
});

check('create files the orders as a PENDING plan and never places them', () => {
    const create = span(api, "action === 'create'", "action === 'edit'", 'the create action');
    assert.match(create, /fileStrategyPlan\(/, 'create must file the chat plan as a strategy decision.');
    assert.ok(!/placeOrder\(/.test(create),
        'create must never place an order — approving in chat SAVES, it never STARTS (§1.3).');
    assert.match(create, /planProblem\(/, 'create must refuse a plan whose orders cannot run.');
});

check('propose_plan files; it never places', () => {
    const fn = span(api, "action === 'propose_plan'", "action === 'list_orders'", 'propose_plan');
    assert.match(fn, /fileStrategyPlan\(/);
    assert.ok(!/placeOrder\(/.test(fn), 'propose_plan is the chat path — it may only file a plan.');
    assert.match(fn, /fitsBudget\(/, 'A plan that cannot fit the campaign budget must be refused when filed.');
    assert.match(fn, /PLANNABLE_STATUSES/, 'A paused or finished campaign must not take a new plan.');
});

check('campaign-plan.ts never places an order', () => {
    assert.ok(!/placeOrder|issueOrder/.test(plan),
        'The filing module must stay inert — placing is decide (human approval) or place_order (human click).');
});

check('a strategy approval activates the campaign BEFORE placing its orders', () => {
    // Each order recompiles its target's blueprint, and section 13 reads LIVE campaigns only.
    // Placing first compiled every brief against a draft, so the campaign steered nothing.
    const fn = span(api, "action === 'decide'", "return json(400, { error: 'Unknown action.' })", 'decide');
    const activate = fn.search(/status:\s*'active'/);
    const place = fn.indexOf('placeOrder(');
    assert.ok(activate !== -1 && place !== -1, 'decide must both activate and place.');
    assert.ok(activate < place, 'decide must set the campaign active before the first placeOrder call.');
    assert.match(fn, /readPlanTaskGate\(/, 'Approving a plan must respect the monthly cap, as start does.');
    assert.match(fn, /fitsBudget\(/, 'Approving a plan must check the whole plan against the budget first.');
});

check('placeOrder writes the priced quantity into the brief the executor reads', () => {
    const fn = span(orders, 'export async function placeOrder', 'interface IssueContext', 'placeOrder');
    assert.match(fn, /quantity: Math\.max\(1, Math\.floor\(Number\(input\.quantity\)/,
        'The executors read brief.quantity. Without this a plan priced at six posts drafted one.');
});

check('place_order (the GUI) goes through the same normaliser as the chat plan', () => {
    const fn = span(api, "action === 'place_order'", "action === 'create_link'", 'place_order');
    assert.match(fn, /normalisePlanOrders\(/);
    assert.match(fn, /planProblem\(/);
    assert.match(fn, /readPlanTaskGate\(/, 'An order placed at the monthly cap cannot be done.');
});

console.log('\n──── the chat may never touch a budget ────');

check('the chat edit handler sends viaChat and no budget field', () => {
    const fn = span(chat, 'function onCampaignEdit', '\n    }\n', 'the chat edit handler');
    assert.match(fn, /viaChat:\s*true/);
    assert.ok(!/maxWorkItems|autonomyThresholdWork|maxSpendGbp/.test(fn),
        'A chat turn may never raise a ceiling (§1.3).');
});

check('edit refuses budget fields on the chat path', () => {
    const fn = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(fn, /body\.viaChat === true && \(body\.maxWorkItems !== undefined/);
});

check('the edit card carries no budget field', () => {
    const fn = span(card, 'function renderCampaignEditProposalCard', '\n  register(', 'the edit card');
    assert.ok(!/maxWorkItems|£/.test(fn));
    assert.match(card, /register\('campaign_edit_proposal'/);
});

console.log('\n──── GUI and chat reach the same things (§9.0) ────');

check('the Campaigns tab can create, edit, add work and approve or turn down a plan', () => {
    for (const [what, needle] of [
        ['New campaign', "action: 'create'"],
        ['Edit', "action: 'edit'"],
        ['Add work', "action: 'place_order'"],
        ['Approve plan', "verdict: 'approve'"],
        ['Turn down', "verdict: 'reject'"],
    ]) {
        assert.ok(tab.includes(needle), `The Campaigns tab has no "${what}" path (${needle}).`);
    }
    assert.ok(tab.includes('Approve plan &amp; start'), 'A draft with a plan must offer "Approve plan & start".');
});

check('a draft with a waiting plan does not offer a bare Start', () => {
    const fn = span(tab, 'function campaignRow', 'function emptyState', 'the campaign row');
    assert.match(fn, /c\.status === 'draft' && !plan/,
        'Start on a draft with a plan would run the campaign with nothing commissioned.');
});

check('the chat prompt names the new buttons and reads the campaigns snapshot', () => {
    for (const label of ['"Approve plan & start"', '"Add work"', '"New campaign"', '"Edit"']) {
        assert.ok(orchestrator.includes(label), `The chat prompt never names ${label}.`);
    }
    const route = span(orchestrator, 'campaign_orchestrator: {', 'parseResponse: parseStructuredReply', 'the route');
    assert.match(route, /usesCampaignSnapshot: true/);
    assert.match(route, /rc\.campaignsSnapshot/);
    assert.match(route, /"campaignId": <number>/, 'The wire shape must let a plan name an existing campaign.');
    assert.match(route, /"type": "campaign_edit_proposal"/);
});

check('a chat write reloads the Campaigns tab', () => {
    assert.match(chat, /CustomEvent\('campaign:updated'/);
    assert.match(tab, /addEventListener\('campaign:updated'/);
});

check('a blank target is null, not 1', () => {
    const create = span(api, "action === 'create'", "action === 'edit'", 'the create action');
    assert.match(create, /isBlank\(body\.targetValue\)/,
        'Number(null) is 0, which is finite — a card with no target saved "aiming for 1".');
});

console.log(`\n${passed} checks passed.`);
