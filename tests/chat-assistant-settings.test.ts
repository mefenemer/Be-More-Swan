// tests/chat-assistant-settings.test.ts
// Every assistant's chat knows its own status, settings and goals, and can propose a change to them
// through a card the user confirms — which calls the same endpoint as the Assistant Profile.
//
// WHY THIS EXISTS. The parity audit of 2026-10-22 found the chat blind to its own row: "are you
// paused?" and "how far ahead are you drafting?" got a guess, and "pause for a week" could only be
// done on the page. These pin what makes the chat path honest and safe: the proposal is checked
// against the row and rebuilt from it; only a setting the role's page actually shows can be offered
// (the role table mirrors assistant-dashboard-registry.js — checked here by evaluating it); a change
// that changes nothing is refused; a stored card closes once the change is made; and the click goes
// through the page's own endpoints with the page's own methods.
//
// Run:  npx tsx tests/chat-assistant-settings.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
    SETTINGS_BY_ROLE, assistantSettingsPromptBlock, buildAssistantSettingsSnapshot, refreshSettingsCards,
    resolveSettingsProposal, settingsForRole, settingsProposalFromUiElement,
} from '../src/utils/chat-assistant-settings';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** A db whose successive select() calls answer with the given row lists, in order. */
function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = {
                from: () => chain,
                where: () => chain,
                orderBy: () => chain,
                limit: () => Promise.resolve(rows),
            };
            return chain;
        },
    } as any;
}
const throwingDb = { select: () => { throw new Error('db down'); } } as any;

const row = (extra: Record<string, unknown> = {}) => ({
    id: 5, name: 'Marvin', lifecycleStatus: 'working', draftHorizonDays: 7, reviewNotifPreference: 'immediate',
    autonomousMediaEnabled: false, autonomousMediaMonthlyCap: 20, ...extra,
});

async function main() {
    console.log('\nThe model\'s proposal is shape-checked');

    await check('pause and resume need nothing else', () => {
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'pause' })?.setting, 'pause');
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'resume' })?.setting, 'resume');
    });
    await check('a horizon is clamped to 1–30 and must be a whole number', () => {
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'draft_horizon', days: 60 })?.days, 30);
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'draft_horizon', days: 'soon' }), null);
    });
    await check('review alerts take only the three page values', () => {
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'review_alerts', value: 'daily_digest' })?.value, 'daily_digest');
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'review_alerts', value: 'weekly' }), null);
    });
    await check('content suggestions need a switch or a cap', () => {
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'content_suggestions' }), null);
        assert.deepStrictEqual(
            settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'content_suggestions', enabled: true, monthlyCap: '12' }),
            { setting: 'content_suggestions', days: null, value: null, enabled: true, monthlyCap: 12 });
    });
    await check('archive, unknown settings and other card types are not proposals', () => {
        assert.strictEqual(settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'archive' }), null);
        assert.strictEqual(settingsProposalFromUiElement({ type: 'post_action_proposal', setting: 'pause' }), null);
        assert.strictEqual(settingsProposalFromUiElement(null), null);
    });

    console.log('\nOnly the settings the role\'s page shows');

    await check('SETTINGS_BY_ROLE matches assistant-dashboard-registry.js for every role', () => {
        const w: Record<string, any> = {};
        vm.runInNewContext(read('src/components/assistant-dashboard-registry.js'), { window: w, console });
        const reg = w.AssistantDashboardRegistry;
        for (const roleKey of Object.keys(reg.REGISTRY)) {
            const m = reg.get(roleKey).modules || {};
            const expected = [
                ...(m.hasPostingSchedule !== false && m.hasScheduleCard !== false ? ['draft_horizon'] : []),
                ...(m.hasReviewCadence !== false ? ['review_alerts'] : []),
                ...(m.hasContentAutomation !== false ? ['content_suggestions'] : []),
            ];
            assert.deepStrictEqual([...(SETTINGS_BY_ROLE[roleKey] ?? [])], expected, `${roleKey} shows ${expected.join(', ') || 'none'} on its page`);
        }
    });
    await check('every role can be paused and resumed; the prompt offers only its own settings', () => {
        assert.deepStrictEqual(settingsForRole('crm_enricher'), ['pause', 'resume']);
        const blog = assistantSettingsPromptBlock('blog_writer');
        assert.ok(blog.includes('"draft_horizon"'));
        assert.ok(!blog.includes('"review_alerts"') && !blog.includes('"content_suggestions"'));
    });

    console.log('\nThe card is built from the row, not the model');

    await check('a horizon change shows now and after', async () => {
        const card = await resolveSettingsProposal(fakeDb([row()]), 1, 5, 'social_media_manager',
            settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'draft_horizon', days: 14 })!);
        assert.strictEqual(card?.current, '7 days');
        assert.strictEqual(card?.proposed, '14 days');
        assert.strictEqual(card?.blocked, null);
        assert.strictEqual(card?.assistantName, 'Marvin');
    });
    await check('a setting the role does not have is refused on the card', async () => {
        const card = await resolveSettingsProposal(fakeDb([row()]), 1, 5, 'blog_writer',
            settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'review_alerts', value: 'daily_digest' })!);
        assert.match(card?.blocked ?? '', /doesn’t have that setting/);
    });
    await check('a change that changes nothing is refused', async () => {
        const card = await resolveSettingsProposal(fakeDb([row({ reviewNotifPreference: 'daily_digest' })]), 1, 5, 'social_media_manager',
            settingsProposalFromUiElement({ type: 'assistant_settings_proposal', setting: 'review_alerts', value: 'daily_digest' })!);
        assert.match(card?.blocked ?? '', /already set to Daily digest/);
    });
    await check('pause needs a working assistant; resume refuses a system pause', async () => {
        const pause = await resolveSettingsProposal(fakeDb([row({ lifecycleStatus: 'paused' })]), 1, 5, 'crm_enricher', { setting: 'pause', days: null, value: null, enabled: null, monthlyCap: null });
        assert.match(pause?.blocked ?? '', /already paused/);
        const resume = await resolveSettingsProposal(fakeDb([row({ lifecycleStatus: 'system_paused' })]), 1, 5, 'crm_enricher', { setting: 'resume', days: null, value: null, enabled: null, monthlyCap: null });
        assert.match(resume?.blocked ?? '', /needs fixing/);
        const start = await resolveSettingsProposal(fakeDb([row({ lifecycleStatus: 'ready_for_work' })]), 1, 5, 'crm_enricher', { setting: 'resume', days: null, value: null, enabled: null, monthlyCap: null });
        assert.strictEqual(start?.blocked, null);
    });
    await check('another organisation\'s assistant gives no card; a db failure gives none either', async () => {
        assert.strictEqual(await resolveSettingsProposal(fakeDb([]), 1, 5, 'social_media_manager', { setting: 'pause', days: null, value: null, enabled: null, monthlyCap: null }), null);
        assert.strictEqual(await resolveSettingsProposal(throwingDb, 1, 5, 'social_media_manager', { setting: 'pause', days: null, value: null, enabled: null, monthlyCap: null }), null);
    });

    console.log('\nThe snapshot says what is true, and only what the role has');

    await check('social snapshot lists status, the three settings and goals', async () => {
        const block = await buildAssistantSettingsSnapshot(fakeDb([row({ autonomousMediaEnabled: true })], [
            { title: 'Grow Instagram', metricKey: 'instagram_followers', targetValue: '1200', latestValue: '950', targetDate: new Date('2026-12-31T00:00:00Z'), status: 'at_risk', isPrimary: true },
        ]), 1, 5, 'social_media_manager');
        assert.match(block, /Status: working/);
        assert.match(block, /"Generate posts ahead" \(Assistant Profile ▸ When and how I post\): 7 days/);
        assert.match(block, /"Review alerts".*Immediate/);
        assert.match(block, /Autonomous Content Suggestions.*on, up to 20/);
        assert.match(block, /\(main goal\) Grow Instagram: 950.* target 1200.* by 2026-12-31 — at risk/);
    });
    await check('a records role sees only its status and goals', async () => {
        const block = await buildAssistantSettingsSnapshot(fakeDb([row({ lifecycleStatus: 'paused' })], []), 1, 5, 'crm_enricher');
        assert.match(block, /Status: paused by the user/);
        assert.ok(!/Generate posts ahead|Review alerts|Autonomous/.test(block));
        assert.match(block, /YOUR GOALS: none set yet/);
    });
    await check('a failed read says so rather than inviting a guess', async () => {
        assert.match(await buildAssistantSettingsSnapshot(throwingDb, 1, 5, 'social_media_manager'), /could not be read this turn/);
    });

    console.log('\nA stored card closes once the change is made');

    await check('a done change is settled; a still-open one keeps its button', async () => {
        const stored = { uiElement: { type: 'assistant_settings_proposal', setting: 'draft_horizon', days: 14, current: '7 days', proposed: '14 days', blocked: null } };
        const [done] = await refreshSettingsCards(fakeDb([row({ draftHorizonDays: 14 })]), 1, 5, 'social_media_manager', [stored]);
        assert.strictEqual((done.uiElement as any).settled, true);
        const [open] = await refreshSettingsCards(fakeDb([row()]), 1, 5, 'social_media_manager', [stored]);
        assert.strictEqual((open.uiElement as any).settled, undefined);
        const plain = [{ uiElement: null }];
        assert.strictEqual(await refreshSettingsCards(throwingDb, 1, 5, 'social_media_manager', plain), plain);
    });

    console.log('\nWiring: same endpoints as the page, every structured route');

    await check('the orchestrator reads the snapshot every turn and resolves the card on structured routes', () => {
        const src = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(src.includes('buildAssistantSettingsSnapshot(db, orgId, session.aiAssistantId, assistantRow.roleKey)'));
        assert.ok(src.includes("route !== defaultRoute ? assistantSettingsPromptBlock(assistantRow.roleKey) : null"));
        assert.ok(src.includes("route !== defaultRoute ? settingsProposalFromUiElement(uiElement) : null"));
        // The blog and newsletter routes rebuild uiElement after the action cards — a settings card must survive.
        assert.ok(src.includes('blogAction ?? settingsCard'));
        assert.ok(src.includes('emailAction ?? audienceCard ?? settingsCard'));
    });
    await check('reloading a conversation re-checks stored settings cards', () => {
        assert.ok(read('netlify/functions/get-chat-session.ts').includes('refreshSettingsCards(db, orgId, session.aiAssistantId, session.roleKey'));
    });
    await check('the click calls the Assistant Profile\'s endpoints with their methods', () => {
        const src = read('src/components/chat-session.js');
        const start = src.indexOf('async function onSettingsChange');
        assert.ok(start >= 0, 'onSettingsChange exists');
        const body = src.slice(start, src.indexOf('async function onLeadAction', start));
        assert.ok(body.includes("call(`manage-assistant?id=${id}`, 'PATCH', { action: 'pause' })"));
        assert.ok(body.includes("call(`kickoff-assistant?id=${id}`, 'POST')"), 'resume goes through Kick Off, like the page');
        assert.ok(body.includes("call('set-draft-horizon', 'PATCH'"));
        assert.ok(body.includes("call('set-review-notif-prefs', 'PATCH'"));
        assert.ok(body.includes("call('set-autonomous-media', 'PATCH'"));
        assert.ok(!body.includes("'DELETE'"), 'the chat never archives');
        assert.ok(src.includes("container.addEventListener('settings:change', onSettingsChange)"));
        assert.ok(src.includes("container.removeEventListener('settings:change', onSettingsChange)"));
    });
    await check('the card is registered and the page repaints from document', () => {
        assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('assistant_settings_proposal', renderAssistantSettingsProposalCard)"));
        assert.ok(read('assistants.js').includes("document.addEventListener('assistant:settingsChanged'"));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
