// tests/campaign-proposer.test.ts
// The Campaign Assistant's autonomous run: what it proposes, and what it must never do.
//
// Two halves, because two different things can break.
//
//   1. THE BUILDERS ARE PURE, so they are unit-tested directly. Every order a proposal emits has to
//      be an action the executor actually has, aimed at a role the security boundary allows, with
//      the brief fields that action needs. A proposal naming `write_pillar_article` (the exact typo
//      the chat prompt shipped with) would be approved by a user and then acted on by nobody.
//
//   2. THE AGENT MUST STAY INERT, which types cannot express, so it is source-scanned. The whole
//      safety argument of this phase is that a decision changes nothing until a human approves it
//      and that approval is the ONLY path to placeOrder. An import of placeOrder into the agent
//      would compile, pass every other test, and quietly turn a proposer into an actor.
//
// No database: pure functions plus source-consistency checks, matching every other file in tests/
// except rls-enforcement.
// Run:  npx tsx tests/campaign-proposer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LEAD_QUALITY_FLOOR, MIN_LEADS_FOR_QUALITY, MIN_POSTS_FOR_AVERAGE, OUTPERFORM_MULTIPLE,
    SCENARIO_REQUIREMENTS, buildEscalationProposal, buildHaltProposal, proposalWorkItems,
} from '../src/utils/campaign-proposer';
import {
    CAMPAIGN_ORDER_ACTIONS, DECISION_TTL_DAYS, ORDER_ACTION_SPECS, orderWorkItems,
} from '../src/config/campaign-vocab';
import { ORCHESTRATABLE_ROLE_KEYS } from '../src/constants/roles';

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

const OUTPERFORMER = { postId: 42, interactions: 300, average: 100, multiple: 3, caption: 'A post that did well' };
const COLD_SEARCH = { discoveryCampaignId: 7, searchName: 'UK builders', total: 20, cold: 15, coldShare: 0.75 };

console.log('\n──── every proposed order is one the executor can carry out ────');

const PROPOSALS = [
    { name: 'escalation', p: buildEscalationProposal(OUTPERFORMER) },
    { name: 'halt', p: buildHaltProposal(COLD_SEARCH) },
];

check('every action exists in CAMPAIGN_ORDER_ACTIONS', () => {
    const known = new Set<string>(CAMPAIGN_ORDER_ACTIONS);
    for (const { name, p } of PROPOSALS) {
        for (const o of p.orders) {
            assert.ok(known.has(o.action),
                `The ${name} proposal emits "${o.action}", which the executor does not have. `
                + `Valid: ${[...known].join(', ')}. A user approves it and nothing ever happens.`);
        }
    }
});

check('every action is aimed at an orchestratable role', () => {
    const allowed = new Set(ORCHESTRATABLE_ROLE_KEYS);
    for (const { name, p } of PROPOSALS) {
        for (const o of p.orders) {
            const spec = ORDER_ACTION_SPECS[o.action as keyof typeof ORDER_ACTION_SPECS];
            assert.ok(allowed.has(spec.roleKey),
                `The ${name} proposal's "${o.action}" routes to "${spec.roleKey}", which is not in `
                + 'ORCHESTRATABLE_ROLE_KEYS. That set is a security boundary, not a convenience list.');
        }
    }
});

check('each scenario requires the assistants its own orders are aimed at', () => {
    // The gate has to match the orders, or the run proposes work for an assistant the org never
    // hired — placeOrder refuses it at approval time, so the user agrees to something that then
    // partly fails. The card should never have offered it.
    for (const { name, p } of PROPOSALS) {
        const needed = new Set(p.orders.map((o) => ORDER_ACTION_SPECS[o.action as keyof typeof ORDER_ACTION_SPECS].roleKey));
        const required = new Set<string>(SCENARIO_REQUIREMENTS[name as keyof typeof SCENARIO_REQUIREMENTS]);
        for (const r of needed) {
            assert.ok(required.has(r),
                `The ${name} scenario sends an order to "${r}" but does not require it hired. `
                + 'Add it to SCENARIO_REQUIREMENTS.');
        }
    }
});

check('narrow_targeting carries the saved-search id its executor demands', () => {
    // campaign-orders.ts refuses with "No saved search was named" when discoveryCampaignId is not
    // an integer — an approved halt would report a failure the user could do nothing about.
    const order = buildHaltProposal(COLD_SEARCH).orders.find((o) => o.action === 'narrow_targeting');
    assert.ok(order, 'The halt proposal must include narrow_targeting.');
    assert.strictEqual(order!.brief.discoveryCampaignId, COLD_SEARCH.discoveryCampaignId,
        'narrow_targeting must carry the discovery campaign id it is meant to tighten.');
});

check('adjust_messaging carries an angle, or it changes nothing at all', () => {
    // adjust_messaging creates no artefact: its ONLY effect is that its brief.angle is picked up by
    // blueprint.ts into section 13-campaign. Without an angle the order reports "Campaign angle
    // updated" having updated nothing, which is a claim about a change that did not happen.
    const order = buildHaltProposal(COLD_SEARCH).orders.find((o) => o.action === 'adjust_messaging');
    assert.ok(order, 'The halt proposal must include adjust_messaging.');
    assert.strictEqual(typeof order!.brief.angle, 'string');
    assert.ok((order!.brief.angle as string).trim().length > 20,
        'The angle must be a real instruction — it is the entire payload of this order.');
});

check('the blog seam can actually pick that angle up', () => {
    // blueprint.ts joins ONE order per live campaign. Ordering by campaign alone made the winner
    // arbitrary, so a fresh adjust_messaging could lose to an older draft_social_posts whose brief
    // has no angle — leaving the one order whose purpose is changing the message unable to.
    const blueprint = stripComments(read('src/utils/blueprint.ts'));
    assert.match(blueprint, /->>\s*'angle'\)\s*IS NOT NULL\)\s*DESC/,
        'blueprint.ts must prefer the most recent order that CARRIES an angle when choosing which '
        + "campaign order's brief steers generation.");
});

check('work items are priced from the shared meter, not invented', () => {
    for (const { p } of PROPOSALS) {
        const expected = p.orders.reduce((n, o) => n + orderWorkItems(o.action, o.quantity), 0);
        assert.strictEqual(proposalWorkItems(p), expected);
    }
    // The steering-only halt costs nothing to run: neither of its orders creates an artefact.
    assert.strictEqual(proposalWorkItems(buildHaltProposal(COLD_SEARCH)), 0,
        'A halt changes targeting and messaging; it commissions no new work, so it costs no tasks.');
    assert.ok(proposalWorkItems(buildEscalationProposal(OUTPERFORMER)) > 0,
        'An escalation commissions real drafting and must say what that costs.');
});

console.log('\n──── the evidence is checkable, and the card is answerable ────');

check('every proposal states what happens if the user does nothing', () => {
    for (const { name, p } of PROPOSALS) {
        assert.ok(p.costOfInaction && p.costOfInaction.trim().length > 30,
            `The ${name} proposal has no costOfInaction. A card without one is a demand, not a choice.`);
    }
});

check('evidence carries the numbers behind the claim', () => {
    const esc = buildEscalationProposal(OUTPERFORMER);
    const labels = esc.evidence.map((e) => e.label.toLowerCase()).join(' | ');
    assert.match(labels, /average/, 'An escalation must show what it is comparing against.');
    assert.ok(esc.evidence.some((e) => e.value.includes('3.0x')),
        'The multiple must appear as a number the user can check, not as an adjective.');

    const halt = buildHaltProposal(COLD_SEARCH);
    assert.ok(halt.evidence.some((e) => e.value.includes('75%')),
        'A halt must state the share that triggered it.');
    assert.ok(halt.evidence.some((e) => e.value.includes('40%')),
        'It must also state the threshold, so the user can see whether they agree with it.');
});

check('a caption is trimmed before it reaches the card', () => {
    const long = buildEscalationProposal({ ...OUTPERFORMER, caption: 'x'.repeat(500) });
    const post = long.evidence.find((e) => e.label === 'The post');
    assert.ok(post && post.value.length <= 120,
        'Post captions are user/AI-authored text going into a jsonb column and onto a card. Cap them.');
});

check('a missing caption drops the row rather than showing an empty one', () => {
    const none = buildEscalationProposal({ ...OUTPERFORMER, caption: null });
    assert.ok(!none.evidence.some((e) => e.label === 'The post'),
        'An evidence row with an empty value reads as missing data rather than absent context.');
});

check('both kinds have a TTL, and a halt expires fastest', () => {
    for (const { p } of PROPOSALS) {
        assert.ok(DECISION_TTL_DAYS[p.kind] > 0, `${p.kind} has no expiry.`);
    }
    assert.ok(DECISION_TTL_DAYS.halt <= DECISION_TTL_DAYS.escalation,
        '"Stop, this is not working" is a statement about right now — it must not outlive an escalation.');
});

console.log('\n──── thresholds refuse to speak from noise ────');

check('the sample floors are high enough to mean something', () => {
    assert.ok(MIN_POSTS_FOR_AVERAGE >= 5,
        'With a handful of posts the best one is ~2x the mean by construction, so the trigger would '
        + 'fire on noise for every new account — exactly when a user has least reason to trust it.');
    assert.ok(MIN_LEADS_FOR_QUALITY >= 5,
        'A percentage over three leads is an accident of a small run, not a signal.');
    assert.ok(OUTPERFORM_MULTIPLE > 1, 'A multiple of 1 would fire on any above-average post.');
    assert.ok(LEAD_QUALITY_FLOOR > 0 && LEAD_QUALITY_FLOOR < 1, 'The floor is a share, not a count.');
});

console.log('\n──── the agent proposes; it never acts ────');

const agent = stripComments(read('netlify/functions/autonomous-campaign-agent.ts'));
const proposer = stripComments(read('src/utils/campaign-proposer.ts'));

check('nothing in the autonomous path places an order', () => {
    for (const [name, src] of [['the agent', agent], ['the proposer', proposer]] as const) {
        assert.ok(!/placeOrder/.test(src),
            `${name} references placeOrder. A pending decision must be INERT — orders are placed `
            + 'ONLY by campaigns.ts `decide`, and only after a human approves. This is the whole '
            + 'safety argument of the phase.');
    }
});

check('the autonomous path never starts, resumes or re-budgets a campaign', () => {
    for (const [name, src] of [['the agent', agent], ['the proposer', proposer]] as const) {
        assert.ok(!/update\(campaigns\)/.test(src),
            `${name} updates the campaigns table. It may not start a campaign, resume a paused one, `
            + 'or move a ceiling — those are human clicks with the number visible.');
    }
});

check('it only ever files decisions as pending', () => {
    assert.match(proposer, /status:\s*'pending'/,
        'A proposal must be filed pending. Anything else is the agent deciding for the user.');
    assert.ok(!/status:\s*'approved'/.test(proposer),
        'The proposer must never write an approved decision.');
});

check('it considers only live campaigns', () => {
    assert.match(proposer, /inArray\(campaigns\.status,\s*\['active',\s*'throttled'\]\)/,
        'A draft campaign has commissioned nothing and a paused one was stopped on purpose. '
        + 'Proposing new work for either is the agent overriding a human decision.');
});

check('it makes no model call', () => {
    for (const [name, src] of [['the agent', agent], ['the proposer', proposer]] as const) {
        assert.ok(!/gatewayGenerate|ai-gateway|parseModelJson/.test(src),
            `${name} calls a model. Both triggers are thresholds and both order sets are fixed `
            + 'templates — a model here adds a way to be wrong without adding a way to be right, '
            + 'and would put un-computed numbers into evidence the UI presents as measured.');
    }
});

check('the same decision is not filed twice', () => {
    assert.match(proposer, /export async function hasPendingDecision/,
        'A 7-day window re-detects the same breakout post every run. Without a dedupe the queue '
        + 'fills with identical cards and the user stops reading it.');
    assert.match(proposer, /if \(await hasPendingDecision\([^)]*\)\) return null/,
        'persistProposal must refuse a duplicate itself, not rely on every caller checking first.');
    assert.match(agent, /!await hasPendingDecision/,
        'The agent should also check BEFORE running the detection aggregate — there is no point '
        + 'paying for the query to throw the answer away.');
});

check('expiry settles the Review Queue mirror too', () => {
    const fn = read('src/utils/campaign-proposer.ts');
    const body = fn.slice(fn.indexOf('export async function expirePendingDecisions'));
    assert.match(body, /assistantRecords/,
        'Expiring a decision without settling its mirror leaves a card in the Review Queue for ever, '
        + 'still counting towards the badge and still offering an Approve that campaigns.ts refuses.');
});

check('the expiry sweep cannot be skipped by the proposal half', () => {
    const order = agent.indexOf('expirePendingDecisions');
    const loop = agent.indexOf('for (const campaign of live)');
    assert.ok(order !== -1 && order < loop,
        'Expiry must run first and unconditionally — it is the half that keeps the queue honest.');
});

console.log('\n──── the run is reachable on staging ────');

check('the scheduled function has a staging poke, and it is secret-guarded', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /\[functions\.autonomous-campaign-agent\]/,
        'The agent needs a schedule, or it never fires on production either.');

    const wrapper = read('netlify/functions/run-campaign-agent.ts');
    assert.match(wrapper, /CRON_TRIGGER_SECRET/, 'The staging trigger must be secret-guarded.');
    assert.match(wrapper, /statusCode: 503/,
        'It must FAIL CLOSED when the secret is unset, never run as an open endpoint.');
    assert.match(wrapper, /runCampaignProposer/,
        'The wrapper must call the SAME run logic the schedule does, or staging and production drift.');

    // Every staging cron lives in ONE workflow (issue #258) — ten separate schedules were being
    // throttled to ~4% delivery by GitHub, and produced ten failure emails per upstream outage.
    const workflow = read('.github/workflows/staging-crons.yml');
    assert.match(workflow, /run-campaign-agent/,
        'Netlify fires scheduled functions only on the production deploy — staging needs the poke.');
});

console.log(`\n${passed} checks passed.`);
