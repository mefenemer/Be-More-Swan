// tests/prompt-audit-shopper-designer-campaign.test.ts
// Prompt audit, 2026-10-25 — Mystery Shopper, Brand Designer and Campaign Orchestrator (owner:
// "assistants need to be experts in their role", and "assistants can only connect with each other if
// the user has them active"). Graded live runs for three businesses on Opus 5.5 and each role's code
// default, before and after. Before: site-audit ideas briefed to assistants the workspace did not have,
// rewrites that invented "Book online" and "no hidden extras" and promised "pain-free", two rewrites of
// the same headline; image prompts carrying hex codes and card "headlines" that described the picture;
// a campaign measured in "leads" with no lead search, and paused assistants offered as orders.
// Run:  npx tsx tests/prompt-audit-shopper-designer-campaign.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SITE_AUDIT_CRAFT } from '../src/constants/site-audit-craft';
import { ART_DIRECTION_CRAFT } from '../src/constants/art-direction-craft';
import { CAMPAIGN_PLANNING_CRAFT } from '../src/constants/campaign-craft';
import { buildLensPrompt, buildSummaryPrompt, handoffTargetsLine, sanitiseSummary } from '../src/utils/site-audit-prompts';
import { oneFixPerText } from '../src/utils/site-audit';
import { extractSitePage } from '../src/utils/site-extract';
import { artDirectionSystemPrompt, artDirectionUserPrompt, colourWords, fallbackArtDirection, parseArtDirection, withoutColourCodes } from '../src/utils/visual-briefs';
import { normalizeBrandKit } from '../src/utils/brand-kit';
import { normaliseGuidelines } from '../src/utils/brand-guidelines';
import { briefableOrdersLine, withoutInactiveOrders } from '../src/utils/campaign-plan';
import { promptLayersFor } from '../src/config/assistant-prompt-layers';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── Mystery Shopper ──────────────────────────────────────────────────────────────────────────────

const PAGE = extractSitePage(`<html><head><title>X</title></head><body><h1>Welcome to Hollin Physio</h1>
<p>${'We help people in Leeds with injuries and aches of all kinds, from runners to desk workers. '.repeat(12)}</p>
<a href="/contact">Contact us</a></body></html>`, 'https://x.example/');
const BRIEF = { url: 'https://x.example/', icp: 'Runners', conversionGoal: 'Book', productsBlock: null };
const SCORE = { overall: 40, lenses: { clarity: { score: 30 }, compete: { score: null }, ai: { score: 50 } }, failures: [] } as never;
const FIX = (lens: string, currentText: string) => ({ lens, location: 'Headline', problem: 'p', currentText, suggestedText: 's' }) as never;

check('site audit: every lens prompt carries the auditor craft — no invented process, prices exactly, no outcome promises', () => {
    for (const s of ['"Book online"', '"within one working day"', 'never add "from" to a fixed price', '"pain-free"', 'is where "currentText" actually sits'])
        assert.ok(SITE_AUDIT_CRAFT.includes(s), s);
    for (const lens of ['clarity', 'ai'] as const) assert.ok(buildLensPrompt(lens, BRIEF, PAGE).user.includes('HOW AN EXPERT CONVERSION AUDITOR WRITES A FIX'));
});

check('site audit: hand-offs go only to assistants the workspace has active — told, and enforced', () => {
    assert.ok(handoffTargetsLine([]).includes('return "handoffs": []'));
    const one = buildSummaryPrompt({ brief: { ...BRIEF, activeHandoffTargets: ['social_media_manager'] }, score: SCORE, previousScore: null, fixes: [], competitorChanges: [] }).user;
    assert.ok(one.includes('"target" is one of "social_media_manager" — the ONLY assistants') && !one.includes('"blog_writer"'));
    const raw = { summary: 'Fine.', priorities: [], handoffs: [
        { target: 'blog_writer', title: 'Write an article', brief: 'b' }, { target: 'social_media_manager', title: 'Posts', brief: 'b' }] };
    const out = sanitiseSummary(raw, { brief: { ...BRIEF, activeHandoffTargets: ['social_media_manager'] }, score: SCORE, previousScore: null, fixes: [FIX('clarity', 'a')], competitorChanges: [] });
    assert.deepStrictEqual(out.handoffs.map((h) => h.target), ['social_media_manager']);
    const none = sanitiseSummary(raw, { brief: { ...BRIEF, activeHandoffTargets: [] }, score: SCORE, previousScore: null, fixes: [FIX('clarity', 'a')], competitorChanges: [] });
    assert.strictEqual(none.handoffs.length, 0);
    // Unknown (the public taster) keeps the old behaviour.
    assert.strictEqual(sanitiseSummary(raw, { brief: BRIEF, score: SCORE, previousScore: null, fixes: [FIX('clarity', 'a')], competitorChanges: [] }).handoffs.length, 2);
    // The worker loads them: active only, never paused, system-paused or archived.
    const src = read('src/utils/site-audit.ts');
    assert.ok(src.includes("const INACTIVE_STATES = new Set(['paused', 'system_paused', 'archived']);") && src.includes('conversionGoal: audit.conversionGoal, activeHandoffTargets, productsBlock'));
});

check('site audit: one suggestion per piece of page text, the first lens winning', () => {
    const kept = oneFixPerText([FIX('clarity', 'Welcome to Hollin Physio'), FIX('ai', 'Welcome  to hollin physio'), FIX('ai', 'Contact us')]);
    assert.deepStrictEqual(kept.map((f: { lens: string }) => f.lens), ['clarity', 'ai']);
    assert.ok(read('src/utils/site-audit.ts').includes('const fixes = oneFixPerText(answered.flatMap((r) => r.fixes));'));
});

// ── Brand Designer ───────────────────────────────────────────────────────────────────────────────

const KIT = normalizeBrandKit({ primaryColor: '#1F6F5C', textColor: '#14231F', backgroundColor: '#F4F7F5' });
const ROW = { title: 'Post', message: 'A runner stretching', headline: null, mood: null, mustInclude: null, mustAvoid: null, purpose: 'social_post', aspectRatio: '4:5' } as never;

check('art direction: the craft is in the system prompt', () => {
    for (const s of ['never a hex code', 'Nothing in frame that carries words', 'Never present an AI person as the business\'s own staff', 'not a description of the picture'])
        assert.ok(ART_DIRECTION_CRAFT.includes(s), s);
    assert.ok(artDirectionSystemPrompt().includes(ART_DIRECTION_CRAFT));
});

check('art direction: brand colours reach the model in words, and codes never reach an image prompt', () => {
    assert.strictEqual(colourWords('#1F6F5C'), 'deep teal');
    assert.strictEqual(colourWords('#F4F7F5'), 'white');
    assert.strictEqual(colourWords('#7A3E48'), 'wine red');
    assert.strictEqual(colourWords('nope'), '');
    const user = artDirectionUserPrompt(ROW, { kit: KIT, orgName: 'Hollin Physio', industry: null, description: null, guidelines: normaliseGuidelines({}) }, []);
    assert.ok(user.includes('describe them in words in the prompts, never as codes') && /accent deep teal \(#1f6f5c\)/i.test(user));
    assert.strictEqual(withoutColourCodes('Muted green tones (#1f6f5c), pale mist #f4f7f5.'), 'Muted green tones, pale mist.');
    const fb = fallbackArtDirection(ROW, KIT);
    assert.ok(!/#[0-9a-f]{3,6}/i.test(fb.imagePrompt) && fb.imagePrompt.includes('Colour accents in deep teal.'));
    const parsed = parseArtDirection('{"imagePrompt":"A park path, green (#1F6F5C) light.","stockKeywords":"runner","videoPrompt":"Slow push-in, #14231F shadows.","cardHeadlines":["Ease back in"]}', fb, null);
    assert.ok(!/#[0-9a-f]{3,6}/i.test(parsed.imagePrompt + parsed.videoPrompt!));
});

// ── Campaign Orchestrator ───────────────────────────────────────────────────────────────────────

check('campaign plans: the outcome must be one the plan\'s own work can produce', () => {
    for (const s of ['"leads": companies found by THIS campaign\'s own lead searches', 'Bookings, enquiries, sales and revenue are NOT counted anywhere', 'Never invent one', 'ORDERS THIS WORKSPACE CAN RUN'])
        assert.ok(CAMPAIGN_PLANNING_CRAFT.includes(s), s);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    const route = orch.indexOf('campaign_orchestrator: {');
    const craft = orch.indexOf('${CAMPAIGN_PLANNING_CRAFT}', route);
    assert.ok(route > 0 && craft > route && craft < orch.indexOf('brand_designer: {', route), 'in the campaign route');
});

check('campaign plans: only ACTIVE assistants\' orders are offered; paused ones are named so it can say to resume them', () => {
    const line = briefableOrdersLine(new Set(['social_media_manager']), new Set(['newsletter_editor']));
    assert.ok(line.includes('"draft_social_posts"') && line.includes('"request_human_task"'));
    const [can] = line.split('Plan ONLY with these.');
    assert.ok(!can.includes('"draft_email_campaign"'), 'email is not offered');
    assert.ok(line.includes('"draft_email_campaign" need an assistant that is PAUSED'));
    assert.ok(!briefableOrdersLine(new Set()).includes('PAUSED'));
    const src = read('src/utils/campaign-plan.ts');
    assert.ok(src.includes("r.status === 'paused' || r.status === 'system_paused' ? paused : active") && src.includes("r.status === 'archived'"));
});

check('campaign plans: a card that briefs an inactive assistant loses that order before the user sees it', () => {
    const card = { type: 'campaign_strategy_proposal', orders: [
        { action: 'run_lead_search', idea: 'x' },                    // 1 — Lead Generator: not active
        { action: 'draft_email_campaign', quantity: 3, after: 1 },  // 2 — waits on 1: goes with it
        { action: 'draft_social_posts', quantity: 8 },               // 3
        { action: 'draft_blog_pillar', quantity: 1, after: 3 },      // 4 — waits on 3: renumbered to 1
        { action: 'request_human_task', task: 'Check claims' },      // 5 — a person: always kept
    ] };
    const { card: out, dropped } = withoutInactiveOrders(card, new Set(['social_media_manager', 'blog_writer']));
    assert.deepStrictEqual((out.orders as Array<{ action: string; after?: number }>).map((o) => [o.action, o.after]),
        [['draft_social_posts', undefined], ['draft_blog_pillar', 1], ['request_human_task', undefined]]);
    assert.deepStrictEqual(dropped.sort(), ['Email Marketing Assistant', 'Lead Generation Assistant']);
    assert.strictEqual(withoutInactiveOrders({ orders: [{ action: 'draft_social_posts' }] }, new Set(['social_media_manager'])).dropped.length, 0);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes("type === 'campaign_strategy_proposal') {") && orch.includes('withoutInactiveOrders(uiElement as { orders?: unknown }, active)'));
    assert.ok(orch.includes('you may brief ONLY the ones listed under ORDERS THIS WORKSPACE CAN RUN'));
});

check('Admin ▸ Assistants ▸ Model & rules shows the three new blocks', () => {
    assert.ok(promptLayersFor('mystery_shopper').some((l) => l.key === 'audit_craft' && l.text === SITE_AUDIT_CRAFT));
    assert.ok(promptLayersFor('brand_designer').some((l) => l.key === 'art_direction' && l.text === ART_DIRECTION_CRAFT));
    assert.ok(promptLayersFor('campaign_orchestrator').some((l) => l.key === 'campaign_craft' && l.text === CAMPAIGN_PLANNING_CRAFT));
});

console.log(`\n${passed} passed`);
