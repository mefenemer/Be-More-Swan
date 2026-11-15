// tests/shop-settings.test.ts
// Online shop Phase 0 (FR#35, docs/online-shop-review-plan.md §6): the Delivery & returns details UK
// law needs a buyer to see (src/utils/shop-settings.ts), the rule that Buy buttons need them, the
// page, the note beside Stripe's Pay button, the buyer's confirmation email and refunds.
//
// Run:  npx tsx tests/shop-settings.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanSettings, missingFields, shopReady, shopTermsHtml, returnsSummaryText, checkoutNote, EMPTY_SHOP_SETTINGS,
    RETURN_EXCEPTIONS, SHOP_TERMS_PATH, type ShopSettings,
} from '../src/utils/shop-settings';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { buyerEmail, checkoutParams, type SiteProduct } from '../src/utils/site-shop';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';
import type { SiteRow } from '../src/utils/site-store';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const READY: ShopSettings = {
    ...EMPTY_SHOP_SETTINGS,
    traderName: 'Willowbrook Coffee Ltd', traderAddress: '12 Mill Lane\nWillowbrook\nWB1 2CD',
    contactEmail: 'hello@willowbrook.example', deliveryText: 'Royal Mail Tracked 48, usually 2–3 working days.',
    returnsDays: 14, returnPostage: 'buyer', exceptions: ['perishable'],
};

console.log('\nThe details');

check('nothing filled in = not ready, and it names what is missing in the form\'s order', () => {
    assert.strictEqual(shopReady(null), false);
    assert.deepStrictEqual(missingFields(null), ['Business or trading name', 'Business address', 'Email for customers', 'How and when you deliver']);
    assert.strictEqual(shopReady(READY), true);
    assert.deepStrictEqual(missingFields({ ...READY, traderAddress: '   ' }), ['Business address']);
});

check('an edit changes only the keys it sends (the chat can set one field)', () => {
    const r = cleanSettings(READY, { contactPhone: ' 01234 567890 ' });
    assert.ok(r.ok);
    assert.strictEqual(r.value.contactPhone, '01234 567890');
    assert.strictEqual(r.value.traderName, READY.traderName);
    assert.deepStrictEqual(r.value.exceptions, ['perishable']);
});

check('the law\'s floor: at least 14 days to cancel; postage is buyer or seller; only the lawful exceptions', () => {
    assert.strictEqual(cleanSettings(READY, { returnsDays: 7 }).ok, false);
    assert.strictEqual(cleanSettings(READY, { returnsDays: 30 }).ok, true);
    assert.strictEqual(cleanSettings(READY, { returnPostage: 'nobody' }).ok, false);
    assert.strictEqual(cleanSettings(READY, { exceptions: ['sale_items'] }).ok, false);
    const ok = cleanSettings(READY, { exceptions: ['personalised', 'personalised', 'mixed'] });
    assert.ok(ok.ok && ok.value.exceptions.join() === 'personalised,mixed');
    assert.deepStrictEqual(Object.keys(RETURN_EXCEPTIONS).sort(), ['mixed', 'perishable', 'personalised', 'sealed_hygiene', 'sealed_media']);
});

check('a bad email is refused; a VAT number is tidied', () => {
    assert.strictEqual(cleanSettings(READY, { contactEmail: 'not an email' }).ok, false);
    const r = cleanSettings(READY, { vatNumber: 'gb 123  456 789' });
    assert.ok(r.ok && r.value.vatNumber === 'GB 123 456 789');
});

console.log('\nWhat the buyer reads');

check('the page: who sells, address, delivery, the right to cancel, postage, exceptions, faulty goods and the model form', () => {
    const h = shopTermsHtml(READY);
    for (const s of ['Willowbrook Coffee Ltd', '12 Mill Lane<br>Willowbrook', 'hello@willowbrook.example', 'Royal Mail Tracked 48',
        'within 14 days of the day you', 'You pay the cost of sending the goods back', 'within 14 days of getting the goods back',
        RETURN_EXCEPTIONS.perishable, 'Consumer Rights Act 2015', 'within 30 days', 'Cancellation form', 'hereby give notice', 'Stripe']) {
        assert.ok(h.includes(s), `page is missing: ${s}`);
    }
    assert.ok(!h.includes('VAT number'), 'no VAT line unless they gave one');
    assert.ok(shopTermsHtml({ ...READY, vatNumber: 'GB123', returnPostage: 'seller' }).includes('VAT number: GB123'));
    assert.ok(shopTermsHtml({ ...READY, returnPostage: 'seller' }).includes('We pay the cost of sending the goods back'));
});

check('what they type is escaped on the page', () => {
    const h = shopTermsHtml({ ...READY, traderName: '<script>x</script>', extraTerms: 'a & b' });
    assert.ok(!h.includes('<script>x') && h.includes('&lt;script&gt;') && h.includes('a &amp; b'));
});

check('the note beside Stripe\'s Pay button names the seller, the returns and links the page', () => {
    const n = checkoutNote(READY, `https://willowbrook.bemoreswan.site${SHOP_TERMS_PATH}`);
    assert.ok(n.startsWith('Sold by Willowbrook Coffee Ltd.'));
    assert.ok(n.includes('cancel within 14 days') && n.includes('You pay for return postage') && n.endsWith('/delivery-returns'));
    assert.ok(n.length <= 1200);
    assert.ok(returnsSummaryText(READY).includes('items that go off quickly'));
});

console.log('\nSelling needs them');

const SITE: SiteRow = {
    id: 9, organisationId: 3, aiAssistantId: 4, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null,
};
const BLEND: SiteProduct = { id: 11, name: 'House Blend', description: null, price: '£12.50', buyPence: 1250, imageAssetId: null };

check('Checkout carries the note when the details are given, and nothing else changes', () => {
    const base = { origin: 'https://willowbrook.bemoreswan.site', site: SITE, sectionId: 's1', product: BLEND, collectAddress: true, backPath: '/shop' };
    const p = checkoutParams({ ...base, shop: READY });
    const submit = p.custom_text?.submit;
    assert.ok(submit && typeof submit === 'object' && String(submit.message).includes('Sold by Willowbrook Coffee Ltd'));
    assert.strictEqual(checkoutParams(base).custom_text, undefined);
    assert.ok(!('application_fee_amount' in (p.payment_intent_data ?? {})), 'still no fee to us');
});

check('canSell and startCheckout both require the details (not just the drawing)', () => {
    const shopTs = read('src/utils/site-shop.ts');
    assert.ok(/export async function canSell[\s\S]{0,300}shopReady\(await loadShopSettings\(db, orgId\)\)/.test(shopTs));
    assert.ok(shopTs.includes('if (!account?.chargesEnabled || !shopReady(shop))'));
});

check('a live products section links Delivery & returns under the Buy buttons; the preview says what is needed', () => {
    const d = normaliseSiteDefinition({ settings: { siteName: 'W' }, pages: [{ title: 'Shop', slug: '', sections: [{ type: 'products', props: { productIds: [11] } }] }] }).definition;
    const live = { origin: 'https://w.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };
    assert.ok(renderSitePage(d, '/', { ...live, canSell: true, products: { 11: BLEND } }).html.includes('href="/delivery-returns">Delivery &amp; returns</a>'));
    assert.ok(!renderSitePage(d, '/', { ...live, canSell: false, products: { 11: BLEND } }).html.includes('/delivery-returns'));
    assert.ok(renderSitePage(d, '/', { ...live, preview: true, canSell: true, products: { 11: BLEND } }).html.includes('Delivery &amp; returns details are filled in'));
});

check('site-serve serves /delivery-returns from the settings, and 404s until they are complete', () => {
    const serve = read('netlify/functions/site-serve.ts');
    assert.ok(serve.includes('if (path === SHOP_TERMS_PATH && !definition.pages.some('));
    assert.ok(serve.includes("renderSiteShell(definition, ctx, 'Delivery & returns', shopTermsHtml(shop!))"));
});

console.log('\nAfter paying');

check('the buyer email: order, total, delivery, how to cancel, the page link and the seller\'s details', () => {
    const order = { id: 77, quantity: 2, itemName: 'House Blend', customerName: 'Jo', shippingAddress: { name: 'Jo', address: { line1: '1 High St', city: 'Leeds', postal_code: 'LS1 1AA' } } } as unknown as Parameters<typeof buyerEmail>[0]['order'];
    const m = buyerEmail({ order, shop: { ...READY, vatNumber: 'GB1' }, total: '£25', termsUrl: 'https://w.bemoreswan.site/delivery-returns' });
    assert.strictEqual(m.subject, 'Order confirmed — Willowbrook Coffee Ltd');
    for (const s of ['Hi Jo', '£25', '(including VAT)', '2 × House Blend', 'Order reference:</strong> 77', '1 High St', 'Royal Mail Tracked 48', 'cancel within 14 days', 'reply to this email', '/delivery-returns', '12 Mill Lane']) {
        assert.ok(m.html.includes(s), `email is missing: ${s}`);
    }
    assert.ok(!buyerEmail({ order, shop: READY, total: '£25', termsUrl: null }).html.includes('cancellation form:'));
});

check('recordPaidCheckout stores the payment and emails the buyer; a refund is matched back by it', () => {
    const shopTs = read('src/utils/site-shop.ts');
    assert.ok(shopTs.includes('paymentIntentId: typeof session.payment_intent'));
    assert.ok(shopTs.includes('await sendBuyerConfirmation(db, order, site, total)'));
    assert.ok(shopTs.includes("...(refunded >= order.amountTotal && order.amountTotal > 0 ? { status: 'refunded' } : {})"));
    assert.ok(shopTs.includes("ne(siteOrders.status, 'refunded')"), 'Mark as done never hides a refund');
    const hook = read('netlify/functions/stripe-connect-webhook.ts');
    assert.ok(hook.includes("evt.type === 'charge.refunded'") && hook.includes('await recordRefund(db, evt.account'));
});

console.log('\nGUI and chat, data');

check('the Orders tab form and the chat card send the same sites.ts action', () => {
    const sites = read('netlify/functions/sites.ts');
    assert.ok(sites.includes("if (action === 'shop_settings')") && sites.includes('saveShopSettings(db, orgId, userId, input)'));
    assert.ok(read('src/components/assistant-site-editor.js').includes("action: 'shop_settings', assistantId: state.assistantId, settings"));
    assert.ok(read('src/components/chat-session.js').includes("JSON.stringify({ action: 'shop_settings', assistantId, settings: d.settings || {} })"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('shop_settings', renderShopSettingsCard)"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"type": "shop_settings"'));
});

check('the settings are in the workspace export and the SQL is additive', () => {
    assert.ok('shopSettings' in WORKSPACE_TABLES);
    const sql = read('db/z-shop-settings.sql');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS shop_settings') && sql.includes('ADD COLUMN IF NOT EXISTS payment_intent_id'));
    assert.ok(sql.includes("CHECK (status IN ('paid', 'done', 'refunded'))"));
});

console.log(`\n${passed}/${total} passed`);
