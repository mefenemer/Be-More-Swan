// tests/prompt-audit-blog-leads-site.test.ts
// Prompt audit, 2026-10-25 — Blog, Lead Generator outreach and Website (owner: "assistants need to
// be experts in their role"). Graded live drafts for three businesses (a physio, a bookkeeper, a
// florist), before and after. Before: a "true story" blog invented a client's quote with a "he",
// "ninety percent of our clients" and a three-year history; a Making Tax Digital article gave wrong
// thresholds and deadlines; a physio guide promised "stronger than before"; half the cold emails ran
// past 75 words, asked twice, swapped the chosen offer for another product, asked for "a chat" and
// claimed things about the sender nobody had said; every drafted website invented reply times,
// free quotes, online booking and delivery, and carried a testimonials section of [placeholders].
// These pin the rules that fixed them.
// Run:  npx tsx tests/prompt-audit-blog-leads-site.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BLOG_CRAFT } from '../src/constants/blog-craft';
import { SITE_COPY_CRAFT } from '../src/constants/site-copy-craft';
import { OUTREACH_FIRST_EMAIL_RULES, outreachFirstEmailBlock } from '../src/config/outreach-offer';
import { articleTypeByKey } from '../src/utils/content-shapes';
import { buildBlogSystemPrompt } from '../src/utils/blog-generate';
import { buildDraftPrompt } from '../src/utils/site-draft';
import { buildFillPrompt } from '../src/utils/site-template-fill';
import { promptLayersFor } from '../src/config/assistant-prompt-layers';
import { OUTREACH_OPENINGS } from '../src/config/hook-styles';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('blog craft: no invented stories, history or figures, and no tax or health figures from memory', () => {
    for (const s of ['NO INVENTED STORIES, PEOPLE OR QUOTES', 'NO INVENTED HISTORY OR FIGURES', '"three years ago"',
        'TAX, LEGAL, BENEFITS AND HEALTH RULES', 'GOV.UK', 'Never promise an outcome', 'a "he" or "she"',
        'in the present tense', 'never an "In conclusion…" recap', 'under about 65 characters'])
        assert.ok(BLOG_CRAFT.includes(s), s);
});

check('the blog system prompt carries the craft, after the type and opening and before the layout', () => {
    const p = buildBlogSystemPrompt({
        dateBlock: 'DATE', businessName: 'Ledger & Lane', tone: 'warm', voiceSettings: undefined, assistantPrompt: '',
        articleType: articleTypeByKey('story')!, sequence: 0, guardrailsBlock: null, inspoBlock: null,
    });
    const type = p.indexOf('ARTICLE TYPE for THIS post'), craft = p.indexOf('BLOG CRAFT —'), layout = p.indexOf('LAYOUT\n');
    assert.ok(p.startsWith('DATE') && type > 0 && craft > type && layout > craft, 'order: date → type → craft → layout');
    assert.ok(p.includes('for Ledger & Lane'));
    // The drafter really uses the builder.
    assert.ok(read('src/utils/blog-generate.ts').includes('system: buildBlogSystemPrompt({'));
});

check('story and behind-the-scenes articles cannot be met by inventing a history', () => {
    assert.ok(articleTypeByKey('story')!.brief.includes('rather than inventing a history'));
    assert.ok(articleTypeByKey('behind_scenes')!.brief.includes('never invent a step, a tool, a timeline or a client'));
});

check('cold email: one question, no invented claims about us, no "a chat", no first initials', () => {
    for (const s of ['ONE question', 'ask no other question anywhere', 'Say nothing about us that the business',
        '"a chat"', 'Never a first initial', 'not past work', 'venues tell us…'])
        assert.ok(OUTREACH_FIRST_EMAIL_RULES.includes(s), s);
});

check('a gift or intro offer: the permission question is the last line, and the offer is never swapped', () => {
    const gift = outreachFirstEmailBlock({ kind: 'gift', formId: 1, formName: 'F', giftLabel: 'MTD checklist', linkable: true });
    assert.ok(gift.includes("IS the email's one question and its last line"));
    const intro = outreachFirstEmailBlock({ kind: 'intro_offer', summary: 'A free first week, no card needed.', url: null });
    assert.ok(intro.includes('Offer THIS and nothing else') && intro.includes('add no other question after it'));
});

check('every outreach JSON shape repeats the word limit where the model writes the body', () => {
    assert.strictEqual(read('src/lib/discovery-scoring.ts').match(/"body": "<UNDER 75 WORDS, following the FIRST-EMAIL RULES/g)?.length, 2, 'scoring and re-scoring');
    const lg = read('netlify/functions/lead-generation.ts');
    assert.ok(lg.includes('"body": "<UNDER 75 WORDS, following the FIRST-EMAIL RULES') && lg.includes('"body": "<email body, UNDER 75 WORDS>"'));
});

check('website copy: promises and policies are facts, no slogans, no placeholder testimonials', () => {
    for (const s of ['PROMISES AND POLICIES ARE FACTS TOO', '"within one working day"', '"no obligation"', 'whether a referral is needed',
        'is a slogan, not a headline', "Don't add a testimonials section", 'never a question written only to hold one', '"back to full health"'])
        assert.ok(SITE_COPY_CRAFT.includes(s), s);
});

const BRIEF = {
    business: { name: 'Hollin Physio', industry: null, description: null, audience: null, websiteUrl: null, email: null },
    productsBlock: null, rulesBlock: null, goal: null, pagesWanted: null, style: null, request: null, maxPages: 3,
};

check('the whole-site draft and the template fill both carry the website craft', () => {
    const d = buildDraftPrompt(BRIEF).user;
    assert.ok(d.includes('WEBSITE COPY —'));
    // It no longer suggests a testimonials section of placeholders.
    assert.ok(!d.includes("[A customer's words]"));
    const f = buildFillPrompt(BRIEF, { theme: {}, settings: {}, nav: [], pages: [], footer: {} } as never).user;
    assert.ok(f.includes('WEBSITE COPY —') && f.includes("A template's own promises"));
});

check('the Website Assistant chat edits the site under the same craft', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    const site = orch.indexOf('website_assistant: {');
    const craft = orch.indexOf('${SITE_COPY_CRAFT}', site);
    assert.ok(site > 0 && craft > site && craft < orch.indexOf('CHANGING THE SITE.', site), 'in the FACTS part of the website prompt');
});

check('Admin ▸ Assistants ▸ Model & rules shows the new blocks', () => {
    assert.ok(promptLayersFor('blog_writer').some((l) => l.key === 'blog_craft' && l.text === BLOG_CRAFT));
    assert.ok(promptLayersFor('website_assistant').some((l) => l.key === 'site_copy' && l.text === SITE_COPY_CRAFT));
    assert.ok(promptLayersFor('lead_qualifier').some((l) => l.key === 'first_email' && l.text === OUTREACH_FIRST_EMAIL_RULES));
});

check('no cold-email opening asks a question, because the email has exactly one and it comes last', () => {
    // Opus 5.5, 2026-10-25: the old "a genuine question about how they handle that problem" opening
    // made 3 emails in 9 ask twice once the one-question rule landed.
    for (const o of OUTREACH_OPENINGS) assert.ok(!/^a genuine question/.test(o), o);
    assert.ok(OUTREACH_OPENINGS.some((o) => o.includes("the email's one question comes at the end")));
});

check('bulk scoring, the classifier and the deep re-score run on the Lead Generator\'s chosen model', () => {
    const ds = read('src/lib/discovery-scoring.ts');
    // Both prospect-facing calls go through the picker, held at low thinking (a short-limit worker
    // and a 26-second request); every reply is read with replyText, never content[0].
    assert.strictEqual(ds.match(/withRoleModel\(/g)?.length, 3, 'scoring, the classifier and the re-score');
    assert.strictEqual(ds.match(/\{ requestPath: true, label: '(discovery-scoring|classifyProspects|rescoreWithIntel)' \}/g)?.length, 3);
    assert.ok(!/anthropic\.messages\.create\(\{/.test(ds), 'no call skips adaptForModel');
    assert.ok(!ds.includes('content[0]'));
    assert.ok(ds.includes('searchContext, modelChoice, depth + 1)'), 'the blank-card retry keeps the model');
    const worker = read('netlify/functions/process-discovery-jobs.ts');
    assert.ok(worker.includes("await loadRoleModel(db, 'lead_qualifier'))") && worker.includes('model: scored.model,'));
    const enrich = read('src/utils/lead-enrichment.ts');
    assert.ok(enrich.includes("modelChoice: await loadRoleModel(db, 'lead_qualifier')") && enrich.includes('model: rescored.model,'));
    assert.ok(read('scripts/rescore-lead-prospect-type.ts').includes("classifyProspects(candidates, icp, sender, await loadRoleModel(db, 'lead_qualifier'))"));
});

console.log(`\n${passed} passed`);
