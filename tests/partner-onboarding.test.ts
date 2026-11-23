// tests/partner-onboarding.test.ts
// Partner onboarding, Phase 1 (docs/partner-onboarding-plan.md).
//
// WHY THIS EXISTS (2026-11-22). A newly approved partner used to get "sign in to find your link", land
// on the workspace home and meet an empty chat. Now the welcome email opens the Partner page, a
// first-week list ticks itself FROM REAL DATA, and the Partner Assistant greets them first with a
// greeting built from their numbers (owner decision D2: no model call — free and exact). These tests
// pin the sums and the rules that make that honest: the example uses the ledger's own commission
// sum, ticks never come from a click, the greeting is never sent to the model, the playbook makes no
// product claims, and my_results only reads the partner's own workspace.
//
// Run:  npx tsx tests/partner-onboarding.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ASSISTANT_LIMIT_AFTER, ASSISTANT_LIMIT_FIRST_MONTH, SETUP_STEPS, buildChecklist, checklistFolded, exampleLine,
    partnerAssistantLimit, rateLine, startersFor, welcomeGreeting,
} from '../src/utils/partner-onboarding';
import { PARTNER_PLAYBOOK, PLAYBOOK_TOPICS } from '../src/config/partner-playbook';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const angela = { rateBps: 5000, costDeductionBps: 2000, durationMonths: 12 };
const none = { termsAccepted: false, payoutSet: false, marks: {}, stats: { clicks_all: 0, signups: 0, paying: 0 } };

console.log('rate and example');

check('rate line: the rate after costs, up to the share after the minimum, and the length (actual costs 2026-11-23)', () => {
    assert.strictEqual(rateLine(angela), '50% of each plan payment a customer you invite makes after costs — up to 40% of each payment (excluding VAT), for their first 12 months');
    assert.ok(rateLine({ rateBps: 2500, costDeductionBps: 0, durationMonths: null }).endsWith('for as long as they stay a customer'));
    assert.ok(rateLine({ rateBps: 2500, costDeductionBps: 0, durationMonths: 1 }).endsWith('first 1 month'));
});

check('example uses the ledger sum: £79 at 50% after 20% costs = £31.60 (the figure the assistants quote)', () => {
    assert.strictEqual(exampleLine(angela, 79), 'every £79 a customer pays (excluding VAT) earns you up to £31.60');
    assert.strictEqual(exampleLine(angela, 29), 'every £29 a customer pays (excluding VAT) earns you up to £11.60');
    assert.strictEqual(exampleLine(null, 79), null);
    assert.strictEqual(exampleLine(angela, null), null);
});

console.log('first-week list');

check('ticks come only from data: nothing done → nothing ticked; data → ticked', () => {
    assert.ok(buildChecklist(none).every((s) => !s.done));
    const all = buildChecklist({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks: { first_draft_at: 'x', link_copied_at: 'y' }, stats: { clicks_all: 3, signups: 1, paying: 1 } });
    assert.ok(all.every((s) => s.done));
});

check('the four setup steps are hers; visits / sign-ups / paying tick themselves', () => {
    const steps = buildChecklist(none);
    assert.deepStrictEqual(steps.filter((s) => !s.automatic).map((s) => s.key), SETUP_STEPS);
    assert.deepStrictEqual(steps.filter((s) => s.automatic).map((s) => s.key), ['first_visit', 'first_signup', 'first_paying']);
});

check('the list folds once setup is done, or when she hides it — not before', () => {
    assert.strictEqual(checklistFolded(buildChecklist(none), {}), false);
    assert.strictEqual(checklistFolded(buildChecklist(none), { dismissed_at: 'x' }), true);
    const setup = { termsAccepted: true, payoutSet: true, invitePageLive: true, marks: { first_draft_at: 'x', link_copied_at: 'y' }, stats: null };
    assert.strictEqual(checklistFolded(buildChecklist({ ...setup, invitePageLive: false }), setup.marks), false, 'the invite page is a setup step (Phase 2)');
    assert.strictEqual(checklistFolded(buildChecklist(setup), setup.marks), true);
});

console.log('greeting and starters');

check('greeting: her name, her rate, an exact example, and her next three steps', () => {
    const g = welcomeGreeting({ firstName: 'Angela', businessName: 'Kudzu Collab', terms: angela, planPriceGbp: 79, steps: buildChecklist(none) });
    assert.ok(g.startsWith('Hi Angela, I’m your Partner Assistant.'));
    assert.ok(g.includes('50% of each plan payment a customer you invite makes after costs — up to 40% of each payment'));
    assert.ok(g.includes('£31.60'));
    assert.ok(g.includes('1. Accept the Partner Terms'));
    assert.ok(g.includes('2. Tell us where to pay you'));
    assert.ok(g.includes('3. Make your invite page yours'));
    const later = welcomeGreeting({ firstName: 'Angela', businessName: 'Kudzu Collab', terms: angela, planPriceGbp: 79,
        steps: buildChecklist({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks: {}, stats: null }) });
    assert.ok(later.includes('1. Write your first post about how Kudzu Collab uses Be More Swan'));
    assert.ok(!g.includes('4.'), 'three steps at most');
});

check('greeting after setup points to what is next, without a to-do list', () => {
    const done = buildChecklist({ termsAccepted: true, payoutSet: true, invitePageLive: true, marks: { first_draft_at: 'x', link_copied_at: 'y' }, stats: null });
    const g = welcomeGreeting({ firstName: null, businessName: null, terms: angela, planPriceGbp: null, steps: done });
    assert.ok(g.startsWith('Hi, I’m your Partner Assistant.'));
    assert.ok(g.includes('Your setup is done'));
    assert.ok(!/\n1\. /.test(g));
});

check('starters follow her funnel: no visits → first post; visits → why no sign-ups; sign-ups → trial', () => {
    const base = { termsAccepted: true, payoutSet: true, marks: { first_draft_at: 'x', link_copied_at: 'y' } };
    const at = (stats: { clicks_all: number; signups: number; paying: number }) => startersFor(buildChecklist({ ...base, stats }), stats)[0].label;
    assert.strictEqual(at({ clicks_all: 0, signups: 0, paying: 0 }), 'Write my first post');
    assert.strictEqual(at({ clicks_all: 9, signups: 0, paying: 0 }), 'Why no sign-ups yet?');
    assert.strictEqual(at({ clicks_all: 9, signups: 2, paying: 0 }), 'My sign-ups are in trial');
    assert.strictEqual(at({ clicks_all: 9, signups: 2, paying: 1 }), 'What should I do next?');
    assert.ok(startersFor(buildChecklist({ ...base, stats: { clicks_all: 0, signups: 0, paying: 0 } }), null).length <= 5);
});

check('Terms not accepted → no starters and no "where would you like to start?" (the assistant would refuse; review of #813)', () => {
    assert.deepStrictEqual(startersFor(buildChecklist(none), none.stats), []);
    const g = welcomeGreeting({ firstName: 'Angela', businessName: null, terms: angela, planPriceGbp: 79, steps: buildChecklist(none) });
    assert.ok(!g.includes('Where would you like to start?'));
    assert.ok(g.includes('Once you’ve accepted the Partner Terms (step 1 on your first-week list)'));
    const page = read('partner-content.html');
    assert.ok(page.includes("input.disabled = locked;"), 'the chat box is locked until then');
    assert.ok(read('netlify/functions/partner-assistant.ts').includes('it’s step 1 of your first-week list'), 'the 403 points at the list, not a hidden banner');
    assert.ok(page.includes("(k === 'first_draft' || k === 'share' || k === 'invite_page') && data.partnerTerms && !data.partnerTerms.accepted"), 'sharing waits for the rules too');
    assert.ok(page.includes("if (inputId === 'pt-link' && data?.onboarding && !(data.partnerTerms && !data.partnerTerms.accepted))"), 'from either Copy button');
    assert.ok(!page.includes('Accept the Partner Terms at the top of this page'), 'no pointer to a banner the list hides');
});

check('D7: 100 messages in the first 30 days from their FIRST message, then 50 — not from decided_at, which status changes reset', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    assert.strictEqual(partnerAssistantLimit(new Date('2026-11-20T12:00:00Z'), now), ASSISTANT_LIMIT_FIRST_MONTH);
    assert.strictEqual(partnerAssistantLimit(new Date('2026-10-01T12:00:00Z'), now), ASSISTANT_LIMIT_AFTER);
    assert.strictEqual(partnerAssistantLimit(null, now), ASSISTANT_LIMIT_FIRST_MONTH, 'no start yet = this is the first message');
    const src = read('netlify/functions/partner-assistant.ts');
    assert.ok(!src.includes('partnerAssistantLimit(p.decidedAt'));
    assert.ok(src.includes("COALESCE(${partners.onboarding}->>'assistant_started_at'"), 'written once');
    assert.strictEqual(ASSISTANT_LIMIT_FIRST_MONTH, 100);
    assert.strictEqual(ASSISTANT_LIMIT_AFTER, 50);
});

console.log('playbook');

check('every topic has advice, and the tool enum is the same list', () => {
    for (const t of PLAYBOOK_TOPICS) assert.ok(PARTNER_PLAYBOOK[t].advice.length >= 3, t);
    assert.ok(read('netlify/functions/partner-assistant.ts').includes("enum: [...PLAYBOOK_TOPICS]"));
});

check('the playbook makes no product claims: no prices, networks or invented numbers (facts come only from bms_facts)', () => {
    const all = JSON.stringify(PARTNER_PLAYBOOK);
    assert.ok(!/£\s?\d/.test(all), 'no prices');
    assert.ok(!/\b\d+\s?%/.test(all.replace(/30-day|30–45|2–3|3–5/g, '')), 'no percentages or results');
    // Channels may be NAMED as places a partner posts; it must never say BMS connects to them.
    assert.ok(!/connects? (to|with)|integrat/i.test(all), 'no integration claims');
});

check('rules mirror Partner Terms v1.3: label first, coupon sites, brand bidding, consent, self-referral, check AI drafts', () => {
    const r = PARTNER_PLAYBOOK.rules.advice.join(' ');
    for (const needle of ['at the start', 'coupon', 'negative keyword', 'PECR', 'CAN-SPAM', 'themselves', 'theirs to check', '7.5 Staying active', 'not theirs']) assert.ok(r.includes(needle), needle);
    assert.ok(read('src/config/partner-terms.ts').includes("'1.3'"), 'Terms version changed — update the rules topic and this test');
});

console.log('wiring');

check('the greeting is shown, never sent: it is not a chat turn', () => {
    const page = read('partner-content.html');
    assert.ok(page.includes('data.onboarding.greeting') && page.includes('It is shown, never sent'));
    assert.ok(page.includes('body: JSON.stringify({ messages: chat.turns.map('), 'only real turns go to the model');
});

check('my_results reads ONLY the partner’s own workspace and user row', () => {
    const src = read('netlify/functions/partner-assistant.ts');
    const block = src.slice(src.indexOf("case 'my_results'"), src.indexOf("case 'deliver_draft'"));
    assert.ok(block.length > 0);
    assert.strictEqual((block.match(/organisation_id = \$\{orgId\}/g) || []).length, 3);
    assert.ok(block.includes('WHERE id = ${userId}'));
    assert.ok(block.includes('if (!orgId || !ownsWorkspace) return { hasWorkspace: false'));
    assert.ok(src.includes('products: ownsWorkspace ? await loadProductsBlock('), 'no employer products as theirs');
    assert.ok(src.includes("CASE WHEN ${userOrganisations.role} = 'owner' THEN 0 ELSE 1 END"), 'their own workspace first');
    assert.ok(read('netlify/functions/partner-hub.ts').includes("eq(userOrganisations.role, 'owner')"), 'greeting names only a business they own');
});

check('first draft ticks the list; page marks are whitelisted and only touch her own row', () => {
    const asst = read('netlify/functions/partner-assistant.ts');
    assert.ok(asst.includes("jsonb_build_object('first_draft_at'"));
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes("if (!(PAGE_MARKS as readonly string[]).includes(mark)) return json(400"));
    assert.ok(hub.includes("if (impersonating) return json(403"), 'an admin impersonating can’t tick her list');
    const marks = hub.slice(hub.indexOf("body.action === 'onboarding'"), hub.indexOf("body.action === 'weekly_nudge'"));
    assert.strictEqual((marks.match(/\.where\(eq\(partners\.id, p\.id\)\)/g) || []).length, 3);
});

check('approval: email opens the Partner page with the rate; bell notification exists', () => {
    const apps = read('src/utils/partner-applications.ts');
    assert.ok(apps.includes("partner: { rate_line: rate }"));
    assert.ok(apps.includes("link: { action_url: partnerPageUrl() }"));
    assert.ok(apps.includes("/workspace.html?view=partner"));
    const email = read('src/utils/email-templates-catalog.ts');
    assert.ok(email.includes("button('Meet your Partner Assistant', 'link.action_url')"));
    assert.ok(email.includes('{{partner.rate_line | "commission on every customer you invite"}}'));
    const n = getNotificationDefault('partner_approved');
    assert.ok(n && n.type === 'referral_reward');
    assert.ok(read('notifications.js').includes("meta.action === 'partner_page'"), 'action opens the Partner page');
});

check('SQL file and schema mirror agree on partners.onboarding', () => {
    assert.ok(read('db/z-partner-onboarding.sql').includes("ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb"));
    assert.ok(read('db/schema.ts').includes('onboarding: jsonb()'));
});

check('sidebar keeps the Partner page for ended partners (their earnings + payout details)', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes("['applied', 'approved', 'suspended', 'ended'].includes(partnerStatus)"));
    assert.ok(ws.includes("partnerStatus === 'approved' || partnerStatus === 'suspended' || partnerStatus === 'ended';"), 'and never hard-gated by the plan picker');
});

check('out of time after a draft → the draft is presented, not "needed more steps" (live test 2026-11-23)', () => {
    const src = read('netlify/functions/partner-assistant.ts');
    assert.ok(src.includes("if (!cards.length) reply ||= 'That needed more steps"));
    assert.ok(src.includes("if (!cards.length) reply = 'That took too long"));
});

check('speed: context loaded up front, card-only rounds end the turn, replies short (staging timed out, 2026-11-23)', () => {
    const src = read('netlify/functions/partner-assistant.ts');
    assert.ok(src.includes("safe(runTool('my_partner_summary', {})), safe(runTool('bms_facts', {})), safe(runTool('my_business', {})), safe(runTool('my_results', {}))"), 'loaded in parallel');
    assert.ok(src.includes("<context>${sanitizeForModel(context).replace(/</g, '\\\\u003c')}</context>"), 'a stray </context> in their data cannot close the block');
    assert.ok(src.includes("if (cardOnly && cards.length - cardsBefore === toolUses.length) { reply = text; break; }"), 'no second round after a card');
    assert.ok(src.includes('at most about 100 words'));
});

console.log(`\n${passed} passed`);
