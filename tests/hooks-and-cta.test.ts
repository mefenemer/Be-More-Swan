// tests/hooks-and-cta.test.ts
// Hooks everywhere + a call-to-action setting (owner, 2026-10-24): one shared list of openings for
// social posts, articles, emails and cold outreach; and each Social, Blog or Email assistant's call to
// action can be its own words, the workspace's intro offer, or a sign-up form's free download.
// Run:  npx tsx tests/hooks-and-cta.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    blogOpeningBlock, emailOpeningBlock, LONG_FORM_OPENINGS, longFormOpeningFor, OUTREACH_OPENING_RULE,
    SOCIAL_HOOK_STYLES, socialHookFor,
} from '../src/config/hook-styles';
import { CTA_KINDS, CTA_LABELS, ctaBriefLine, describeCta } from '../src/config/call-to-action';
import { outreachFirstEmailBlock } from '../src/config/outreach-offer';
import { ctaChoiceFromContext } from '../src/utils/call-to-action';
import { ctaCardFrom, renderCtaChatBlock, roleHasCta } from '../src/utils/chat-call-to-action';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('social keeps exactly its seven hooks, chosen by the hour as before', () => {
    assert.strictEqual(SOCIAL_HOOK_STYLES.length, 7, '7 is prime and coprime with 24 and 11 — an 8th would alias');
    const t = Date.UTC(2026, 9, 24, 9);
    assert.strictEqual(socialHookFor(new Date(t)), SOCIAL_HOOK_STYLES[Math.floor(t / 3_600_000) % 7]);
    assert.strictEqual(socialHookFor(null), null);
    // A daily 9am slot still cycles through all seven.
    const seen = new Set(Array.from({ length: 7 }, (_, d) => socialHookFor(new Date(t + d * 86_400_000))));
    assert.strictEqual(seen.size, 7);
    const jobs = read('netlify/functions/process-content-jobs.ts');
    assert.ok(jobs.includes('const hookStyle = socialHookFor(job.target_publish_date);') && !jobs.includes('const HOOK_STYLES = ['));
});

check('articles and emails rotate through a longer list, one step per piece', () => {
    assert.ok(LONG_FORM_OPENINGS.length > SOCIAL_HOOK_STYLES.length);
    const nine = new Set(Array.from({ length: LONG_FORM_OPENINGS.length }, (_, i) => longFormOpeningFor(i)));
    assert.strictEqual(nine.size, LONG_FORM_OPENINGS.length);
    assert.notStrictEqual(blogOpeningBlock(0), blogOpeningBlock(1));
    assert.ok(blogOpeningBlock(3).includes('Never open with a definition'));
    const e = emailOpeningBlock(4);
    assert.ok(e.includes('the subject line') && e.includes('the first line opens with'));
    assert.ok(read('src/utils/blog-generate.ts').includes('`${blogOpeningBlock(sequence)}\\n` +'));
    const nl = read('src/utils/newsletter-generate.ts');
    assert.ok(nl.includes('`${emailOpeningBlock(sequence)}\\n\\n` +') && nl.includes('sql`${newsletterIssues.id} < ${issue.id}`'));
});

check('cold outreach gets its own openings — and never an invented detail', () => {
    assert.ok(outreachFirstEmailBlock(null).includes(OUTREACH_OPENING_RULE));
    assert.ok(OUTREACH_OPENING_RULE.includes('use them in turn') && OUTREACH_OPENING_RULE.includes('never invent one'));
});

check('a blank setting is "own" — every assistant behaves exactly as before', () => {
    assert.deepStrictEqual(ctaChoiceFromContext({}), { kind: 'own', formId: null });
    assert.deepStrictEqual(ctaChoiceFromContext({ ctaOffer: 'gift', ctaOfferFormId: '4' }), { kind: 'gift', formId: 4 });
    assert.deepStrictEqual(ctaChoiceFromContext({ ctaOffer: 'nope' }), { kind: 'own', formId: null });
    for (const s of ['social', 'blog', 'email'] as const) {
        assert.strictEqual(ctaBriefLine({ kind: 'own' }, s), '');
        assert.strictEqual(ctaBriefLine(null, s), '');
    }
    // Social falls back to its own "Call to action" answer when the setting is 'own'.
    assert.ok(read('netlify/functions/process-content-jobs.ts').includes("const ctaLine         = ctaOfferLine || (answers['cta'] ? `Call to action, for the posts that ask for something"));
});

check('the offer is stated exactly, with its real link, and social only asks now and then', () => {
    const intro = { kind: 'intro_offer' as const, summary: 'A free 14-day trial, no card needed up front.', url: 'https://x.test/start' };
    const line = ctaBriefLine(intro, 'email');
    assert.ok(line.includes('stated exactly: A free 14-day trial') && line.includes('Link: https://x.test/start') && line.includes('add no deadline'));
    assert.ok(ctaBriefLine(intro, 'social').includes('not every post'));
    const gift = { kind: 'gift' as const, formId: 3, formName: 'Guide', giftLabel: 'Care Guide', url: null };
    assert.ok(ctaBriefLine(gift, 'blog').includes('free "Care Guide"') && ctaBriefLine(gift, 'blog').includes('there is no link'));
    assert.match(describeCta(gift), /Care Guide/);
});

check('the link travels in the BRIEF, so the blog and email link checks keep it', () => {
    const blog = read('src/utils/blog-generate.ts');
    const briefStart = blog.indexOf('const brief = [');
    assert.ok(blog.indexOf("ctaBriefLine(await loadCtaForAssistant(db, organisationId, post.assistantId), 'blog')") > briefStart);
    assert.ok(blog.indexOf("ctaBriefLine(await loadCtaForAssistant(db, organisationId, post.assistantId), 'blog')") < blog.indexOf('].filter(Boolean).join', briefStart));
    const nl = read('src/utils/newsletter-generate.ts');
    assert.ok(nl.includes("ctaBriefLine(await loadCtaForAssistant(db, organisationId, issue.assistantId), 'email')"));
    // Never on an incident or a policy notice.
    assert.ok(nl.includes("new Set(['newsletter', 'announcement', 'offer', 'product_update'])"));
});

check('GUI and chat save through ONE path, naming the same choices', () => {
    const ep = read('netlify/functions/org-products.ts');
    assert.ok(ep.includes('await saveCta(db, orgId, body.callToAction') && ep.includes('callsToAction: { assistants: ctaAssistants, giftForms }'));
    const html = read('assets.html');
    assert.ok(html.includes("call('PATCH', { callToAction: { assistantId: id, kind, formId } })") && html.includes('id="op-cta"'));
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('call_to_action', renderCallToActionCard)"));
    const chat = read('src/components/chat-session.js');
    assert.ok(chat.includes("addEventListener('cta:change', onCallToAction)") && chat.includes("removeEventListener('cta:change', onCallToAction)") && chat.includes('callToAction: { assistantId, kind: d.kind'));
    for (const k of CTA_KINDS) assert.ok(html.includes(`${k}: '${CTA_LABELS[k]}'`), `tab ${k}`);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('buildCtaChatBlock(db, orgId, session.aiAssistantId, assistantRow.roleKey)') && orch.includes('?? outreachOfferCard ?? followUpPlanCard ?? ctaCard'));
});

check('the chat card is only for content roles, and rebuilt against real forms', () => {
    assert.ok(roleHasCta('blog_writer') && roleHasCta('newsletter_editor') && roleHasCta('social_media_manager'));
    assert.ok(!roleHasCta('lead_qualifier') && !roleHasCta(null));
    const forms = [{ id: 3, name: 'Guide', giftLabel: 'Care Guide', linkable: true }];
    assert.strictEqual(ctaCardFrom({ type: 'other' }, forms), null);
    assert.ok('error' in (ctaCardFrom({ type: 'call_to_action', kind: 'gift', formId: 9 }, forms) as object));
    assert.ok('error' in (ctaCardFrom({ type: 'call_to_action', kind: 'bogus' }, forms) as object));
    assert.deepStrictEqual(ctaCardFrom({ type: 'call_to_action', kind: 'gift', formId: 3 }, forms),
        { type: 'call_to_action', summary: null, kind: 'gift', kindLabel: CTA_LABELS.gift, formId: 3, formName: 'Guide', giftLabel: 'Care Guide' });
    assert.ok(renderCtaChatBlock('its own', forms).includes('formId 3') && renderCtaChatBlock('its own', []).includes('none yet'));
});

console.log(`\n${passed} passed`);
