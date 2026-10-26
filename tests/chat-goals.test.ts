// tests/chat-goals.test.ts
// Every assistant chat lists its goals by id and the metrics it can set one on, and proposes setting,
// changing or deleting a goal through a card the user confirms — which calls manage-goals.ts, as the
// Results tab does.
//
// WHY THIS EXISTS. The chat could read goals but told the user they were "set or changed only" on the
// Results tab. These pin that the card is checked with the endpoint's own rules, so it can never offer
// a goal the click would refuse: the role's metrics only, a connection where one is needed, a positive
// target, a future date, an attainable target (assessGoalRealism), no user-reported figure as the main
// goal, an existing goal that is this assistant's; and a reload cannot set the same goal twice.
//
// Run:  npx tsx tests/chat-goals.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildGoalsBlock, goalProposalFromUiElement, refreshGoalCards, resolveGoalProposal, resolveTeamGoalProposal } from '../src/utils/chat-goals';
import { renderMentorSnapshot } from '../src/utils/mentor-snapshot';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** Every select / selectDistinct answers with the next row list, in call order. */
function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    const q = () => {
        const rows = queue.shift() ?? [];
        const chain: any = {
            from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
        };
        return chain;
    };
    return { select: q, selectDistinct: q } as any;
}
const throwingDb = { select: () => { throw new Error('db down'); }, selectDistinct: () => { throw new Error('db down'); } } as any;

const NOW = new Date('2026-10-22T12:00:00Z');
const INSTAGRAM = [[{ serviceName: 'instagram' }], []];       // connectedServices: system_connections, then integrations
const NOTHING = [[], []];
const goalRow = (extra: Record<string, unknown> = {}) => ({
    id: 4, assistantId: 5, metricKey: 'instagram_followers', title: 'Grow Instagram', targetValue: '1200', targetDate: new Date('2026-12-31T00:00:00Z'),
    isPrimary: true, isActive: true, latestValue: '950', startValue: '900', ...extra,
});
const create = (extra: Record<string, unknown> = {}) => goalProposalFromUiElement({ type: 'goal_proposal', action: 'create', metricKey: 'instagram_followers', targetValue: 1100, targetDate: '2026-12-31', ...extra })!;

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('create needs a metric, a target and a YYYY-MM-DD date; "1,200" reads as 1200', () => {
        assert.strictEqual(goalProposalFromUiElement({ type: 'goal_proposal', action: 'create', metricKey: 'x', targetValue: '1,200', targetDate: '2027-01-01' })?.targetValue, 1200);
        assert.strictEqual(goalProposalFromUiElement({ type: 'goal_proposal', action: 'create', metricKey: 'x', targetValue: 5, targetDate: 'March' }), null);
        assert.strictEqual(goalProposalFromUiElement({ type: 'goal_proposal', action: 'update', goalId: '#4' }), null, 'an update must change something');
        assert.strictEqual(goalProposalFromUiElement({ type: 'goal_proposal', action: 'update', goalId: '#4', isPrimary: true })?.goalId, 4);
        assert.strictEqual(goalProposalFromUiElement({ type: 'goal_proposal', action: 'archive', goalId: 4 }), null);
    });

    console.log('\nChecked with manage-goals.ts\'s own rules');

    await check('a reachable goal on a connected metric is offered', async () => {
        const card = await resolveGoalProposal(fakeDb(...INSTAGRAM, []), 1, 5, 'social_media_manager', create(), NOW);
        assert.strictEqual(card?.blocked, null);
        assert.match(card?.proposed ?? '', /Instagram Followers: reach 1,100 followers by 2026-12-31/);
    });
    await check('a metric that needs a connection says which', async () => {
        const card = await resolveGoalProposal(fakeDb(...NOTHING), 1, 5, 'social_media_manager', create(), NOW);
        assert.match(card?.blocked ?? '', /Connect instagram first/);
    });
    await check('another role\'s metric is refused', async () => {
        const card = await resolveGoalProposal(fakeDb(...NOTHING), 1, 5, 'social_media_manager', create({ metricKey: 'qualified_leads' }), NOW);
        assert.match(card?.blocked ?? '', /isn’t a goal this assistant can have/);
    });
    await check('an unreachable target is refused with the figure that would work', async () => {
        const card = await resolveGoalProposal(fakeDb(...INSTAGRAM, [{ latestValue: '500' }]), 1, 5, 'social_media_manager',
            create({ targetValue: 1000000, targetDate: '2026-10-30' }), NOW);
        assert.match(card?.blocked ?? '', /Try about 40,500 followers/);
    });
    await check('a past date, and a self-reported figure as the main goal, are refused', async () => {
        const past = await resolveGoalProposal(fakeDb(...INSTAGRAM), 1, 5, 'social_media_manager', create({ targetDate: '2026-01-01' }), NOW);
        assert.match(past?.blocked ?? '', /in the future/);
        const manual = await resolveGoalProposal(fakeDb(...NOTHING), 1, 5, 'social_media_manager',
            create({ metricKey: 'manual_revenue', targetValue: 5000, isPrimary: true }), NOW);
        assert.match(manual?.blocked ?? '', /can’t be the main goal/);
    });
    await check('an update sends only what changes and re-checks realism', async () => {
        const card = await resolveGoalProposal(fakeDb([goalRow()]), 1, 5, 'social_media_manager',
            goalProposalFromUiElement({ type: 'goal_proposal', action: 'update', goalId: 4, targetValue: 1200, targetDate: '2027-01-31' })!, NOW);
        assert.strictEqual(card?.targetValue, null, 'the unchanged target is not sent');
        assert.strictEqual(card?.targetDate, '2027-01-31');
        assert.strictEqual(card?.blocked, null);
        const same = await resolveGoalProposal(fakeDb([goalRow()]), 1, 5, 'social_media_manager',
            goalProposalFromUiElement({ type: 'goal_proposal', action: 'update', goalId: 4, targetValue: 1200 })!, NOW);
        assert.match(same?.blocked ?? '', /already says exactly that/);
    });
    await check('another assistant\'s goal, or a missing one, is refused; a failed read gives no card', async () => {
        const other = await resolveGoalProposal(fakeDb([goalRow({ assistantId: 6 })]), 1, 5, 'social_media_manager', { action: 'delete', goalId: 4, metricKey: null, targetValue: null, targetDate: null, title: undefined, isPrimary: undefined }, NOW);
        assert.match(other?.blocked ?? '', /different assistant/);
        const gone = await resolveGoalProposal(fakeDb([]), 1, 5, 'social_media_manager', { action: 'delete', goalId: 4, metricKey: null, targetValue: null, targetDate: null, title: undefined, isPrimary: undefined }, NOW);
        assert.match(gone?.blocked ?? '', /no longer exists/);
        assert.strictEqual(await resolveGoalProposal(throwingDb, 1, 5, 'social_media_manager', create(), NOW), null);
    });

    console.log('\nThe list');

    await check('goals by id, the metrics on offer, and those needing a connection', async () => {
        const block = await buildGoalsBlock(fakeDb([goalRow()], ...NOTHING), 1, 5, 'social_media_manager');
        assert.match(block, /- #4 \(main goal\) Grow Instagram \[instagram_followers\]: 950 followers now, target 1,200 followers by 2026-12-31/);
        assert.match(block, /Metrics you can set a goal on now:[\s\S]*"content_published"/);
        assert.match(block, /need a connection first[\s\S]*"instagram_followers"[^\n]*needs instagram/);
        assert.match(await buildGoalsBlock(throwingDb, 1, 5, 'social_media_manager'), /could not be read this turn/);
    });

    console.log('\nA stored card closes once it is done');

    await check('create closes once that goal exists; delete once it is gone', async () => {
        const stored = { uiElement: { type: 'goal_proposal', action: 'create', metricKey: 'instagram_followers', targetValue: 1100, targetDate: '2026-12-31' } };
        const [saved] = await refreshGoalCards(fakeDb([{ id: 9, targetValue: '1100', targetDate: new Date('2026-12-31T00:00:00Z') }]), 1, 5, [stored]);
        assert.match((saved.uiElement as any).blocked, /goal #9/);
        const [open] = await refreshGoalCards(fakeDb([]), 1, 5, [stored]);
        assert.strictEqual(open, stored);
        const del = { uiElement: { type: 'goal_proposal', action: 'delete', goalId: 4 } };
        const [gone] = await refreshGoalCards(fakeDb([]), 1, 5, [del]);
        assert.strictEqual((gone.uiElement as any).settled, true);
    });

    console.log('\nWiring');

    await check('manage-goals and the card gate connections with ONE function', () => {
        assert.ok(read('netlify/functions/manage-goals.ts').includes("import { connectedServices } from '../../src/utils/goal-connections';"));
        assert.ok(!read('netlify/functions/manage-goals.ts').includes('async function connectedServices('));
    });
    await check('every role reads its goals; structured routes resolve the card; reloads re-check it', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(o.includes('const goalsBlock = await buildGoalsBlock(db, orgId, session.aiAssistantId, assistantRow.roleKey);'));
        assert.ok(o.includes('route !== defaultRoute && !settingsReq && !ruleReq ? goalProposalFromUiElement(uiElement) : null'));
        assert.ok(read('src/utils/chat-card-refresh.ts').includes('refreshGoalCards(db, organisationId, aiAssistantId, out)'));
        assert.ok(!read('src/utils/chat-assistant-settings.ts').includes('set or changed only there'));
    });
    await check('the click calls manage-goals.ts as the Results tab does, and the tab reloads', () => {
        const src = read('src/components/chat-session.js');
        const body = src.slice(src.indexOf('async function onGoalChange'), src.indexOf('async function onScheduleChange'));
        assert.ok(body.includes("call('manage-goals', 'POST', body)"));
        assert.ok(body.includes("call('manage-goals', 'PATCH', body)"));
        assert.ok(body.includes("call(`manage-goals?id=${Number(d.goalId)}`, 'DELETE')"));
        assert.ok(src.includes("container.addEventListener('goal:change', onGoalChange)"));
        assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('goal_proposal', renderGoalProposalCard)"));
        assert.ok(read('assistants.js').includes("document.addEventListener('assistant:goalsChanged'"));
    });

    console.log('\nThe Business Mentor changes another assistant\'s goal');

    // The prod chat: "Dex's newsletter goal expired on 30 September … change it to 31st December 2026".
    const dexGoal = goalRow({ assistantId: 7, targetDate: new Date('2026-09-30T00:00:00Z'), isPrimary: false });
    const owner = (extra: Record<string, unknown> = {}) => ({ id: 7, name: 'Dex', roleKey: 'social_media_manager', lifecycleStatus: 'working', provisioningStatus: null, ...extra });
    const redate = (extra: Record<string, unknown> = {}) => goalProposalFromUiElement({ type: 'goal_proposal', action: 'update', goalId: 4, targetDate: '2026-12-31', ...extra })!;

    await check('re-dates an active assistant\'s goal, checked as that assistant, naming it', async () => {
        const card = await resolveTeamGoalProposal(fakeDb([dexGoal], [owner()], [dexGoal]), 1, redate(), NOW);
        assert.ok(card && !('error' in card));
        if (!card || 'error' in card) return;
        assert.strictEqual(card.assistantId, 7, 'the click PATCHes the goal as Dex\'s, not the Mentor\'s');
        assert.strictEqual(card.assistantName, 'Dex');
        assert.strictEqual(card.targetDate, '2026-12-31');
        assert.strictEqual(card.targetValue, null, 'only what changes is sent');
        assert.strictEqual(card.blocked, null);
    });
    await check('the same rules as the Results tab: a date in the past is refused', async () => {
        const card = await resolveTeamGoalProposal(fakeDb([dexGoal], [owner()], [dexGoal]), 1, redate({ targetDate: '2026-10-01' }), NOW);
        assert.ok(card && !('error' in card));
        assert.match((card as { blocked: string }).blocked, /date has to be in the future/);
    });
    await check('never for a paused or archived assistant, a missing goal, or a new / deleted goal', async () => {
        const paused = await resolveTeamGoalProposal(fakeDb([dexGoal], [owner({ lifecycleStatus: 'paused' })]), 1, redate(), NOW);
        assert.match((paused as { error: string }).error, /Dex isn't active/);
        const archived = await resolveTeamGoalProposal(fakeDb([dexGoal], [owner({ lifecycleStatus: 'archived' })]), 1, redate(), NOW);
        assert.ok(archived && 'error' in archived);
        const gone = await resolveTeamGoalProposal(fakeDb([]), 1, redate(), NOW);
        assert.match((gone as { error: string }).error, /no longer exists/);
        const notOurs = await resolveTeamGoalProposal(fakeDb([dexGoal], []), 1, redate(), NOW);
        assert.match((notOurs as { error: string }).error, /no longer exists/, 'a goal whose assistant isn\'t in this workspace');
        for (const action of ['create', 'delete'] as const) {
            const r = await resolveTeamGoalProposal(fakeDb(), 1, { ...redate(), action }, NOW);
            assert.match((r as { error: string }).error, /assistant's own chat or on its Results tab/, action);
        }
        assert.strictEqual(await resolveTeamGoalProposal(throwingDb, 1, redate(), NOW), null);
    });
    await check('the Mentor sees goals by "#" and is told about the card; the route and card are wired', () => {
        const block = renderMentorSnapshot({
            business: { description: 'x', industry: 'x', website: 'https://x.example' }, products: [], productCount: 0, offerKinds: null, introOfferAnswered: true,
            team: [], plan: { status: 'active', freeSlots: 1 },
            goals: [{ id: 4, assistant: 'Dex', label: 'General Newsletter', latest: 0, target: 1, targetDate: new Date('2026-09-30T00:00:00Z'), status: 'off_track' }],
        });
        assert.match(block, /- #4 Dex: General Newsletter — now 0, target 1 by 2026-09-30/);
        const cards = read('src/utils/mentor-cards.ts');
        assert.ok(cards.includes('6b. ${mentorGoalPromptLine()}'));
        assert.ok(!read('src/constants/mentor-craft.ts').includes("another assistant's settings, goals or schedule"), 'the craft no longer says goals can\'t be changed');
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('if (goalReq && route === ROUTES.business_mentor) {'));
        assert.ok(orch.includes("if (card && !('error' in card)) { goalCard = card; uiElement = card; }"), 'its reply is checked like any profile card');
        // The Mentor's own card check runs first and drops any shape it doesn't own; it must let a goal
        // card through to the goal block, or every "here it is" arrives with no card (prod chat 2026-10-26).
        const mentorBranch = orch.slice(orch.indexOf('} else if (route === ROUTES.business_mentor) {'), orch.indexOf('if (goalReq && route === ROUTES.business_mentor) {'));
        assert.ok(mentorBranch.includes('} else if (!goalProposalFromUiElement(uiElement)) {'), 'the Mentor branch keeps a goal_proposal card');
        assert.ok(!mentorBranch.includes("} else {\n                uiElement = null; // never another route's card shape"), 'no unconditional drop');
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("${who ? `${esc(who)}’s ` : ''}Results tab"), 'the card names whose goal it is');
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
