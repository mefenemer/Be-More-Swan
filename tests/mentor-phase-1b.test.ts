// tests/mentor-phase-1b.test.ts
// Business Mentor Phase 1b (docs/business-mentor-plan.md §3.0a right column):
//
//   1. New-user opening: "established business or new idea?" asked by a card that saves businessStage.
//   2. Set-up field card (§3.4): every set-up question is changeable or excluded with a reason (the
//      coverage list); values are checked against the role's schema; only the changed key is sent and
//      merged on the server; ACTIVE assistants only; any route for its own answers, the Mentor for all.
//   3. Who to hire next (§3.5): Live roles only, never one already hired, reasons from the workspace,
//      the plan's limit respected; the card, the "Recommended next" panel and the catalogue badge read
//      one function.
//   4. Feedback on the user's own draft (§3.6): one craft for chat and the "Get feedback" box.
//   5. Review all (§3.13): chat, the Overview tab and Inbox "Needs you" share one component; nothing
//      pre-ticked; each applied through its own card's action; failures reported one by one.
//
// Run:  npx tsx tests/mentor-phase-1b.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import schemas from '../src/public/assistant-onboarding-schemas.js';
import {
    OWN_CARD_PATCH_KEYS, SETUP_FIELD_EXCLUDED, SOCIAL_WIZARD_EXCLUDED, SOCIAL_WIZARD_FIELDS, allSetupFields, changeableSetupFields,
    displaySetupValue, exclusionReason, setupFieldDef, validateSetupValue,
} from '../src/utils/setup-field';
import { applySetupPatch, assistantSetupFieldBlock, resolveSetupFieldProposal, setupFieldRequestFromUiElement } from '../src/utils/chat-setup-field';
import { recommendHires, renderHireRecommendation } from '../src/utils/mentor-hire';
import { renderMentorSnapshot, type MentorSnapshotData } from '../src/utils/mentor-snapshot';
import { MENTOR_CARD_TYPES, mentorCardFromUiElement, mentorCardsPromptBlock, proposalKind } from '../src/utils/mentor-cards';
import { dedupeOpen, REVIEWABLE_KINDS } from '../src/utils/mentor-proposals';
import { checkDraftText, feedbackContext, feedbackSystemPrompt } from '../src/utils/mentor-feedback';
import { MENTOR_FEEDBACK_CRAFT } from '../src/constants/mentor-craft';
import { SMM_ROLE_KEY } from '../src/constants/roles';

let passed = 0, total = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
    total++;
    pending.push(Promise.resolve().then(fn).then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); },
    ));
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('Business Mentor Phase 1b');

// ── 2. Set-up field card ────────────────────────────────────────────────────────────────────────

test('coverage: every set-up question is changeable by the card or excluded with a reason', () => {
    const roles = Object.keys(schemas);
    assert.ok(roles.length >= 10, 'schemas loaded on the server');
    let changeable = 0;
    for (const role of [...roles, SMM_ROLE_KEY]) {
        for (const f of allSetupFields(role)) {
            const reason = exclusionReason(role, f.key);
            const def = setupFieldDef(role, f.key);
            assert.ok(!!def !== !!reason, `${role}.${f.key}: exactly one of changeable / excluded`);
            if (reason) assert.ok(reason.length > 20, `${role}.${f.key}: a real reason`);
            if (def) changeable++;
            assert.ok(['text', 'textarea', 'radio', 'dropdown', 'number'].includes(f.type), `${role}.${f.key}: a type the card can check (${f.type})`);
        }
    }
    assert.ok(changeable >= 30, `most questions are changeable (${changeable})`);
});

test('coverage: no exclusion names a question that doesn\'t exist', () => {
    for (const [role, keys] of Object.entries(SETUP_FIELD_EXCLUDED)) {
        const real = allSetupFields(role).map((f) => f.key);
        for (const k of Object.keys(keys)) assert.ok(real.includes(k), `${role}.${k} is excluded but isn't a question`);
    }
    for (const [role, keys] of Object.entries(OWN_CARD_PATCH_KEYS)) {
        for (const k of keys) assert.ok(SETUP_FIELD_EXCLUDED[role]?.[k], `${role}.${k} has its own card, so is excluded from the generic one`);
    }
});

test('coverage: the Social wizard\'s answers are listed separately, every one of them', () => {
    const html = read('onboarding-social-media.html');
    const block = (start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
    const keysIn = (src: string) => [...src.matchAll(/^\s{6,8}([a-z_]+):/gm)].map((m) => m[1]);
    const ctx = keysIn(block('const structuredContext = {', '};'));
    const op = keysIn(block('function collectOperationalSetup() {', '\n  }'));
    const sched = ['posting_frequency', 'posting_days', 'posting_times', 'posting_timezone'];
    assert.ok(block('function collectPostingSchedule() {', '\n  }').includes('posting_timezone'));
    const all = [...new Set([...ctx, ...op, ...sched])];
    assert.ok(all.length >= 15, `found the wizard's keys (${all.length})`);
    const listed = new Set([...SOCIAL_WIZARD_FIELDS.map((f) => f.key), ...Object.keys(SOCIAL_WIZARD_EXCLUDED)]);
    assert.deepStrictEqual(all.filter((k) => !listed.has(k)), [], 'a Social wizard answer neither changeable nor excluded');
    assert.deepStrictEqual([...listed].filter((k) => !all.includes(k)), [], 'listed but not in the wizard');
});

test('values are checked against the question: options, numbers, required', () => {
    const tone = setupFieldDef('blog_writer', 'tone_of_voice')!;
    assert.deepStrictEqual(validateSetupValue(tone, 'Casual'), { ok: true, value: 'Casual' });
    assert.deepStrictEqual(validateSetupValue(tone, 'casual'), { ok: true, value: 'Casual' }, 'a label maps to its value');
    assert.ok(!validateSetupValue(tone, 'Sarcastic').ok);
    const head = setupFieldDef('lead_qualifier', 'minHeadcount')!;
    assert.deepStrictEqual(validateSetupValue(head, '12'), { ok: true, value: 12 });
    assert.ok(!validateSetupValue(head, 0).ok, 'below min');
    assert.ok(!validateSetupValue(head, 'lots').ok);
    const topics = setupFieldDef('blog_writer', 'blogTopics')!;
    assert.ok(!validateSetupValue(topics, '   ').ok, 'required can\'t be emptied');
    assert.ok(!validateSetupValue(topics, 'x'.repeat(201)).ok, 'too long');
    assert.strictEqual(displaySetupValue(setupFieldDef('campaign_orchestrator', 'capacityPosture')!, 'balanced').length > 3, true);
});

test('the write: only the patched keys, merged on the row; active only; excluded refused; own cards allowed', () => {
    const row = { roleKey: 'blog_writer', lifecycleStatus: 'working', provisioningStatus: 'complete', context: { blogTopics: 'Dogs', tone_of_voice: 'Casual', posting_frequency: 'Weekly' } };
    const ok = applySetupPatch(row, { tone_of_voice: 'Friendly' });
    assert.ok(ok.ok);
    assert.deepStrictEqual(ok.ok && ok.context, { blogTopics: 'Dogs', tone_of_voice: 'Friendly', posting_frequency: 'Weekly' });
    assert.ok(!applySetupPatch({ ...row, lifecycleStatus: 'paused' }, { tone_of_voice: 'Friendly' }).ok, 'paused');
    assert.ok(!applySetupPatch({ ...row, provisioningStatus: 'paused_quota' }, { tone_of_voice: 'Friendly' }).ok, 'paused for the task cap');
    assert.ok(!applySetupPatch(row, { posting_frequency: 'Daily' }).ok, 'excluded: the schedule card owns it');
    assert.ok(!applySetupPatch(row, { nonsense: 'x' }).ok);
    assert.ok(!applySetupPatch(row, {}).ok);
    const mentor = { roleKey: 'business_mentor', lifecycleStatus: 'working', provisioningStatus: 'complete', context: { quietMode: 'off' } };
    const q = applySetupPatch(mentor, { quietMode: 'on' });
    assert.ok(q.ok && q.context.quietMode === 'on', 'the quiet-mode card writes through the same patch');
    assert.ok(applySetupPatch(mentor, { businessStage: 'new_idea' }).ok);
    assert.ok(!applySetupPatch(mentor, { businessStage: 'maybe' }).ok);
});

test('update-assistant-context: patchContext is checked inside the save, on the row it just read', () => {
    const src = read('netlify/functions/update-assistant-context.ts');
    const tx = src.indexOf('await withTenant(orgId, async (tx) => {');
    const read_ = src.indexOf('const [existingAssistant] = await tx.select()', tx);
    const patch = src.indexOf('const patched = applySetupPatch(', read_);
    const update = src.indexOf('await tx.update(aiAssistants)', patch);
    assert.ok(tx > 0 && read_ > tx && patch > read_ && update > patch, 'read → check → write, in one transaction');
    assert.match(src, /if \(error\?\.message\?\.startsWith\('SETUP_PATCH'\)\) \{\s*\n\s*return \{ statusCode: 422/);
    assert.match(read('src/components/mentor-apply.js'), /patchContext: \{ \[key\]: value \}/);
});

/** A db stub: every select chain resolves to `rows`. */
function fakeDb(rows: unknown[]) {
    const chain: any = { from: () => chain, leftJoin: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows };
    return { select: () => chain };
}
const blogRow = { id: 7, name: 'Bea', roleKey: 'blog_writer', context: { tone_of_voice: 'Casual' }, lifecycleStatus: 'working', provisioningStatus: 'complete' };
const req = (over = {}) => ({ assistantId: 7, key: 'tone_of_voice', value: 'Friendly', summary: '', why: 'You said customers find it too casual.', asked: false, ...over });

test('the card is rebuilt from the row: real name, label and current answer', async () => {
    const card = await resolveSetupFieldProposal(fakeDb([blogRow]), 1, 50, req(), { allowOthers: true });
    assert.ok(!('error' in card), JSON.stringify(card));
    if ('error' in card) return;
    assert.strictEqual(card.assistantName, 'Bea');
    assert.strictEqual(card.currentLabel, 'Casual');
    assert.strictEqual(card.value, 'Friendly');
    assert.strictEqual(card.label, setupFieldDef('blog_writer', 'tone_of_voice')!.label);
    assert.match(card.summary, /Bea/);
});

test('the card refuses: another workspace, a paused assistant, an excluded or unknown key, no change, no reason', async () => {
    const err = async (db: any, r: any, allowOthers = true) => {
        const c = await resolveSetupFieldProposal(db, 1, 50, r, { allowOthers });
        assert.ok('error' in c, JSON.stringify(c));
        return (c as { error: string }).error;
    };
    assert.match(await err(fakeDb([]), req()), /isn't in this workspace/);
    assert.match(await err(fakeDb([{ ...blogRow, lifecycleStatus: 'paused' }]), req()), /isn't active/);
    assert.match(await err(fakeDb([{ ...blogRow, provisioningStatus: 'paused_payment' }]), req()), /isn't active/);
    assert.match(await err(fakeDb([blogRow]), req({ key: 'posting_frequency', value: 'Daily' })), /changed elsewhere/);
    assert.match(await err(fakeDb([blogRow]), req({ key: 'nope' })), /no set-up question/);
    assert.match(await err(fakeDb([blogRow]), req({ value: 'Casual' })), /already/);
    assert.match(await err(fakeDb([blogRow]), req({ why: '' })), /needs to say why/);
    assert.match(await err(fakeDb([blogRow]), req({ assistantId: null })), /which assistant/);
});

test('a route other than the Mentor can only change its own answers', async () => {
    let asked: unknown = null;
    const db: any = { select: () => { const c: any = { from: () => c, leftJoin: () => c, where: (w: unknown) => { asked = w; return c; }, limit: async () => [blogRow] }; return c; } };
    // The target is forced to the source assistant (50 here), whatever the model named.
    const card = await resolveSetupFieldProposal(db, 1, 7, req({ assistantId: 99 }), { allowOthers: false });
    assert.ok(!('error' in card) && asked);
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /resolveSetupFieldProposal\(db, orgId, session\.aiAssistantId, setupReq, \{ allowOthers: isMentor \}\)/);
    assert.match(o, /const setupFieldBlock = offersOwnCards \? assistantSetupFieldBlock\(assistantRow\.roleKey, session\.aiAssistantId, assistantRow\.onboardingContext\) : null;/);
    assert.match(o, /ctaCardBlock, scheduleBlock, setupFieldBlock, platformsBlock/);
    assert.match(o, /\?\? ctaCard \?\? setupFieldCard;/, 'the blog and email routes keep it (profileCard)');
    const block = assistantSetupFieldBlock('blog_writer', 7, { tone_of_voice: 'Casual' })!;
    assert.match(block, /"assistantId":7/);
    assert.match(block, /tone_of_voice — "Writing voice": now "Casual"/);
    assert.ok(!block.includes('posting_frequency'), 'excluded keys are not offered');
    assert.strictEqual(assistantSetupFieldBlock('nobody', 1, {}), null);
    assert.deepStrictEqual(setupFieldRequestFromUiElement({ type: 'setup_field_proposal', assistantId: '7', key: 'x', value: 1, reason: 'r' })?.why, 'r');
});

// ── Snapshot data for the Mentor ────────────────────────────────────────────────────────────────

const live = (roleKey: string, name: string) => ({ roleKey, name, description: `${name} does things.`, status: 'live' as const });
const base: MentorSnapshotData = {
    business: { description: 'Dog grooming in Leeds', industry: 'Pets', website: null },
    products: [{ name: 'Full groom', hasPrice: true }], productCount: 1, offerKinds: ['services'], introOfferAnswered: true,
    team: [], goals: [],
    plan: { status: 'active', freeSlots: 1 },
    catalogue: [
        live('social_media_manager', 'Social Media Assistant'), live('website_assistant', 'Website Assistant'),
        live('newsletter_editor', 'Email Marketing Assistant'), live('blog_writer', 'Blog Writer'),
        live('business_mentor', 'Business Mentor'), live('crm_enricher', 'CRM Enricher'),
        { roleKey: 'lead_qualifier', name: 'Lead Generator', description: '', status: 'coming_soon' },
    ],
};

test('the Mentor sees each active assistant\'s set-up answers, and only active ones', () => {
    const out = renderMentorSnapshot({ ...base, team: [
        { id: 7, name: 'Bea', role: 'Blog Writer', state: 'active', roleKey: 'blog_writer', setup: { blogTopics: 'Grooming tips' } },
        { id: 8, name: 'Sam', role: 'Social Media Assistant', state: 'paused_by_user', roleKey: 'social_media_manager', setup: { core_message: 'SECRET-PAUSED' } },
    ] });
    assert.match(out, /SET-UP ANSWERS OF ACTIVE ASSISTANTS/);
    assert.match(out, /- Bea \(Blog Writer, assistantId 7\):\n {2}- blogTopics — "Topics & themes": now "Grooming tips"/);
    assert.ok(!out.includes('SECRET-PAUSED'), 'a paused assistant\'s answers are not offered for change');
    assert.ok(!renderMentorSnapshot(base).includes('SET-UP ANSWERS'), 'no team, no team cards (§3.12)');
});

// ── 3. Who to hire next ─────────────────────────────────────────────────────────────────────────

test('hire: Live roles only, never the Mentor, never one already hired; at most 3; the gap first', () => {
    const r = recommendHires(base);
    const keys = r.picks.map((p) => p.roleKey);
    assert.ok(keys.length >= 1 && keys.length <= 3);
    assert.strictEqual(keys[0], 'website_assistant', 'no website address is the clearest gap');
    assert.ok(!keys.includes('business_mentor') && !keys.includes('lead_qualifier'), 'not the Mentor; not coming soon');
    assert.ok(r.picks.every((p) => p.reason.length > 20));
    assert.match(r.picks.find((p) => p.roleKey === 'social_media_manager')!.reason, /Full groom/, 'grounded in Products & Services');
    const hired = recommendHires({ ...base, team: [{ id: 3, name: 'Wes', role: 'Website Assistant', state: 'paused_by_user', roleKey: 'website_assistant' }] });
    assert.ok(!hired.picks.some((p) => p.roleKey === 'website_assistant'), 'paused still counts as on the team');
});

test('hire: an established team only gets a clear gap; with none, no card', () => {
    const team = [{ id: 3, name: 'Sam', role: 'Social', state: 'active' as const, roleKey: 'social_media_manager' }];
    const r = recommendHires({ ...base, business: { ...base.business, website: 'https://dogs.example' }, team, catalogue: [live('crm_enricher', 'CRM Enricher'), live('social_media_manager', 'Social')] });
    assert.deepStrictEqual(r.picks, [], 'CRM Enricher has no reason from this workspace');
    assert.match(renderHireRecommendation(r).join('\n'), /No clear gap/);
    const fresh = recommendHires({ ...base, catalogue: [live('crm_enricher', 'CRM Enricher')] });
    assert.strictEqual(fresh.picks[0]?.grounded, false, 'nobody hired yet: the catalogue\'s own words');
});

test('hire: respects the plan\'s assistant limit, naming the next plan', () => {
    const full = recommendHires({ ...base, team: [{ id: 3, name: 'Sam', role: 'Social', state: 'active', roleKey: 'social_media_manager' }], plan: { status: 'active', freeSlots: 0, nextPlanName: 'Business' } });
    assert.ok(full.capacity.needsUpgrade);
    assert.match(full.capacity.note, /needs the Business plan, or swapping one you have\. It's your call\./);
    const top = recommendHires({ ...base, team: [{ id: 3, name: 'Sam', role: 'Social', state: 'active', roleKey: 'social_media_manager' }], plan: { status: 'active', freeSlots: 0, nextPlanName: null } });
    assert.match(top.capacity.note, /swapping one you have/);
    assert.match(recommendHires(base).capacity.note, /1 free assistant slot, included in what you pay/);
    assert.match(recommendHires({ ...base, plan: { status: null, freeSlots: null } }).capacity.note, /need a plan/);
    assert.match(recommendHires(base).why, /^Based on your workspace: no assistants hired yet, no website address/);
    assert.match(read('netlify/functions/check-capacity.ts'), /await loadNextPlan\(db, \{ monthlyPriceGbp: plan\.monthlyPriceGbp, tierKey: plan\.tierKey \}, userCurrency\)/);
    assert.match(read('src/utils/mentor-snapshot.ts'), /await loadNextPlan\(db, \{ monthlyPriceGbp: planRow\.monthlyPriceGbp, tierKey: planRow\.tierKey \}\)/);
});

test('hire: the card, the "Recommended next" panel and the catalogue badge read one function', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /const rec = m\.type === 'mentor_hire_recommendation' \? recommendHires\(mentorParts!\.data\) : null;/);
    assert.match(o, /\{ \.\.\.m, why: rec\.why, picks: rec\.picks, capacity: rec\.capacity \}/, 'picks never from the model');
    const fn = read('netlify/functions/mentor.ts');
    assert.match(fn, /recommended: recommendHires\(data\)/);
    assert.match(fn, /only === 'recommended'[\s\S]{0,300}findMentor\(db, orgId\)[\s\S]{0,200}recommendHires\(/);
    assert.match(read('assistant-catalogue.html'), /fetch\('\/\.netlify\/functions\/mentor\?only=recommended'/);
    assert.match(read('assistant-catalogue.html'), />Recommended<\/div>/);
    assert.match(read('src/components/assistant-mentor-overview.js'), /Recommended next/);
    assert.match(renderMentorSnapshot(base), /WHO TO HIRE NEXT \(the same list as "Recommended next" on your Overview tab\):\n1\. Website Assistant/);
    assert.strictEqual(proposalKind({ type: 'mentor_hire_recommendation', summary: '', asked: false }), 'hire_recommendation');
});

// ── 1. New-user opening ─────────────────────────────────────────────────────────────────────────

test('the opening question is a card that saves businessStage, and stays editable on the profile', () => {
    const c = mentorCardFromUiElement({ type: 'mentor_business_stage', summary: 'Which is you?' }, 50);
    assert.deepStrictEqual(c, { type: 'mentor_business_stage', summary: 'Which is you?', assistantId: 50 });
    assert.strictEqual(proposalKind(c as any), null, 'a question, not a suggestion');
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /register\('mentor_business_stage'/);
    assert.ok(reg.includes(`data-mbs-stage="\${stage}"`) && reg.includes("choice('existing'") && reg.includes("choice('new_idea'"));
    assert.match(read('src/components/chat-session.js'), /A\.setupAnswer\(d\.assistantId, 'businessStage', d\.stage === 'new_idea' \? 'new_idea' : 'existing'\)/);
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /put the mentor_business_stage card \(card 5\) in "uiElement"/);
    assert.ok(allSetupFields('business_mentor').some((f) => f.key === 'businessStage'), 'a schema question, so the profile shows it');
});

test('the card list in the prompt covers every card type', () => {
    const p = mentorCardsPromptBlock();
    for (const t of [...MENTOR_CARD_TYPES, 'setup_field_proposal']) assert.ok(p.includes(`"type":"${t}"`), t);
    assert.match(p, /Never for a paused, unhired or archived assistant/);
    assert.match(p, /It hires nothing/);
});

// ── 4. Feedback ─────────────────────────────────────────────────────────────────────────────────

test('feedback: one craft for chat and the "Get feedback" box', () => {
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /\$\{MENTOR_CRAFT\}\n\n\$\{MENTOR_FEEDBACK_CRAFT\}/);
    const ctx = feedbackContext({ ...base, team: [
        { id: 7, name: 'Bea', role: 'Blog Writer', state: 'active' },
        { id: 8, name: 'Sam', role: 'Social', state: 'paused_by_user' },
    ] }, null, 'Pawfect');
    assert.match(ctx, /Who its customers are: not filled in yet/);
    assert.match(ctx, /Active assistants \(the only ones you may mention for a rewrite\): Bea \(Blog Writer\)$/m);
    assert.ok(!ctx.includes('Sam'), 'a paused assistant is never offered for a rewrite');
    assert.match(feedbackContext({ ...base, products: [], productCount: 0 }, 'Dog owners', null), /none listed — never state a product or price/);
    assert.ok(feedbackSystemPrompt(ctx).includes(MENTOR_FEEDBACK_CRAFT));
    assert.ok(!checkDraftText('too short').ok);
    assert.ok(!checkDraftText('x'.repeat(12_001)).ok);
    assert.ok(checkDraftText('Dear customer, our new grooming offer starts Monday.').ok);
});

test('feedback: the screen calls mentor.ts, metered as a helper, on the Mentor\'s model', () => {
    const fn = read('netlify/functions/mentor.ts');
    assert.match(fn, /body\.action === 'feedback'[\s\S]{0,120}mentorDraftFeedback\(db, orgId, ctx\.userId, body\.text\)/);
    const src = read('src/utils/mentor-feedback.ts');
    assert.match(src, /meterInteraction\(db, orgId, 'helpers'\)/);
    assert.match(src, /loadRoleModel\(db, MENTOR_ROLE_KEY\)/);
    assert.ok(src.indexOf('meterInteraction(') < src.indexOf('anthropic.messages.create'), 'metered before the model call');
    const tab = read('src/components/assistant-mentor-overview.js');
    assert.match(tab, /action: 'feedback', text: f\.text/);
    assert.match(tab, /<h2 class="text-base font-bold text-gray-900">Get feedback<\/h2>/);
    assert.match(read('netlify.toml'), /\[functions\.mentor\]\n {2}timeout = 26/);
});

// ── 5. Review all ───────────────────────────────────────────────────────────────────────────────

test('review all: one component in chat, the Overview tab and Inbox "Needs you"', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /register\('mentor_review_all'[\s\S]{0,800}window\.MentorReviewAll\.mount\(host\)/);
    assert.match(read('src/components/assistant-mentor-overview.js'), /data-mentor-review-all[\s\S]*window\.MentorReviewAll\?\.openDialog\(\)/);
    const notif = read('notifications.js');
    assert.match(notif, /fetch\('\/\.netlify\/functions\/mentor\?only=open'/);
    assert.match(notif, /window\.MentorReviewAll\?\.openDialog\(\)/);
    assert.match(notif, /const show = activeTab === 'needs' && mentorOpen > 0;/);
    assert.match(read('notifications.html'), /id="mentor-needs-strip"/);
    for (const page of ['workspace.html', 'assistant-chat.html']) {
        const h = read(page);
        assert.ok(h.includes('<script src="/src/components/mentor-apply.js"></script>') && h.includes('<script src="/src/components/mentor-review-all.js"></script>'), page);
    }
});

test('review all: nothing pre-ticked; each through its own action; failures one by one', () => {
    const src = read('src/components/mentor-review-all.js');
    assert.match(src, /ticked: new Set\(\)/, 'starts with nothing ticked');
    assert.match(src, /\$\{st\.ticked\.has\(it\.id\) && !done \? 'checked' : ''\}/, 'checked only when the user ticked it');
    assert.match(src, /await window\.MentorApply\.applyCard\(it\.card\);/);
    assert.match(src, /for \(const it of chosen\) \{\s*\n\s*try \{/, 'one at a time, each caught on its own');
    assert.match(src, /✗ Not saved: \$\{esc\(r\.error\)\}/);
    assert.match(src, /each one that failed says why above/);
    const apply = read('src/components/mentor-apply.js');
    const fn = apply.slice(apply.indexOf('async function applyCard'));
    for (const [type, call] of [['mentor_business_profile', 'businessProfile(card.fields)'], ['mentor_products', 'products(card.products)'], ['setup_field_proposal', 'setupAnswer(card.assistantId, card.key, card.value)']]) {
        assert.ok(fn.includes(`case '${type}': return ${call};`), type);
    }
    assert.deepStrictEqual([...REVIEWABLE_KINDS], ['business_info_gap', 'products_gap', 'setup_field']);
});

test('review all: the same gap suggested twice is one row', () => {
    const row = (id: number, kind: string, card: unknown) => ({ id, kind, title: `t${id}`, why: null, card, shownAt: null });
    const out = dedupeOpen([
        row(3, 'business_info_gap', { fields: { websiteUrl: 'a' } }),
        row(2, 'business_info_gap', { fields: { websiteUrl: 'b' } }),
        row(1, 'business_info_gap', { fields: { industry: 'c' } }),
        row(4, 'setup_field', { fields: { '7:tone_of_voice': 'x' } }),
    ]);
    assert.deepStrictEqual(out.map((r) => r.id), [3, 1, 4]);
});

// ── §14: every capability has a screen and a card; the prompt names the screens ───────────────

test('the prompt names the new screens exactly as the page labels them', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    const surfaces = o.slice(o.indexOf('function businessMentorSurfaces'), o.indexOf('function mysteryShopperSurfaces'));
    const tab = read('src/components/assistant-mentor-overview.js');
    for (const name of ['Suggestions waiting', 'Review all', 'Recommended next', 'See this assistant', 'Get feedback', 'Open a text file']) {
        assert.ok(surfaces.includes(`"${name}"`), `prompt names ${name}`);
        assert.ok(tab.includes(name), `page shows ${name}`);
    }
    assert.ok(surfaces.includes('"Needs you"') && read('notifications.html').includes('Needs you'));
    assert.ok(surfaces.includes('"Recommended" badge') && read('assistant-catalogue.html').includes('>Recommended</div>'));
    assert.ok(surfaces.includes('"Hire a New Assistant"') && read('assistant-catalogue.html').includes('Hire a New Assistant'));
    assert.ok(surfaces.includes('"Which describes you best?"') && read('src/public/assistant-onboarding-schemas.js').includes("label: 'Which describes you best?'"));
});

test('every new card has a renderer and a chat listener that destroy() removes', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    const sess = read('src/components/chat-session.js');
    for (const t of ['mentor_business_stage', 'setup_field_proposal', 'mentor_hire_recommendation', 'mentor_review_all']) assert.ok(reg.includes(`register('${t}'`), t);
    for (const [ev, h] of [['mentor:businessStage', 'onMentorBusinessStage'], ['setupField:apply', 'onSetupFieldApply']]) {
        assert.ok(sess.includes(`container.addEventListener('${ev}', ${h});`) && sess.includes(`container.removeEventListener('${ev}', ${h});`), ev);
    }
});

Promise.all(pending).then(() => {
    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
});
