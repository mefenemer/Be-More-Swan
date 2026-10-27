// tests/mentor-page.test.ts
// Business Mentor Phase 1a: how suggestions behave (docs/business-mentor-plan.md §3.13), the Overview
// tab's panels (§14) and Admin ▸ Mentor activity (§8.2).
//
//   - 3 suggestions a week; a direct ask is never refused or counted.
//   - Dismiss with a reason: "not now" holds for 14 days, "disagree" / "not relevant" until brought back,
//     "already done" holds nothing; a dismissal only holds back cards that share a field with it.
//   - Every capability has a screen AND a card through ONE server action (mentor.ts).
//   - The checklist and the prompt's gaps come from one function; "What I can see" from the inventory.
//   - The prompt names the Overview tab and its panels exactly as the page labels them.
//
// Run:  npx tsx tests/mentor-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    SNOOZE_DAYS, WEEKLY_CAP, gateSuggestion, holdingDismissal, proposalFields, renderProposalState,
    type DismissedRow, type ProposalState,
} from '../src/utils/mentor-proposals';
import { businessGaps, setupChecklist, type MentorSnapshotData } from '../src/utils/mentor-snapshot';
import { MENTOR_DATA_INVENTORY, mentorVisibility, mentorVisibilityPromptBlock } from '../src/config/mentor-data-inventory';
import { mentorCardFromUiElement, mentorCardsPromptBlock } from '../src/utils/mentor-cards';
import { summariseMentorActivity, topReason, type MentorActivityRow } from '../src/utils/mentor-activity';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const now = new Date('2026-10-28T12:00:00Z');
const day = 86_400_000;
const dismissed = (over: Partial<DismissedRow>): DismissedRow => ({
    id: 1, kind: 'business_info_gap', title: 'Add your website', why: null, fields: ['websiteUrl'],
    reason: 'disagree', snoozedUntil: null, decidedAt: now, ...over,
});
const state = (over: Partial<ProposalState> = {}): ProposalState => ({ usedThisWeek: 0, dismissed: [], ...over });

console.log('Business Mentor: suggestions, Overview tab and activity');

test('at most 3 suggestions a week; a direct ask is never refused', () => {
    assert.strictEqual(WEEKLY_CAP, 3);
    const card = { kind: 'products_gap', fields: [], asked: false };
    assert.deepStrictEqual(gateSuggestion(card, state({ usedThisWeek: 2 }), now), { ok: true });
    const refused = gateSuggestion(card, state({ usedThisWeek: 3 }), now);
    assert.ok(!refused.ok && refused.why === 'cap');
    assert.deepStrictEqual(gateSuggestion({ ...card, asked: true }, state({ usedThisWeek: 9 }), now), { ok: true });
});

test('dismiss reasons: disagree and not relevant hold, not now holds 14 days, already done holds nothing', () => {
    assert.strictEqual(SNOOZE_DAYS, 14);
    const web = ['websiteUrl'];
    assert.ok(holdingDismissal('business_info_gap', web, [dismissed({ reason: 'disagree' })], now));
    assert.ok(holdingDismissal('business_info_gap', web, [dismissed({ reason: 'not_relevant' })], now));
    assert.ok(holdingDismissal('business_info_gap', web, [dismissed({ reason: 'not_now', snoozedUntil: new Date(now.getTime() + day) })], now));
    assert.strictEqual(holdingDismissal('business_info_gap', web, [dismissed({ reason: 'not_now', snoozedUntil: new Date(now.getTime() - day) })], now), null);
    assert.strictEqual(holdingDismissal('business_info_gap', web, [dismissed({ reason: 'already_done' })], now), null);
});

test('a dismissal holds back only the same kind with a field in common', () => {
    const d = [dismissed({ fields: ['websiteUrl'] })];
    assert.strictEqual(holdingDismissal('business_info_gap', ['businessDescription'], d, now), null, 'other field');
    assert.ok(holdingDismissal('business_info_gap', ['industry', 'websiteUrl'], d, now), 'overlapping field');
    assert.strictEqual(holdingDismissal('products_gap', [], d, now), null, 'other kind');
    assert.ok(holdingDismissal('products_gap', [], [dismissed({ kind: 'products_gap', fields: [] })], now));
    const g = gateSuggestion({ kind: 'business_info_gap', fields: ['websiteUrl'], asked: false }, state({ dismissed: d }), now);
    assert.ok(!g.ok && g.why === 'dismissed' && /Bring it back/.test(g.note));
    assert.deepStrictEqual(gateSuggestion({ kind: 'business_info_gap', fields: ['websiteUrl'], asked: true }, state({ dismissed: d }), now), { ok: true });
    assert.deepStrictEqual(proposalFields({ fields: { websiteUrl: 'x', industry: 'y' } }), ['industry', 'websiteUrl']);
    assert.deepStrictEqual(proposalFields({ products: [] }), []);
});

test('the prompt is told the week\'s count and what not to raise again', () => {
    assert.match(renderProposalState(state({ usedThisWeek: 1 }), now), /1 of 3 used/);
    assert.match(renderProposalState(state({ usedThisWeek: 3 }), now), /all 3 used\. Draw no suggestion card you weren't asked for/);
    const p = renderProposalState(state({ dismissed: [dismissed({}), dismissed({ id: 2, title: 'Old', reason: 'already_done' })] }), now);
    assert.match(p, /never suggest these again unless they ask:\n- Add your website \(disagree\)/);
    assert.ok(!p.includes('Old'), 'already done holds nothing, so is not listed');
    assert.match(renderProposalState(null), /unknown right now/);
});

test('cards carry "asked", and the prompt says when to set it', () => {
    const c = mentorCardFromUiElement({ type: 'mentor_products', why: 'Empty', asked: true, products: [{ name: 'Groom' }] }, 50);
    assert.ok(c && !('error' in c) && c.type === 'mentor_products' && c.asked === true);
    const v = mentorCardFromUiElement({ type: 'mentor_business_profile', why: 'Empty', asked: 'yes', fields: { industry: 'Pets' } }, 50);
    assert.ok(v && !('error' in v) && v.type === 'mentor_business_profile' && v.asked === false, 'only literal true counts');
    assert.match(mentorCardsPromptBlock(), /Set "asked": true ONLY when the user's latest message asked for exactly this change/);
});

test('the chat route gates a suggestion before recording it, and the card carries its id', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    const gate = o.indexOf("const gate = await gateMentorSuggestion(db, orgId, { kind, fields: proposalFields(m), asked: 'asked' in m ? m.asked : false, title:");
    const record = o.indexOf('const proposalId = await recordMentorProposal(', gate);
    assert.ok(gate > 0 && record > gate, 'gate first');
    assert.match(o.slice(gate, record), /if \(!gate\.ok\) \{\s*\n\s*uiElement = null;/);
    assert.match(o.slice(record, record + 300), /uiElement = \{ \.\.\.filled, proposalId \};/);
    assert.match(read('src/utils/mentor-snapshot.ts'), /\[renderMentorSnapshot\(data\), renderProposalState\(proposals\), \.\.\.extra\]\.join\('\\n'\)/);
});

const base: MentorSnapshotData = {
    business: { description: 'Dog grooming', industry: null, website: null },
    products: [], productCount: 0, offerKinds: null, introOfferAnswered: false, team: [], goals: [],
    plan: { status: 'active', freeSlots: 1 },
};

test('the set-up checklist and the prompt\'s gaps are one list', () => {
    const list = setupChecklist(base);
    assert.deepStrictEqual(list.map((i) => i.key), ['description', 'products', 'offer', 'website', 'industry', 'intro_offer']);
    assert.deepStrictEqual(list.filter((i) => !i.done).map((i) => i.gap), businessGaps(base));
    assert.ok(list.find((i) => i.key === 'description')!.done);
    assert.ok(list.every((i) => ['profile', 'products'].includes(i.tab) && i.why.length > 10));
    assert.strictEqual(list.find((i) => i.key === 'intro_offer')!.optional, true);
});

test('"What I can see" comes from the inventory: everything it reads, and the secrets it never does', () => {
    const always = Object.entries(MENTOR_DATA_INVENTORY).filter(([, e]) => e.access === 'always');
    assert.deepStrictEqual(always.filter(([, e]) => !e.shown).map(([t]) => t), [], 'every table it reads must be said on the panel');
    for (const t of ['vault_secrets', 'audience_contacts', 'lead_messages', 'login_events', 'payments']) {
        assert.ok(MENTOR_DATA_INVENTORY[t].shown, `${t} named under Never sees`);
    }
    const v = mentorVisibility();
    assert.ok(v.sees.includes(MENTOR_DATA_INVENTORY.goals.shown!));
    assert.ok(v.never.some((x) => /other workspace/.test(x)) && v.never.some((x) => /other assistants/.test(x)));
    const p = mentorVisibilityPromptBlock();
    for (const x of [...v.sees, ...v.never]) assert.ok(p.includes(x), x);
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /\$\{mentorVisibilityPromptBlock\(\)\}/);
});

test('one server action: the card and the Overview tab both call mentor.ts (§14)', () => {
    const fn = read('netlify/functions/mentor.ts');
    assert.match(fn, /requireTenant\(event, db\)/);
    assert.match(fn, /decideProposal\(db, orgId, ctx\.userId, id, decision/);
    assert.match(fn, /bringBackProposal\(db, orgId, id\)/);
    assert.match(fn, /checklist: setupChecklist\(data\)/);
    assert.match(fn, /visibility: mentorVisibility\(\)/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /new CustomEvent\('mentor:decide'/);
    for (const r of ['not_relevant', 'already_done', 'disagree', 'not_now']) assert.ok(reg.includes(`['${r}',`), r);
    assert.match(reg, /if \(suggestion\) decide\('accepted'\);/, 'accepted only after the click saved');
    const sess = read('src/components/chat-session.js');
    assert.match(sess, /async function onMentorDecide\(e\) \{\s*\n\s*if \(mentorAlreadyHandled\(e\)\) return;/);
    assert.match(sess.slice(sess.indexOf('async function onMentorDecide'), sess.indexOf('async function onMentorDecide') + 300), /A\.decide\(d\.proposalId, d\.decision, d\.reason\)/);
    assert.match(read('src/components/mentor-apply.js'), /post\('\/\.netlify\/functions\/mentor', \{ action: 'decide', proposalId, decision, reason \}\)/);
    const tab = read('src/components/assistant-mentor-overview.js');
    assert.match(tab, /const API = '\/\.netlify\/functions\/mentor';/);
    assert.match(tab, /action: 'bring_back'/);
    assert.match(tab, /\['mentor:changed', 'bizinfo:profileChanged', 'bizinfo:productsChanged', 'assistant:settingsChanged'\]/);
});

test('the decision is org-scoped and can\'t reopen an answered suggestion', () => {
    const src = read('src/utils/mentor-proposals.ts');
    const decide = src.slice(src.indexOf('export async function decideProposal'), src.indexOf('export async function bringBackProposal'));
    assert.match(decide, /eq\(mentorProposals\.organisationId, orgId\)/);
    assert.match(decide, /decision === 'accepted' \? \['shown', 'dismissed'\] : \['shown'\]/);
    const back = src.slice(src.indexOf('export async function bringBackProposal'));
    assert.match(back, /eq\(mentorProposals\.organisationId, orgId\), eq\(mentorProposals\.status, 'dismissed'\)/);
});

test('the Overview tab exists on the page, and the prompt names it and its panels as labelled', () => {
    const html = read('assistant-detail.html');
    assert.match(html, /id="maintab-btn-mentor" data-maintab="mentor"/);
    assert.match(html, /<div id="maintab-mentor" role="tabpanel"[^>]*>\s*<div id="mentor-overview-host"><\/div>/);
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-mentor-overview\.js"><\/script>/);
    const registry = read('src/components/assistant-dashboard-registry.js');
    const entry = registry.slice(registry.indexOf('    business_mentor: {'), registry.indexOf('    mystery_shopper: {'));
    assert.match(entry, /mentorTab: \{\s*\n\s*label: 'Overview',/);
    assert.match(entry, /defaultMainTab: 'mentor'/);
    const js = read('assistants.js');
    assert.match(js, /window\.AssistantMentorOverview\?\.init\(\{ assistantId: data\.id, assistantName: data\.name \}\)/);
    assert.match(js, /if \(name === 'mentor'\) window\.AssistantMentorOverview\?\.activate\(\);/);

    const o = read('netlify/functions/chat-orchestrator.ts');
    const surfaces = o.slice(o.indexOf('function businessMentorSurfaces'), o.indexOf('function mysteryShopperSurfaces'));
    const tab = read('src/components/assistant-mentor-overview.js');
    assert.ok(surfaces.includes('"Overview" tab'));
    for (const name of ['Set-up checklist', 'What I can see', 'Suggestions this week', 'Bring back']) {
        assert.ok(surfaces.includes(`"${name}"`), `prompt names ${name}`);
        assert.ok(tab.includes(name), `page shows ${name}`);
    }
    assert.ok(surfaces.includes('"Dismissed suggestions"') && tab.includes('Dismissed suggestions ('));
    // The Set-up checklist collapses; the choice is saved on the summary click, never on `toggle`
    // (an open render fires toggle too, saving a choice nobody made).
    assert.ok(tab.includes('<details data-mentor-checklist'), 'checklist is collapsible');
    assert.ok(tab.includes("closest('[data-mentor-checklist] > summary')"), 'choice saved on summary click');
    assert.ok(!tab.includes("addEventListener('toggle'"), 'not on toggle');
    for (const r of ['Not relevant', 'Already done', 'Disagree', 'Not now']) assert.ok(surfaces.includes(`"${r}"`), r);
    assert.ok(surfaces.includes('"Dismiss…"') && read('src/components/disruptive-ui-registry.js').includes('>Dismiss…</button>'));
});

test('Admin ▸ Assistants ▸ Business Mentor ▸ Activity: the four success measures', () => {
    const row = (over: Partial<MentorActivityRow>): MentorActivityRow => ({
        organisationId: 1, workspace: 'A', metAt: null, shown: 0, accepted: 0, dismissed: 0, reasons: {}, gapsClosed: 0, supportRaised: 0, retained30: null, ...over,
    });
    const m = summariseMentorActivity([
        row({ shown: 6, accepted: 4, gapsClosed: 3, retained30: true }),
        row({ organisationId: 2, shown: 5, accepted: 2, gapsClosed: 1, retained30: false }),
        row({ organisationId: 3, retained30: null }),
    ]);
    assert.deepStrictEqual(m.acceptance, { accepted: 6, shown: 11, rate: 6 / 11 });
    assert.strictEqual(m.gapsClosed, 4);
    assert.strictEqual(m.goalsMoved, null, 'Phase 3');
    assert.deepStrictEqual(m.retention, { retained: 1, eligible: 2 }, 'too-recent workspaces are not judged');
    assert.strictEqual(summariseMentorActivity([]).acceptance.rate, null);
    assert.strictEqual(topReason({ not_now: 1, disagree: 2 }), 'disagree');
    assert.strictEqual(topReason({}), null);
    const admin = read('admin.html');
    assert.match(admin, /data-tab="mentor-activity" onclick="aaTab\('mentor-activity'\)">Activity<\/button>/);
    assert.match(admin, /else if \(tab === 'mentor-activity'\) aaRenderMentorActivity\(\);/);
    for (const q of ['Is the advice any good?', 'Is it getting people set up?', 'Does it make a difference?', 'Does it keep people?']) assert.ok(admin.includes(q), q);
    assert.match(read('netlify/functions/admin-assistants.ts'), /q\.mentorActivity === '1'[\s\S]{0,200}loadMentorActivity\(db\)/);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
