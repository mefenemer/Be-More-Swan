// tests/assistant-chat-capabilities.test.ts
// Feature request #17 — Admin ▸ Assistants ▸ Chat capabilities. The owner's worry: "how do we know if the
// fields / data they have access to is up to date as we are constantly developing". This test is the
// answer. It fails when the chat code and the page disagree:
//   • src/config/chat-capabilities.generated.ts is not what scripts/chat-capabilities-manifest.ts reads
//     from the chat orchestrator now (a route, route switch, prompt block, per-message extra or card changed);
//   • a route switch, prompt block, per-message extra or "opened on" block has no words, or words describe
//     one the code no longer has;
//   • a card the browser can draw has no label, or no chat offers it and it is not listed as not-from-chat;
//   • a card a shared block is said to offer is not in that block's source file (or the file names one
//     that is not declared);
//   • a chat route, or a role the platform has built, has no profile.
// Fixing it: run `npx tsx scripts/chat-capabilities-manifest.ts --write`, then add the words in
// src/utils/assistant-chat-capabilities.ts.
// Run:  npx tsx tests/assistant-chat-capabilities.test.ts

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChatManifest, manifestText, MANIFEST_PATH } from '../scripts/chat-capabilities-manifest';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';
import { promptLayersFor } from '../src/config/assistant-prompt-layers';
import {
    CARD_LABELS, CARDS_NOT_FROM_CHAT, CHAT_MANIFEST, PROMPT_BLOCK_SOURCES, ROLE_PROFILES, ROUTE_FLAG_SOURCES,
    SYSTEM_PROMPT_SOURCES, TARGET_SOURCES, TURN_EXTRA_SOURCES, chatCapabilitiesFor, chatCapabilitiesPage,
    type ChatSource,
} from '../src/utils/assistant-chat-capabilities';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const sameSet = (a: readonly string[], b: readonly string[], what: string) => {
    const missing = a.filter((x) => !b.includes(x));
    const extra = b.filter((x) => !a.includes(x));
    assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] }, `${what}: "missing" = in the code with no words; "extra" = words for something the code no longer has`);
};

const fresh = buildChatManifest();
const ALL_SOURCES: Record<string, ChatSource> = { ...PROMPT_BLOCK_SOURCES, ...SYSTEM_PROMPT_SOURCES, ...ROUTE_FLAG_SOURCES, ...TURN_EXTRA_SOURCES, ...TARGET_SOURCES };
const ROLES = [...new Set([...Object.keys(ROUTES), ...Object.keys(ASSISTANT_BUILD)])];

console.log('Chat capabilities (FR#17): the page cannot drift from the chat code');

check('the generated manifest is what the chat code says now (else: npx tsx scripts/chat-capabilities-manifest.ts --write)', () => {
    assert.strictEqual(read(MANIFEST_PATH), manifestText(fresh), `${MANIFEST_PATH} is out of date`);
    assert.deepStrictEqual(CHAT_MANIFEST, fresh);
});

check('the manifest really reads the code: every ROUTES key, and known blocks and switches are found', () => {
    sameSet(Object.keys(ROUTES).sort(), Object.keys(fresh.routes), 'routes');
    for (const b of ['productsBlock', 'teamBlock', 'rulesCardBlock', 'SUPPORT_REQUEST_PROMPT', 'PLATFORM_NOTE_PROMPT']) assert.ok(fresh.promptBlocks.includes(b), b);
    for (const f of ['usesSiteSnapshot', 'acceptsAttachments', 'contentSnapshot']) assert.ok(fresh.routeFlags.includes(f), f);
    assert.ok(fresh.turnExtras.includes('message'));
    assert.ok(fresh.routes.website_assistant.cards.includes('site_changes'));
    assert.ok(fresh.routes.website_assistant.flags.includes('acceptsAttachments'));
    assert.strictEqual(fresh.routes.business_mentor.offersOwnCards, false);
    assert.strictEqual(fresh.routes.social_media_manager.contentSnapshot, 'posts');
    assert.ok(fresh.uiCards.length > 50 && fresh.uiCards.includes('rule_proposal'));
});

check('every prompt block in promptWithRules has words, and none describes a block that is gone', () => {
    sameSet(fresh.promptBlocks, Object.keys(PROMPT_BLOCK_SOURCES), 'prompt blocks');
});

check('every route switch on AssistantRoute has words', () => {
    sameSet(fresh.routeFlags, Object.keys(ROUTE_FLAG_SOURCES), 'route switches');
});

check("every extra added to the user's message has words", () => {
    sameSet(fresh.turnExtras, Object.keys(TURN_EXTRA_SOURCES), 'per-message extras');
});

check('every "opened on a post / email" block has words', () => {
    sameSet(Object.keys(fresh.targetCards), Object.keys(TARGET_SOURCES), 'opened-on blocks');
});

check('the always-there system prompt parts are still in buildSystemPrompt', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    for (const [k, s] of Object.entries(SYSTEM_PROMPT_SOURCES)) assert.ok(orch.includes(s.marker), `${k}: "${s.marker}" not in chat-orchestrator.ts`);
});

check('every source file named exists', () => {
    for (const [k, s] of Object.entries(ALL_SOURCES)) for (const f of s.source.split(', ')) assert.ok(existsSync(join(root, f)), `${k}: ${f}`);
});

check('every card the browser can draw has a label, and no label is for a card that is gone', () => {
    sameSet(fresh.uiCards, Object.keys(CARD_LABELS), 'card labels');
});

check('every card is offered by some chat, or listed as not-from-chat (and those are offered by none)', () => {
    const offered = new Set(ROLES.flatMap((r) => chatCapabilitiesFor(r).canDo.cards.map((c) => c.type)));
    const orphan = fresh.uiCards.filter((t) => !offered.has(t) && !(t in CARDS_NOT_FROM_CHAT));
    assert.deepStrictEqual(orphan, [], 'cards no chat offers — attribute them to a block (cards:) or list them in CARDS_NOT_FROM_CHAT');
    for (const t of Object.keys(CARDS_NOT_FROM_CHAT)) {
        assert.ok(fresh.uiCards.includes(t), `${t} is not a card any more`);
        assert.ok(!offered.has(t), `${t} is listed as not-from-chat but a chat offers it`);
    }
});

check("a shared block's cards are in its source file, and its file offers no undeclared card", () => {
    const named = (txt: string) => [...txt.matchAll(/"type"\s*:\s*\\?"([a-z][a-z0-9_]*)\\?"/g)].map((m) => m[1]).filter((t) => fresh.uiCards.includes(t));
    for (const [k, s] of Object.entries({ ...PROMPT_BLOCK_SOURCES, ...ROUTE_FLAG_SOURCES })) {
        if (!s.cards || s.source === 'netlify/functions/chat-orchestrator.ts') continue;
        const txt = s.source.split(', ').map(read).join('\n');
        const declared = new Set(ROLES.flatMap((r) => s.cards!({ roleKey: r, route: CHAT_MANIFEST.routes[r] ?? null } as never)));
        for (const t of declared) assert.ok(txt.includes(`'${t}'`) || txt.includes(`"${t}"`), `${k}: card ${t} not in ${s.source}`);
        for (const t of named(txt)) assert.ok(declared.has(t), `${k}: ${s.source} names card ${t}, not declared in its cards`);
    }
});

check('every chat route and every built role has a profile with a field, skills and can\'t-dos; no profile for a role that does not exist', () => {
    for (const r of ROLES) {
        const p = ROLE_PROFILES[r];
        assert.ok(p, `${r} has no ROLE_PROFILES entry`);
        assert.ok(p.field.length > 10 && p.skills.length && p.cannot.length, `${r}: profile incomplete`);
    }
    for (const r of Object.keys(ROLE_PROFILES)) assert.ok(ROLES.includes(r), `${r} has a profile but no route or build`);
});

check('expertise level is derived: Expert ⇔ a written craft standard, General ⇔ no chat route', () => {
    for (const r of [...ROLES, 'inbox_manager']) {
        const c = chatCapabilitiesFor(r);
        const craft = promptLayersFor(r).some((l) => l.kind === 'craft');
        assert.strictEqual(c.expertise.level, !ROUTES[r] ? 'General' : craft ? 'Expert' : 'Specialist', r);
    }
    assert.strictEqual(chatCapabilitiesFor('website_assistant').expertise.level, 'Expert');
    assert.strictEqual(chatCapabilitiesFor('crm_enricher').expertise.level, 'Specialist');
});

check('the lists say what the code does (spot checks against the real role lists)', () => {
    const site = chatCapabilitiesFor('website_assistant');
    assert.ok(site.reads.ownData.some((i) => i.label === 'Its website') && site.reads.ownData.some((i) => i.label === 'Files the user attaches'));
    assert.ok(site.canDo.cards.some((c) => c.type === 'site_changes') && site.canDo.cards.some((c) => c.type === 'rule_proposal'));
    assert.ok(!site.cannot.some((s) => s.includes('attached to the chat')));
    const mentor = chatCapabilitiesFor('business_mentor');
    assert.ok(!mentor.canDo.cards.some((c) => c.type === 'assistant_settings_proposal'), 'the Mentor gets none of the shared cards');
    assert.ok(mentor.canDo.cards.some((c) => c.type === 'rule_proposal'), 'but it sets workspace-wide rules');
    const mail = chatCapabilitiesFor('email_assistant');
    assert.ok(mail.cannot.some((s) => s.includes('attached to the chat')) && mail.doesNotRead.includes('Products & Services') === false);
    // Not in RULE_READING_ROLES, but its rules list ("ON rules are the ones you follow") reaches its chat.
    assert.ok(!mail.cannot.some((s) => s.includes("Do's and don'ts")), 'email_assistant follows its rules through the rules list');
    const social = chatCapabilitiesFor('social_media_manager');
    assert.ok(social.canDo.cards.some((c) => c.type === 'post_text_edit') && social.canDo.cards.some((c) => c.type === 'pillar_proposal') && social.canDo.cards.some((c) => c.type === 'inspo_proposal'));
    assert.ok(chatCapabilitiesFor('newsletter_editor').canDo.cards.some((c) => c.type === 'email_edit'));
    assert.ok(chatCapabilitiesFor('tier1_support_agent').canDo.cards.some((c) => c.type === 'kb_article_proposal'));
    assert.ok(chatCapabilitiesFor('lead_qualifier').canDo.cards.some((c) => c.type === 'outreach_offer'));
    const none = chatCapabilitiesFor('inbox_manager');
    assert.ok(!none.hasRoute && none.canDo.cards.length === 0 && none.cannot[0].includes('no chat route'));
});

check('every role gets the same sections, every shared item exactly once', () => {
    for (const r of ROLES) {
        const c = chatCapabilitiesFor(r);
        for (const k of ['expertise', 'reads', 'controls', 'doesNotRead', 'canDo', 'cannot', 'rules'] as const) assert.ok(k in c, `${r}.${k}`);
        const labels = [...c.reads.everyAssistant, ...c.reads.ownData, ...c.reads.sometimes, ...c.controls].map((i) => i.label);
        assert.strictEqual(new Set(labels).size, labels.length, `${r}: an item listed twice`);
        assert.ok(c.reads.everyAssistant.some((i) => i.label === 'Products & Services'), `${r}: shared data missing`);
        assert.ok(c.rules.some((i) => i.label === 'Special category data'), `${r}: shared rule missing`);
    }
});

check('the page flags a live role with no words and a route with no catalogue row', () => {
    const page = chatCapabilitiesPage([
        { id: 1, roleKey: 'website_assistant', name: 'Website', status: 'live', hiredCount: 3, chatModel: null },
        { id: 2, roleKey: 'brand_new_role', name: 'New', status: 'live', hiredCount: 0, chatModel: null },
        { id: 3, roleKey: 'inbox_manager', name: 'Inbox', status: 'coming_soon', hiredCount: 0, chatModel: null },
    ], 'abc1234');
    assert.deepStrictEqual(page.undescribedLive, ['brand_new_role']);
    assert.ok(page.routesNotInCatalogue.includes('blog_writer') && !page.routesNotInCatalogue.includes('website_assistant'));
    assert.strictEqual(page.freshness.commit, 'abc1234');
    assert.strictEqual(page.roles.length, 3);
});

check('Admin shows it: a Chat capabilities page under Assistants and a tab on each assistant', () => {
    const html = read('admin.html');
    assert.ok(html.includes('<script src="/src/components/admin-chat-capabilities.js"></script>'));
    assert.ok(html.includes("{ view: 'chat-capabilities',    icon: '💬', label: 'Chat capabilities',   perm: 'assistant_catalog', group: 'Set-up' },"));
    assert.ok(html.includes('<section id="view-chat-capabilities" class="admin-view hidden">') && html.includes('<div id="cc-mount"></div>'));
    assert.ok(html.includes("if (view === 'chat-capabilities') window.AdminChatCaps?.load(document.getElementById('cc-mount'));"));
    assert.ok(html.includes(`data-tab="chat-caps" onclick="aaTab('chat-caps')">Chat capabilities</button>`));
    assert.ok(html.includes("else if (tab === 'chat-caps') window.AdminChatCaps?.renderRole(_aa.current.assistant.roleKey, document.getElementById('aa-body'));"));
    const fn = read('netlify/functions/admin-assistants.ts');
    assert.ok(fn.includes("if (event.httpMethod === 'GET' && q.chatCapabilities === '1') {") && fn.includes('chatCapabilitiesPage(roles, process.env.COMMIT_REF ?? null)'));
    const js = read('src/components/admin-chat-capabilities.js');
    for (const h of ['1 · Expertise', '2 · What it reads', '3 · What it can see and change', '4 · What it can do', "5 · What it can't do", '6 · Rules it follows']) assert.ok(js.includes(h), h);
    assert.ok(js.includes('window.AdminChatCaps = { load, renderRole };'));
});

console.log(`\n${passed} passed`);
