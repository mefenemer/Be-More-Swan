// tests/site-payments-followups.test.ts
// Follow-ups from the first live payments test: a publish shows at once (cache purged by tag), the
// owner is told when Stripe goes live (return notice + site_payments_ready), Stripe's "your website"
// question is answered before they start, and Orders has its own place in the side menu.
//
// Run:  npx tsx tests/site-payments-followups.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteCacheTag } from '../src/utils/site-hosting';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nPublishing shows at once');

check('every page is tagged by site; publish, unpublish and a new address purge the tag', () => {
    assert.strictEqual(siteCacheTag('wordsworth'), 'bms-site-wordsworth');
    assert.ok(read('netlify/functions/site-serve.ts').includes("'Netlify-Cache-Tag': siteCacheTag(slug)"));
    const api = read('netlify/functions/sites.ts');
    assert.ok(api.includes('await purgeCache({ tags: [siteCacheTag(slug)] });'));
    assert.ok((api.match(/await purgeSitePages\(/g) || []).length >= 3, 'publish, unpublish, address');
});

console.log('\nStripe connected');

check('back from Stripe: a notice on the Website tab and a toast', () => {
    assert.ok(read('workspace.html').includes("if (qs.get('payments') === 'return') window._sitePaymentsReturn = true;"));
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('window._sitePaymentsReturn') && ed.includes('Stripe is connected. Buy buttons and any booking deposits are now live on your website.'));
    assert.ok(ed.includes('Stripe asks for your website'), 'the address to have ready');
});
check('a notification when charges switch on, registered in all four places', () => {
    assert.ok(read('src/utils/site-shop.ts').includes("createNotification(db, 'site_payments_ready'"));
    for (const f of ['src/utils/notification-actions.ts', 'src/utils/notification-prefs.ts', 'src/utils/notification-templates-catalog.ts', 'db/notifications-categorization.sql']) {
        assert.ok(read(f).includes('site_payments_ready'), f);
    }
});

console.log('\nOrders in the side menu');

check('after Audience, hidden until a Website Assistant is hired, its own page', () => {
    const side = read('components/sidebar.html');
    assert.ok(side.indexOf('id="nav-orders"') > side.indexOf('Audience') && side.includes('id="nav-orders" style="display:none"'));
    const ws = read('workspace.html');
    assert.ok(ws.includes("'orders': { file: 'orders.html'") && ws.includes('<script src="/orders.js"></script>'));
    assert.ok(ws.includes("a.roleKey === 'website_assistant'"));
    const js = read('orders.js');
    assert.ok(js.includes("action: 'orders', assistantId: a.id") && js.includes("action: 'order_done'"));
    assert.ok(js.includes("document.addEventListener('click'"), 'bound once, not from render');
    assert.ok(read('orders.html').includes('id="orders-root"'));
});

console.log(`\n${passed}/${total} passed\n`);
