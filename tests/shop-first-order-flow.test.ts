// tests/shop-first-order-flow.test.ts
// "First order" email flows (online shop Phase 2, slice 4b; feature request #35, docs/online-shop-review-plan.md §12):
// which flow a buyer joins (src/utils/shop-first-order-flow.ts), and that the new trigger reaches every place a flow's
// audience is chosen or shown — the Email Studio, the Email Flows tab, the AI flow writer and the chat card — so GUI
// and chat offer the same choice. The SQL is proven by tests/shop-first-order-flow-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-first-order-flow.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseBuyerFlow, flowAudienceWords, FIRST_ORDER_TRIGGER, ONE_ON_TRIGGERS } from '../src/utils/shop-first-order-flow';
import { AUTOMATIC_TRIGGERS, campaignDraftFromUiElement, NEWSLETTER_CAMPAIGN_DRAFT_TYPE } from '../src/utils/newsletter-campaign-chat-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nshop-first-order-flow');

check('which flow: first order + flow on → first-order (replacing welcome); newly subscribed otherwise → welcome; else none', () => {
    const c = (subscribed: boolean, newlySubscribed: boolean, firstOrder: boolean, firstOrderFlowOn: boolean) => chooseBuyerFlow({ subscribed, newlySubscribed, firstOrder, firstOrderFlowOn });
    assert.strictEqual(c(true, true, true, true), 'first_order');
    assert.strictEqual(c(true, false, true, true), 'first_order');
    assert.strictEqual(c(true, true, false, true), 'welcome');
    assert.strictEqual(c(true, true, true, false), 'welcome');
    assert.strictEqual(c(true, false, false, true), 'none');
    assert.strictEqual(c(false, false, true, true), 'none', 'a refused address never joins a flow');
});

check('audience words; the one-on triggers', () => {
    assert.strictEqual(flowAudienceWords('first_order'), 'Shop buyers who ask for news, after their first order');
    assert.strictEqual(flowAudienceWords('subscribed'), 'Everyone who subscribes');
    assert.deepStrictEqual([...ONE_ON_TRIGGERS], ['subscribed', 'first_order']);
});

check('the database: CHECK allows first_order (schema + migration), one first-order flow on', () => {
    const migration = read('db/z-shop-first-order-flow.sql');
    assert.ok(migration.includes("CHECK (trigger_event IN ('subscribed', 'form', 'first_order'))"));
    assert.ok(migration.includes("WHERE trigger_event = 'first_order' AND is_enabled"));
    assert.ok(migration.includes("NOT LIKE '%first_order%'"), 're-runnable: only drops the old check');
    const schema = read('db/schema.ts');
    assert.ok(schema.includes("IN ('subscribed', 'form', 'first_order')") && schema.includes('newsletter_sequences_org_first_order_on_uidx'));
    assert.ok((AUTOMATIC_TRIGGERS as readonly string[]).includes(FIRST_ORDER_TRIGGER));
});

check('checkout: enrolment runs after the buyer joins the Audience, only with an Audience result', () => {
    const shop = read('src/utils/site-shop.ts');
    const add = shop.indexOf('audience = await addShopBuyerToAudience(');
    const enrol = shop.indexOf('if (audience) await enrolShopBuyer(db, {');
    assert.ok(add > 0 && enrol > add);
});

check('the API: setTrigger, importCampaign and the one-on rule know first_order; check refusal is a 409 not a 500', () => {
    const api = read('netlify/functions/newsletter-sequences.ts');
    assert.ok(api.includes("body.trigger === FIRST_ORDER_TRIGGER ? FIRST_ORDER_TRIGGER : null"));
    assert.ok(api.includes('const savedTrigger = formTrigger ?'));
    assert.ok(api.includes('if (enable && ONE_ON(sequence.triggerEvent))') && api.includes("code: 'ANOTHER_FIRST_ORDER_ON'"));
    assert.ok((api.match(/if \(isTriggerCheck\(err\)\) return json\(409, NEEDS_FIRST_ORDER_UPDATE\)/g) || []).length === 2);
    assert.ok(api.includes(': sequence.triggerEvent === FIRST_ORDER_TRIGGER ? sql`false`'), 'no sign-up forms listed for a first-order flow');
    // review #903: forms linked by id can't make a flow first-order; the enable race answers in the right words.
    assert.ok(api.includes("code: 'FORMS_LINKED'") && api.includes("Another flow for shop buyers\\' first orders was just switched on"));
    const seqUtil = read('src/utils/newsletter-sequence.ts');
    assert.ok(seqUtil.includes("if (seq.triggerEvent === 'first_order' && args.via !== 'shop') return { enrolled: false, reason: 'no_sequence' };"));
    assert.ok(read('src/utils/shop-first-order-flow.ts').includes("sequenceId: flow!.id, via: 'shop' }"));
    assert.ok(read('netlify/functions/audience-forms.ts').includes("else if (seq.triggerEvent === 'first_order') { def.campaign = { sequenceId: null, skipWelcome: false };"), 'a form never links to a first-order flow');
});

check('Email Studio: the "Who receives it" choice, the new-flow tile, the swap, the lists', () => {
    const nl = read('newsletter.js');
    assert.ok(nl.includes('<option value="first_order" ${seq.triggerEvent === \'first_order\' ? \'selected\' : \'\'}>Shop buyers, after their first order</option>'));
    assert.ok(nl.includes("tile(cmp.who === 'first_order', 'Shop buyers, after their first order',"));
    assert.ok(nl.includes("res.code === 'ANOTHER_FIRST_ORDER_ON'"));
    assert.ok(nl.includes("isFormSeq || seq.triggerEvent === 'first_order' ? '' :"), 'no "goes to everyone who subscribes" banner on a first-order flow');
    assert.ok((nl.match(/flowWho\(x\.triggerEvent\)/g) || []).length === 2);
    assert.ok(read('src/components/assistant-email-campaigns.js').includes("c.triggerEvent === 'first_order' ? 'Shop buyers, after their first order'"));
});

check('chat: the flow card offers it, Save sends it, the prompt names it; the normaliser keeps it as automatic', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('<input type="radio" name="${whoName}" value="first_order"'));
    assert.ok(reg.includes("pick.value === 'first_order' ? 'first_order'"));
    assert.ok(read('src/components/chat-session.js').includes("d.trigger.event === 'first_order') ? d.trigger.event : null"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('A flow triggered by "first_order" starts when a buyer pays for their FIRST order'));
    assert.ok(read('netlify/functions/newsletter-issues.ts').includes("body.triggerEvent === 'first_order' ? 'first_order'"));
    const d = campaignDraftFromUiElement({ type: NEWSLETTER_CAMPAIGN_DRAFT_TYPE, stage: 'draft', campaign: { name: 'Thanks', trigger: { event: 'first_order' }, newsletters: [{ sendDay: 1, subject: 'Thank you', bodyMarkdown: 'Thanks for your order.' }] } });
    assert.deepStrictEqual([d?.trigger.event, d?.trigger.startsAutomatically], ['first_order', true]);
});

check('the SQL test runs in CI\'s Postgres job', () => {
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-first-order-flow-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
