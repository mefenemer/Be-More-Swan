// tests/shop-checkout-reminder.test.ts
// The abandoned-checkout reminder (online shop Phase 2, slice 5; feature request #35, docs/online-shop-review-plan.md
// §12): the basket page's email box, the checkout it changes, the email's wording, the Shop tab line, and that the
// webhook, sweep, chat and unsubscribe link are wired. The SQL paths are proven by tests/shop-checkout-reminder-db.test.ts.
//
// Run:  npx tsx tests/shop-checkout-reminder.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    basketLinkFor, checkoutNewsChoice, reminderCheckoutParams, reminderEmail, reminderStatsWords, stopUrl,
    REMINDER_CHECKOUT_MINUTES, STOP_PATH,
} from '../src/utils/shop-checkout-reminder';
import { EMAIL_FIELD, EMAIL_HINT } from '../src/utils/shop-buyer-audience';
import { basketCheckoutParams } from '../src/utils/site-shop';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const BID = 'AbCdEfGhIjKlMnOpQrStUv12';

console.log('\nshop-checkout-reminder');

check('the box: unticked keeps no email; ticked needs a real one', () => {
    assert.deepStrictEqual(checkoutNewsChoice(false, 'sam@example.com'), { ok: true, email: null });
    assert.deepStrictEqual(checkoutNewsChoice(true, '  Sam@Example.COM '), { ok: true, email: 'sam@example.com' });
    const empty = checkoutNewsChoice(true, '');
    assert.ok(!empty.ok && /Add your email address/.test(empty.error));
    const bad = checkoutNewsChoice(true, 'not-an-email');
    assert.ok(!bad.ok && /doesn't look right/.test(bad.error));
});

check('a ticked checkout: email filled in on Stripe, lapses after an hour; otherwise Stripe\'s defaults', () => {
    const now = new Date('2026-11-26T10:00:00Z');
    assert.deepStrictEqual(reminderCheckoutParams('sam@example.com', now), { customer_email: 'sam@example.com', expires_at: Math.floor(now.getTime() / 1000) + 3600 });
    assert.strictEqual(REMINDER_CHECKOUT_MINUTES, 60);
    assert.deepStrictEqual(reminderCheckoutParams(null, now), {});
    const site = { id: 3, organisationId: 9 } as never;
    const lines = [{ index: 0, productId: 1, optionId: null, sectionId: 's', name: 'Mug', unit: 800, qty: 1, currency: 'GBP', imageAssetId: null }] as never;
    const ticked = basketCheckoutParams({ origin: 'https://kudzu.example', site, basketId: BID, lines, collectAddress: false, news: true, reminderEmail: 'sam@example.com', now });
    assert.strictEqual(ticked.customer_email, 'sam@example.com');
    assert.strictEqual(ticked.expires_at, Math.floor(now.getTime() / 1000) + 3600);
    assert.strictEqual(ticked.metadata?.bms_news, '1');
    const plain = basketCheckoutParams({ origin: 'https://kudzu.example', site, basketId: BID, lines, collectAddress: false, news: false, reminderEmail: 'sam@example.com', now });
    assert.strictEqual(plain.customer_email, undefined);
    assert.strictEqual(plain.expires_at, undefined);
});

check('the basket link: the session\'s own back address when it is that basket\'s page, else the site\'s', () => {
    assert.strictEqual(basketLinkFor(`https://kudzu.example/basket?b=${BID}`, BID, 'kudzu'), `https://kudzu.example/basket?b=${BID}`);
    assert.ok(basketLinkFor('https://evil.example/elsewhere', BID, 'kudzu')!.endsWith(`/basket?b=${BID}`));
    assert.ok(!basketLinkFor('https://evil.example/elsewhere', BID, 'kudzu')!.includes('evil'));
    assert.ok(!basketLinkFor(`http://kudzu.example/basket?b=${BID}`, BID, 'kudzu')!.startsWith('http://'));
    assert.strictEqual(basketLinkFor(null, BID, null), null);
    assert.strictEqual(stopUrl('https://bemoreswan.com/', BID), `https://bemoreswan.com${STOP_PATH}?b=${BID}`);
});

check('the email: fixed words, the items, the link back, unsubscribe and why; never a price; escaped', () => {
    const m = reminderEmail({ business: 'Kudzu <Candles>', lines: [{ name: 'Fig candle', qty: 2 }, { name: 'Mug', qty: 1 }], basketUrl: `https://k.example/basket?b=${BID}`, stopUrl: 'https://bms.example/stop?b=x', postalAddress: '1 High St, Leeds' });
    assert.strictEqual(m.subject, 'You left something in your basket — Kudzu <Candles>');
    assert.ok(m.html.includes('Kudzu &lt;Candles&gt;') && !m.html.includes('<Candles>'));
    assert.ok(m.html.includes('<li>Fig candle × 2</li>') && m.html.includes('<li>Mug</li>'));
    assert.ok(m.html.includes(`href="https://k.example/basket?b=${BID}"`) && m.html.includes('href="https://bms.example/stop?b=x">Unsubscribe</a>'));
    assert.ok(m.html.includes('ticked "Send me news"') && m.html.includes('only reminder') && m.html.includes('1 High St, Leeds'));
    assert.ok(!/£|\d+\.\d\d/.test(m.html + m.text), 'no price in the email');
    assert.ok(m.text.includes('Unsubscribe: https://bms.example/stop?b=x') && m.text.includes('- Fig candle × 2'));
});

check('the Shop tab line', () => {
    assert.strictEqual(reminderStatsWords(null), null);
    assert.strictEqual(reminderStatsWords({ sent: 0, paid: 0, noRoute: 0 }), null);
    assert.strictEqual(reminderStatsWords({ sent: 2, paid: 1, noRoute: 0 }), '2 checkout reminders sent this week, 1 came back and paid.');
    assert.strictEqual(reminderStatsWords({ sent: 1, paid: 0, noRoute: 1 }), '1 checkout reminder sent this week, 0 came back and paid. 1 couldn\'t be sent: verify a sending domain or connect your mailbox in Email Studio ▸ Sending.');
});

check('the basket page: an email box under the ticked box only, posted with the checkout', () => {
    const render = read('src/utils/site-render.ts');
    assert.ok(render.includes('<label data-basket-news-email>${esc(EMAIL_HINT)} <input type="email" name="${EMAIL_FIELD}" autocomplete="email"'));
    assert.ok(render.includes('[data-basket-news]:not(:has(input[type=checkbox]:checked)) [data-basket-news-email]{display:none}'));
    assert.strictEqual(EMAIL_FIELD, '_email');
    assert.ok(/one reminder/.test(EMAIL_HINT));
    const shop = read('src/utils/site-shop.ts');
    const choice = shop.indexOf("const newsChoice = checkoutNewsChoice(req.body.get('_news') === '1', req.body.get(EMAIL_FIELD));");
    const create = shop.indexOf('basketCheckoutParams({ origin: req.origin, site: req.site, basketId: basket.id');
    assert.ok(choice > 0 && create > choice, 'the email is checked before Stripe is asked');
    assert.ok(shop.includes('reminderEmail: newsChoice.email }'));
    const mark = shop.indexOf('await markBasketCheckout(db, basket.id');
    const save = shop.indexOf('await saveReminderEmail(db, { basketId: basket.id');
    assert.ok(mark > 0 && save > mark, 'saved after the session id is on the basket');
});

check('wired: webhook on expiry, the sweep keeps reminded baskets, the Shop tab, the chat snapshot, the unsubscribe page', () => {
    const hook = read('netlify/functions/stripe-connect-webhook.ts');
    assert.ok(hook.includes('else if (session.metadata?.bms_basket) {') && hook.includes('await sendCheckoutReminder(db, evt.account, session, {'));
    assert.ok(read('src/utils/shop-basket.ts').includes('AND (reminded_at IS NULL OR reminded_at < now() - make_interval(days => ${REMINDED_BASKET_KEEP_DAYS}))'));
    assert.ok(read('netlify/functions/shop.ts').includes('reminders: reminderStatsWords(await loadReminderStats(db, orgId)),'));
    assert.ok(read('src/components/assistant-shop.js').includes('data-shop-reminders>${esc(d.reminders)}'));
    assert.ok(read('src/utils/shop-snapshot.ts').includes('ABANDONED-CHECKOUT REMINDERS: automatic, no setting.'));
    const stop = read('netlify/functions/shop-reminder-stop.ts');
    assert.ok(stop.includes("if (method === 'HEAD') return { statusCode: 200, body: '' };") && stop.includes('await stopRemindedAddress(getDb(), b)'));
    assert.ok(/if \(method === 'GET'\) \{[\s\S]*?<form method="post"/.test(stop), 'GET shows a button, never unsubscribes');
    const mod = read('src/utils/shop-checkout-reminder.ts');
    assert.ok(mod.includes("if (!newsTicked(session.metadata as Record<string, string> | null)) return 'not_ticked';"), 'only ticked checkouts');
    assert.ok(mod.includes('account.stripeAccountId !== accountId'), 'metadata alone is never trusted');
    assert.ok(!/bemoreswan\.com|noreply@|fromLine\(/.test(mod), 'never a Be More Swan sender');
    // review #907: every refusal applies to a typed, not-yet-Audience address; one reminder per address per week.
    assert.ok(mod.includes('[email], { consentGivenHere: true })).get(email);') && mod.includes('if (!verdict?.sendable) {'));
    assert.ok(mod.includes('AND o.reminder_email = site_baskets.reminder_email') && mod.includes('o.reminded_at > now() - make_interval(days => ${REMINDER_PER_ADDRESS_DAYS})'));
    const consent = read('src/utils/audience-consent.ts');
    assert.ok(consent.includes("if (!contact && !opts.consentGivenHere) {") && consent.includes("!(opts.consentGivenHere && contact.status === 'pending')"));
});

check('the SQL: additive columns, the result check, mirrored in db/schema.ts; the DB test runs in CI', () => {
    const m = read('db/z-shop-checkout-reminder.sql');
    for (const c of ['reminder_email TEXT', 'checkout_expires_at TIMESTAMP', 'reminded_at TIMESTAMP', 'reminder_result TEXT']) assert.ok(m.includes(`ADD COLUMN IF NOT EXISTS ${c}`), c);
    assert.ok(m.includes("CHECK (reminder_result IS NULL OR reminder_result IN ('sent', 'no_route', 'refused', 'failed'))"));
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('reminderEmail: text("reminder_email")') && schema.includes('site_baskets_reminder_result_check'));
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-checkout-reminder-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
