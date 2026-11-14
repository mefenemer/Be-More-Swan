// tests/chat-capability-gaps.test.ts
// FR#17 follow-up (owner, 2026-11-14): Chat capabilities "needs to help the admin user by highlighting where there
// are potential gaps or improvements that could be made. It should also suggest next best actions if any."
// Every gap is derived from the code-read data (chatGapsFor), so these checks pin each rule to what the code does
// today, and that a gap closes itself when the code changes.
// Run:  npx tsx tests/chat-capability-gaps.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import { promptLayersFor } from '../src/config/assistant-prompt-layers';
import {
    ACCEPTED_GAPS, CARD_LABELS, CHAT_MANIFEST, CRAFT_ALSO_DRAFTED_IN_CHAT, chatCapabilitiesFor, chatCapabilitiesPage, chatGapsFor,
    nextBestActions, type Gap,
} from '../src/utils/assistant-chat-capabilities';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const keys = (gs: Gap[]) => gs.map((g) => g.key);
const orch = read('netlify/functions/chat-orchestrator.ts');

console.log('Chat capabilities: gaps and next best actions');

check('craft standards: the manifest says which reach the chat, matching the orchestrator source', () => {
    // Website and Campaign chats carry their craft; Social, Email and Blog chats do not (2026-11-14).
    assert.ok(CHAT_MANIFEST.routes.website_assistant.craftInChat.includes('site_copy') && orch.includes('${SITE_COPY_CRAFT}'));
    assert.ok(CHAT_MANIFEST.routes.campaign_orchestrator.craftInChat.includes('campaign_craft'));
    for (const [role, c] of [['social_media_manager', 'platformCraftBlock'], ['newsletter_editor', 'emailCraftBlock'], ['blog_writer', 'BLOG_CRAFT']] as const) {
        const inChat = CHAT_MANIFEST.routes[role].craftInChat.length > 0;
        assert.strictEqual(inChat, orch.includes(c), `${role}: manifest and source disagree about ${c}`);
    }
    for (const [role, r] of Object.entries(CHAT_MANIFEST.routes)) {
        const craftKeys = promptLayersFor(role).filter((l) => l.kind === 'craft').map((l) => l.key);
        for (const k of r.craftInChat) assert.ok(craftKeys.includes(k), `${role}: ${k} is not one of its craft layers`);
    }
});

check('a chat that drafts the same output without the standard is a MEDIUM gap; otherwise LOW', () => {
    for (const [layer, card] of Object.entries(CRAFT_ALSO_DRAFTED_IN_CHAT)) assert.ok(CARD_LABELS[card], `${layer} → unknown card ${card}`);
    const social = chatGapsFor('social_media_manager', 'live');
    const craft = social.find((g) => g.key === 'craft_not_in_chat');
    if (CHAT_MANIFEST.routes.social_media_manager.craftInChat.includes('platform_craft')) assert.ok(!craft, 'fixed: the gap closes itself');
    else {
        assert.strictEqual(craft?.severity, 'medium');
        assert.ok(craft!.action.includes('src/constants/platform-craft.ts') && craft!.action.includes('social_media_manager route prompt'));
    }
    const designer = chatGapsFor('brand_designer', 'live').find((g) => g.key === 'craft_not_in_chat');
    assert.strictEqual(designer?.severity, 'low', 'art direction runs in the background; its chat does not draft it');
    assert.ok(!keys(chatGapsFor('website_assistant', 'live')).includes('craft_not_in_chat'));
});

check('a live role with no chat route is HIGH; a waitlisted one is a note; a hidden one is not flagged for it', () => {
    assert.ok(!ROUTES.inbox_manager);
    const live = chatGapsFor('inbox_manager', 'live');
    assert.strictEqual(live.find((g) => g.key === 'no_chat_route')?.severity, 'high');
    assert.strictEqual(live.find((g) => g.key === 'not_described')?.severity, 'high');
    assert.strictEqual(chatGapsFor('inbox_manager', 'coming_soon').find((g) => g.key === 'no_chat_route')?.severity, 'info');
    assert.ok(!keys(chatGapsFor('inbox_manager', 'hidden')).includes('no_chat_route'));
});

check('Specialist (no written craft) is a gap; Expert roles are not flagged for it', () => {
    assert.strictEqual(chatCapabilitiesFor('email_assistant').expertise.level, 'Specialist');
    assert.strictEqual(chatGapsFor('email_assistant', 'beta').find((g) => g.key === 'no_craft_standard')?.severity, 'medium');
    assert.strictEqual(chatGapsFor('crm_enricher', 'hidden').find((g) => g.key === 'no_craft_standard')?.severity, 'low');
    assert.ok(!keys(chatGapsFor('website_assistant', 'live')).includes('no_craft_standard'));
});

check('rules: no gap while its rules list ("ON rules are the ones you follow") reaches the chat', () => {
    assert.ok(read('src/utils/chat-rules.ts').includes('ON rules are the ones you follow'));
    for (const r of Object.keys(ROUTES)) assert.ok(!keys(chatGapsFor(r, 'live')).includes('rules_not_in_chat'), r);
});

check("a chat that reads none of its own work is flagged; one with a snapshot is not", () => {
    for (const r of ['accounts_receivable_clerk', 'crm_enricher', 'meeting_note_taker']) assert.ok(keys(chatGapsFor(r, 'live')).includes('blind_to_own_work'), r);
    for (const r of ['social_media_manager', 'lead_qualifier', 'tier1_support_agent', 'website_assistant']) assert.ok(!keys(chatGapsFor(r, 'live')).includes('blind_to_own_work'), r);
});

check('attachments: a media role whose chat takes no files gets a LOW suggestion; the Website Assistant does not', () => {
    assert.strictEqual(chatGapsFor('video_producer', 'live').find((g) => g.key === 'no_attachments_with_media')?.severity, 'low');
    assert.ok(!keys(chatGapsFor('website_assistant', 'live')).includes('no_attachments_with_media'));
});

check('every gap says why and names a file to change; gaps are most severe first', () => {
    for (const r of [...Object.keys(ROUTES), 'inbox_manager']) {
        const gs = chatGapsFor(r, 'live', 3);
        for (const g of gs) assert.ok(g.why.length > 20 && /\.(ts|js)\b|\bLive\b|plan/.test(g.action), `${r}/${g.key}: ${g.action}`);
        const w = gs.map((g) => ({ high: 3, medium: 2, low: 1, info: 0 })[g.severity]);
        assert.deepStrictEqual(w, [...w].sort((a, b) => b - a), r);
    }
});

check('hidden or retired but still hired: a note, so its words stay current', () => {
    assert.strictEqual(chatGapsFor('crm_enricher', 'hidden', 4).find((g) => g.key === 'hired_but_not_live')?.title, '4 workspaces still use it');
    assert.ok(!keys(chatGapsFor('crm_enricher', 'hidden', 0)).includes('hired_but_not_live'));
});

check('next best actions: live/beta only, high and medium only, same fix grouped, ordered by severity then workspaces', () => {
    // Fixed-shape gaps only (no route; no snapshot of its own work), so closing a craft gap elsewhere can't break this.
    const fake = (roleKey: string, hiredCount: number, gaps: Gap[]) => ({ roleKey, name: roleKey, status: 'live', hiredCount, gaps });
    const gap = (key: Gap['key'], severity: Gap['severity'], title: string): Gap => ({ key, severity, title, why: 'w', action: `Fix it for ${title}.` });
    const roles = [
        fake('few', 2, [gap('blind_to_own_work', 'medium', 'few'), gap('no_attachments_with_media', 'low', 'low one')]),
        fake('many', 9, [gap('no_craft_standard', 'medium', 'many')]),
        { roleKey: 'inbox_manager', name: 'Inbox', status: 'live', hiredCount: 1, gaps: chatGapsFor('inbox_manager', 'live', 1) },
        { roleKey: 'crm_enricher', name: 'CRM', status: 'hidden', hiredCount: 50, gaps: chatGapsFor('crm_enricher', 'hidden', 50) },
    ];
    const acts = nextBestActions(roles);
    assert.strictEqual(acts[0].severity, 'high');
    assert.ok(acts.every((a) => a.severity === 'high' || a.severity === 'medium'), 'low gaps are never a next action');
    assert.ok(!acts.some((a) => a.roles.some((x) => x.roleKey === 'crm_enricher')), 'hidden roles are never a next action');
    const meds = acts.filter((a) => a.severity === 'medium').map((a) => a.roles[0].roleKey);
    assert.deepStrictEqual(meds, ['many', 'few'], 'more workspaces first');
    // Grouping: the same gap on two live roles is one action naming both.
    const two = nextBestActions(['accounts_receivable_clerk', 'crm_enricher'].map((k) => ({ roleKey: k, name: k, status: 'live', hiredCount: 1, gaps: chatGapsFor(k, 'live', 1) })));
    const blind = two.find((a) => a.key === 'blind_to_own_work')!;
    assert.deepStrictEqual(blind.roles.map((x) => x.roleKey), ['accounts_receivable_clerk', 'crm_enricher']);
    assert.ok(blind.action.includes('accounts_receivable_clerk, crm_enricher') && blind.workspaces === 2);
});

check('an accepted gap is shown as accepted and never suggested; every acceptance still matches a real gap', () => {
    for (const k of Object.keys(ACCEPTED_GAPS)) {
        const [role, ...rest] = k.split(':');
        const status = 'live';
        const gs = chatGapsFor(role, status);
        assert.ok(gs.some((g) => g.accepted === ACCEPTED_GAPS[k]), `${k} no longer matches a gap — remove it`);
        assert.ok(rest.length >= 1);
    }
    ACCEPTED_GAPS['email_assistant:no_craft_standard'] = 'Owner: test';
    try {
        const g = chatGapsFor('email_assistant', 'beta').find((x) => x.key === 'no_craft_standard')!;
        assert.strictEqual(g.accepted, 'Owner: test');
        assert.ok(!nextBestActions([{ roleKey: 'email_assistant', name: 'E', status: 'beta', hiredCount: 1, gaps: [g] }]).length);
    } finally { delete ACCEPTED_GAPS['email_assistant:no_craft_standard']; }
});

check('the page carries gaps per role and the next actions; the UI shows them', () => {
    const page = chatCapabilitiesPage([
        { id: 1, roleKey: 'inbox_manager', name: 'Inbox', status: 'live', hiredCount: 5, chatModel: null },
        { id: 2, roleKey: 'newsletter_editor', name: 'Email', status: 'live', hiredCount: 5, chatModel: null },
    ]);
    assert.ok(page.roles[0].gaps.length > 0 && page.nextActions.length > 0);
    const js = read('src/components/admin-chat-capabilities.js');
    assert.ok(js.includes('7 · Gaps and next best actions') && js.includes('function nextActionsBox(d)') && js.includes('${nextActionsBox(d)}'));
    assert.ok(js.includes('<th>Gaps</th>') && js.includes('not in its chat'));
});

console.log(`\n${passed} passed`);
