// tests/chat-rules.test.ts
// Every assistant chat lists its own Do's and don'ts by id and can propose adding, rewording,
// switching off/on or deleting one — through a card the user confirms, which calls content-rules.ts,
// the endpoint the Do's and don'ts card uses.
//
// WHY THIS EXISTS. The chat followed the rules but was told never to mention them, and could not save
// one: "from now on never use exclamation marks" lasted one reply. And the Email Marketing chat did
// not read them at all. These pin: proposals are checked against content_rules and rebuilt from the
// row; a workspace-wide rule, another assistant's rule, or a no-op change is refused on the card; a
// stored add card closes once the rule exists, so a reload cannot save it twice; and the click goes
// through content-rules.ts with the page's methods.
//
// Run:  npx tsx tests/chat-rules.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    RULE_TEXT_MAX, buildRulesListBlock, refreshRuleCards, resolveRuleProposal, ruleProposalFromUiElement, rulesPromptBlock,
} from '../src/utils/chat-rules';
import { RULE_READING_ROLES, formatRulesBlock } from '../src/utils/assistant-rules-prompt';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows) };
            return chain;
        },
    } as any;
}
const throwingDb = { select: () => { throw new Error('db down'); } } as any;
const rule = (extra: Record<string, unknown> = {}) => ({ id: 9, ruleText: 'Never use exclamation marks', isActive: true, platform: null, assistantId: 5, ...extra });

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('add needs text; "#9" is read as 9; a platform only from the list', () => {
        assert.deepStrictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'add', ruleText: '  No   emoji ', platform: 'linkedin' }),
            { action: 'add', ruleId: null, ruleText: 'No emoji', platform: 'linkedin' });
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'add', ruleText: 'x', platform: 'myspace' })?.platform, null);
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'add' }), null);
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'turn_off', ruleId: '#9' })?.ruleId, 9);
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'edit', ruleId: 9 }), null);
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'archive', ruleId: 9 }), null);
    });

    console.log('\nThe card is built from the row, not the model');

    await check('switching off one of its own rules shows the rule as it is', async () => {
        const card = await resolveRuleProposal(fakeDb([rule()]), 1, 5, 'blog_writer', { action: 'turn_off', ruleId: 9, ruleText: null, platform: null });
        assert.strictEqual(card?.currentText, 'Never use exclamation marks');
        assert.strictEqual(card?.blocked, null);
    });
    await check('a workspace-wide rule, another assistant\'s, or a missing one is refused', async () => {
        const shared = await resolveRuleProposal(fakeDb([rule({ assistantId: null })]), 1, 5, 'blog_writer', { action: 'delete', ruleId: 9, ruleText: null, platform: null });
        assert.match(shared?.blocked ?? '', /workspace-wide/);
        const other = await resolveRuleProposal(fakeDb([rule({ assistantId: 6 })]), 1, 5, 'blog_writer', { action: 'delete', ruleId: 9, ruleText: null, platform: null });
        assert.match(other?.blocked ?? '', /different assistant/);
        const gone = await resolveRuleProposal(fakeDb([]), 1, 5, 'blog_writer', { action: 'delete', ruleId: 9, ruleText: null, platform: null });
        assert.match(gone?.blocked ?? '', /no longer exists/);
    });
    await check('a no-op change and an over-long rule are refused', async () => {
        const off = await resolveRuleProposal(fakeDb([rule({ isActive: false })]), 1, 5, 'blog_writer', { action: 'turn_off', ruleId: 9, ruleText: null, platform: null });
        assert.match(off?.blocked ?? '', /already switched off/);
        const long = await resolveRuleProposal(fakeDb(), 1, 5, 'blog_writer', { action: 'add', ruleId: null, ruleText: 'x'.repeat(RULE_TEXT_MAX + 1), platform: null });
        assert.match(long?.blocked ?? '', /at most 300/);
    });
    await check('a platform is kept only for the Social Media Assistant', async () => {
        const smm = await resolveRuleProposal(fakeDb(), 1, 5, 'social_media_manager', { action: 'add', ruleId: null, ruleText: 'No hashtags', platform: 'linkedin' });
        assert.strictEqual(smm?.platformLabel, 'LinkedIn');
        const blog = await resolveRuleProposal(fakeDb(), 1, 5, 'blog_writer', { action: 'add', ruleId: null, ruleText: 'No hashtags', platform: 'linkedin' });
        assert.strictEqual(blog?.platform, null);
    });
    await check('a failed read gives no card', async () => {
        assert.strictEqual(await resolveRuleProposal(throwingDb, 1, 5, 'blog_writer', { action: 'delete', ruleId: 9, ruleText: null, platform: null }), null);
    });

    console.log('\nThe list and the prompt');

    await check('own rules by id with ON/OFF; workspace-wide ones listed apart', async () => {
        const block = await buildRulesListBlock(fakeDb([
            rule(), rule({ id: 10, ruleText: 'British English', isActive: false, platform: 'linkedin' }), rule({ id: 11, ruleText: 'Be kind', assistantId: null }),
        ]), 1, 5);
        assert.match(block, /- #9 ON: Never use exclamation marks/);
        assert.match(block, /- #10 OFF: British English \[only for LinkedIn\]/);
        assert.match(block, /Workspace-wide rules[^\n]*\n- #11 ON: Be kind/);
        assert.match(await buildRulesListBlock(throwingDb, 1, 5), /could not be read this turn/);
    });
    await check('the prompt offers a platform only to the Social Media Assistant', () => {
        assert.ok(rulesPromptBlock('social_media_manager').includes('"platform"'));
        assert.ok(!rulesPromptBlock('blog_writer').includes('"platform"'));
    });
    await check('the rules block no longer forbids talking about the rules', () => {
        const b = formatRulesBlock([{ ruleText: 'No emoji', origin: 'manual' }])!;
        assert.ok(!b.includes('Never mention that you were given rules'));
        assert.ok(b.includes('unless the user asks about their rules'));
    });
    await check('Email Marketing\'s chat now reads its rules', () => {
        assert.ok(RULE_READING_ROLES.has('newsletter_editor'));
    });

    console.log('\nA stored card closes once it is done');

    await check('an add card closes once the rule exists; a change card once it no longer applies', async () => {
        const add = { uiElement: { type: 'rule_proposal', action: 'add', ruleText: 'No emoji' } };
        const [saved] = await refreshRuleCards(fakeDb([{ id: 12 }]), 1, 5, 'blog_writer', [add]);
        assert.strictEqual((saved.uiElement as any).settled, true);
        assert.match((saved.uiElement as any).blocked, /rule #12/);
        const [notYet] = await refreshRuleCards(fakeDb([]), 1, 5, 'blog_writer', [add]);
        assert.strictEqual(notYet, add);
        const off = { uiElement: { type: 'rule_proposal', action: 'turn_off', ruleId: 9 } };
        const [done] = await refreshRuleCards(fakeDb([rule({ isActive: false })]), 1, 5, 'blog_writer', [off]);
        assert.strictEqual((done.uiElement as any).settled, true);
    });

    console.log('\nWiring');

    await check('the orchestrator lists the rules and resolves the card on structured routes', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(o.includes('route !== defaultRoute ? await buildRulesListBlock(db, orgId, session.aiAssistantId) : null'));
        assert.ok(o.includes('route !== defaultRoute && !settingsReq ? ruleProposalFromUiElement(uiElement) : null'));
        assert.ok(o.includes('const profileCard: SettingsCard | RuleCard | GoalCard | ScheduleCard | PlatformsCard | LibraryCard | IntroOfferCard | OutreachOfferCard | null = settingsCard ?? ruleCard ?? goalCard ?? scheduleCard ?? platformsCard ?? libraryCard ?? introOfferCard ?? outreachOfferCard;'));
        assert.ok(read('src/utils/chat-card-refresh.ts').includes('refreshRuleCards(db, organisationId, aiAssistantId, roleKey, out)'));
    });
    await check('the click calls content-rules.ts with the page\'s methods, and the page repaints', () => {
        const src = read('src/components/chat-session.js');
        const start = src.indexOf('async function onRuleChange');
        assert.ok(start >= 0);
        const body = src.slice(start, src.indexOf('async function onLeadAction', start));
        assert.ok(body.includes("call('content-rules', 'POST'"));
        assert.ok(body.includes("call('content-rules', 'PATCH', { id, ruleText: d.ruleText })"));
        assert.ok(body.includes("call('content-rules', 'PATCH', { id, isActive: d.action === 'turn_on' })"));
        assert.ok(body.includes("call(`content-rules?id=${id}`, 'DELETE')"));
        assert.ok(src.includes("container.addEventListener('rule:change', onRuleChange)"));
        assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('rule_proposal', renderRuleProposalCard)"));
        assert.ok(read('assistants.js').includes("document.addEventListener('assistant:rulesChanged'"));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
