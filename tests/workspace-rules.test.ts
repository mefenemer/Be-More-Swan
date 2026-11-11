// tests/workspace-rules.test.ts
// FR#10 (owner 2026-11-11): one Do's and don'ts rule every assistant follows. A content_rules row with
// assistant_id NULL was already READ by every assistant (blueprint §4, assistant-rules-prompt.ts,
// chat-rules.ts); this pins how one is now CREATED and changed: owners and admins only, from the
// Assistant Rules card ("Who follows it") and from chat (rule_proposal with scope "workspace"), with
// every assistant's blueprint recompiled.
//
// Run:  npx tsx tests/workspace-rules.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_RULE_FORBIDDEN, canManageWorkspaceRules, parseRuleScope, ruleScopeOf } from '../src/utils/workspace-rules';
import { MENTOR_RULE_NOT_SHARED, buildRulesListBlock, mentorRulesPromptBlock, refreshRuleCards, resolveRuleProposal, ruleProposalFromUiElement, rulesPromptBlock } from '../src/utils/chat-rules';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');
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
const rule = (extra: Record<string, unknown> = {}) => ({ id: 9, ruleText: 'Always use British spelling', isActive: true, platform: null, assistantId: null, ...extra });

async function main() {
    console.log('\nWho may manage them');
    await check('owners and admins only; anything else, or nothing, may not', () => {
        assert.strictEqual(canManageWorkspaceRules('owner'), true);
        assert.strictEqual(canManageWorkspaceRules('admin'), true);
        for (const r of ['member', 'viewer', '', null, undefined, 'Owner']) assert.strictEqual(canManageWorkspaceRules(r as any), false, String(r));
    });
    await check('only the exact string "workspace" widens a scope; NULL assistant = workspace', () => {
        assert.strictEqual(parseRuleScope('workspace'), 'workspace');
        for (const v of ['Workspace', 'all', true, 1, null, undefined]) assert.strictEqual(parseRuleScope(v), 'assistant');
        assert.strictEqual(ruleScopeOf({ assistantId: null }), 'workspace');
        assert.strictEqual(ruleScopeOf({ assistantId: 4 }), 'assistant');
    });

    console.log('\nFrom chat');
    await check('"scope": "workspace" on an add is kept, with no platform; ignored on other actions', () => {
        assert.deepStrictEqual(
            ruleProposalFromUiElement({ type: 'rule_proposal', action: 'add', ruleText: 'British spelling', platform: 'linkedin', scope: 'workspace' }),
            { action: 'add', ruleId: null, ruleText: 'British spelling', platform: null, scope: 'workspace' });
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'add', ruleText: 'x' })?.scope, undefined);
        assert.strictEqual(ruleProposalFromUiElement({ type: 'rule_proposal', action: 'turn_off', ruleId: 9, scope: 'workspace' })?.scope, undefined);
    });
    await check('a workspace add: allowed for an owner, refused with the reason for a member', async () => {
        const req = { action: 'add' as const, ruleId: null, ruleText: 'British spelling', platform: null, scope: 'workspace' as const };
        const owner = await resolveRuleProposal(fakeDb(), 1, 5, 'social_media_manager', req, { canManageWorkspaceRules: true });
        assert.strictEqual(owner?.blocked, null);
        assert.strictEqual(owner?.scope, 'workspace');
        assert.strictEqual(owner?.platform, null);
        const member = await resolveRuleProposal(fakeDb(), 1, 5, 'social_media_manager', req, { canManageWorkspaceRules: false });
        assert.strictEqual(member?.blocked, WORKSPACE_RULE_FORBIDDEN);
    });
    await check('an assistant\'s own rule is never blocked by the workspace permission', async () => {
        const r = await resolveRuleProposal(fakeDb([rule({ assistantId: 5 })]), 1, 5, 'blog_writer', { action: 'turn_off', ruleId: 9, ruleText: null, platform: null }, { canManageWorkspaceRules: false });
        assert.strictEqual(r?.blocked, null);
        assert.strictEqual(r?.scope, 'assistant');
    });
    await check('a reload closes a workspace add once a shared rule with that text exists', async () => {
        const ui = { type: 'rule_proposal', action: 'add', ruleText: 'British spelling', scope: 'workspace', assistantId: 5 };
        const [m] = await refreshRuleCards(fakeDb([{ id: 33 }]), 1, 5, 'blog_writer', [{ uiElement: ui }]);
        assert.strictEqual((m.uiElement as any).settled, true);
        assert.strictEqual((m.uiElement as any).ruleId, 33);
    });
    await check('the prompt offers "scope": "workspace" only when asked, and allows naming shared rules', () => {
        const p = rulesPromptBlock('blog_writer');
        assert.ok(p.includes('Add "scope": "workspace" to an "add" ONLY when the user says it should apply to all their assistants'));
        assert.ok(p.includes('your own or a workspace-wide one'));
        assert.ok(!p.includes('not a workspace-wide one'));
    });

    console.log('\nFrom the Business Mentor (workspace rules only)');
    await check('every Mentor add is for every assistant, even if the model left scope out', async () => {
        const r = await resolveRuleProposal(fakeDb(), 1, 31, 'business_mentor', { action: 'add', ruleId: null, ruleText: 'Never reference a testimonials page in any material', platform: null }, { canManageWorkspaceRules: true, workspaceOnly: true });
        assert.strictEqual(r?.scope, 'workspace');
        assert.strictEqual(r?.blocked, null);
    });
    await check('the Mentor changes workspace rules, never one assistant\'s, and members are refused', async () => {
        const shared = await resolveRuleProposal(fakeDb([rule()]), 1, 31, 'business_mentor', { action: 'turn_off', ruleId: 9, ruleText: null, platform: null }, { canManageWorkspaceRules: true, workspaceOnly: true });
        assert.strictEqual(shared?.blocked, null);
        const own = await resolveRuleProposal(fakeDb([rule({ assistantId: 4 })]), 1, 31, 'business_mentor', { action: 'turn_off', ruleId: 9, ruleText: null, platform: null }, { canManageWorkspaceRules: true, workspaceOnly: true });
        assert.strictEqual(own?.blocked, MENTOR_RULE_NOT_SHARED);
        const member = await resolveRuleProposal(fakeDb(), 1, 31, 'business_mentor', { action: 'add', ruleId: null, ruleText: 'x', platform: null }, { canManageWorkspaceRules: false, workspaceOnly: true });
        assert.strictEqual(member?.blocked, WORKSPACE_RULE_FORBIDDEN);
    });
    await check('the Mentor\'s list shows only workspace-wide rules', async () => {
        const db = { select: () => { const c: any = { from: () => c, where: () => c, orderBy: () => c, limit: () => Promise.resolve([
            { id: 1, ruleText: 'Shared one', isActive: true, platform: null, origin: 'manual', assistantId: null },
            { id: 2, ruleText: 'Mentor own', isActive: true, platform: null, origin: 'manual', assistantId: 31 },
        ]) }; return c; } } as any;
        const block = await buildRulesListBlock(db, 1, 31, { workspaceOnly: true });
        assert.ok(block.startsWith('WORKSPACE-WIDE DO’S AND DON’TS'));
        assert.ok(block.includes('#1 ON: Shared one'));
        assert.ok(!block.includes('Mentor own'));
    });
    await check('the Mentor\'s prompt treats "all my assistants", "everywhere", "in any material" as every assistant', () => {
        const p = mentorRulesPromptBlock();
        for (const w of ['all their assistants', 'everywhere', 'in any material', 'never reference a testimonials page in any material', '"scope": "workspace"', 'one of your CARDS']) assert.ok(p.includes(w), w);
        assert.ok(p.includes('You never set a rule for one assistant only'));
    });
    await check('the orchestrator gives the Mentor the workspace list, its prompt, and workspaceOnly checking', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(o.includes("route === ROUTES.business_mentor ? await buildRulesListBlock(db, orgId, session.aiAssistantId, { workspaceOnly: true }) : null;"));
        assert.ok(o.includes("route === ROUTES.business_mentor ? mentorRulesPromptBlock() : null;"));
        assert.ok(o.includes("workspaceOnly: route === ROUTES.business_mentor });"));
        assert.ok(o.includes('const offersOwnCards = route !== defaultRoute && route !== ROUTES.business_mentor;'), 'its other own-card exclusions stay');
    });

    console.log('\nThe endpoint (content-rules.ts)');
    const fn = read('netlify/functions/content-rules.ts');
    await check('GET lists this assistant\'s rules AND the workspace\'s, inside this workspace, and says who may manage', () => {
        assert.ok(fn.includes('eq(contentRules.workspaceId, orgId),\n                or(eq(contentRules.assistantId, assistantId), isNull(contentRules.assistantId)),'));
        assert.ok(fn.includes('canManageWorkspaceRules: canManageWorkspace'));
        assert.ok(fn.includes('scope: ruleScopeOf(rule)'));
    });
    await check('POST: workspace scope is owners/admins only and stores assistant_id NULL with no platform', () => {
        assert.ok(fn.includes("if (scope === 'workspace' && !canManageWorkspace) return forbidden();"));
        assert.ok(fn.includes("assistantId:     scope === 'workspace' ? null : Number(assistantId),"));
        assert.ok(fn.includes("platform:        scope === 'workspace' ? null : (platform || null),"));
    });
    await check('PATCH and DELETE on a shared rule are owners/admins only; PATCH can move a rule either way', () => {
        assert.strictEqual(fn.split('if (existing.assistantId === null && !canManageWorkspace) return forbidden();').length - 1, 2);
        assert.ok(fn.includes('nextAssistantId = null;'));
        assert.ok(fn.includes('nextAssistantId = target;'));
        assert.ok(fn.includes("if (!a || a.orgId !== orgId) return { statusCode: 404"));
    });
    await check('touching a shared rule recompiles every assistant\'s blueprint', () => {
        assert.ok(fn.includes("if (before === null || after === null) {\n        await recompileOrgBlueprints(db, orgId, 'content_rules_workspace');"));
        assert.ok(fn.includes("if (scope === 'workspace') await recompileForRule(db, orgId, null, null, userId, 'create');"));
    });

    console.log('\nThe Assistant Rules card (assistants.js)');
    const page = read('assistants.js');
    await check('owners and admins get "Who follows it" on every row; others see a shared rule read-only', () => {
        assert.ok(page.includes('_rulesCanManageWorkspace = data.canManageWorkspaceRules === true;'));
        assert.ok(page.includes('<option value="workspace"${shared ? \' selected\' : \'\'}>Every assistant</option>'));
        assert.ok(page.includes("tr.querySelector('.ar-toggle')?.remove();"));
        assert.ok(page.includes('Set by a workspace owner or admin'));
    });
    await check('a new row saves with its scope; a saved one moves only after a confirm', () => {
        assert.ok(page.includes("...(tr.dataset.scope === 'workspace' ? { scope: 'workspace' } : {})"));
        assert.ok(page.includes("title: to === 'workspace' ? 'Make this a rule for every assistant?'"));
        assert.ok(page.includes("body: JSON.stringify({ id: Number(tr.dataset.ruleId), scope: to, assistantId: _rulesAssistantId })"));
    });
    await check('switching off or deleting a shared rule says it is for every assistant', () => {
        assert.ok(page.includes("title: 'Switch this rule off for every assistant?'"));
        assert.ok(page.includes("title: sharedRule ? 'Delete this rule for every assistant?' : 'Delete this rule?'"));
    });
    await check('copying rules skips shared ones; Learned directives labels them and keeps their switches on the card', () => {
        assert.ok(page.includes("r.isActive !== false && r.scope !== 'workspace'"));
        assert.ok(page.includes("${r.scope === 'workspace' ? _SHARED_RULE_CHIP : ''}"));
        assert.ok(page.indexOf('const _SHARED_RULE_CHIP') < page.indexOf("${r.scope === 'workspace' ? _SHARED_RULE_CHIP : ''}"), 'declared before its first use');
    });

    console.log('\nThe chat card and its click');
    const reg = read('src/components/disruptive-ui-registry.js');
    const sess = read('src/components/chat-session.js');
    const orch = read('netlify/functions/chat-orchestrator.ts');
    await check('the card names "every assistant" and passes the scope to the click', () => {
        assert.ok(reg.includes("const everyone = ui.scope === 'workspace';"));
        assert.ok(reg.includes("scope: everyone ? 'workspace' : 'assistant',"));
        assert.ok(reg.includes("'Every one of your assistants follows it from your next message.'"));
    });
    await check('the click saves a workspace rule with scope and no platform', () => {
        assert.ok(sess.includes("platform: everyone ? null : (d.platform || null), ...(everyone ? { scope: 'workspace' } : {})"));
    });
    await check('the orchestrator tells the card whether this user may manage shared rules', () => {
        assert.ok(orch.includes('{ canManageWorkspaceRules: canManageWorkspaceRules(ctx.role), workspaceOnly: route === ROUTES.business_mentor }'));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
}
main();
