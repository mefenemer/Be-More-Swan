// tests/order-confirmation-marker.test.ts
// An order whose buyer got no "Order confirmed" email from the owner's own address (#914: no route, refused or slow)
// is marked on the Shop tab and the website's Orders tab, so the owner can send one themselves. Orders from before
// 27 Nov 2026 were confirmed the old way and are never marked. src/utils/site-shop.ts confirmationNotSent.
//
// Run:  npx tsx tests/order-confirmation-marker.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmationNotSent, CONFIRMATION_NOT_SENT_LINE } from '../src/utils/site-shop';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const NEW = '2026-11-28T10:00:00Z';

console.log('\norder-confirmation-marker');

check('marked: an email address, no confirmation recorded, from 27 Nov 2026', () => {
    assert.strictEqual(confirmationNotSent({ customerEmail: 'a@b.example', buyerEmailedAt: null, createdAt: NEW }), true);
    assert.strictEqual(confirmationNotSent({ customerEmail: 'a@b.example', buyerEmailedAt: new Date(), createdAt: NEW }), false, 'sent');
    assert.strictEqual(confirmationNotSent({ customerEmail: null, buyerEmailedAt: null, createdAt: NEW }), false, 'no address: nothing to send');
    assert.strictEqual(confirmationNotSent({ customerEmail: 'a@b.example', buyerEmailedAt: null, createdAt: '2026-11-20T10:00:00Z' }), false, 'older orders: confirmed the old way');
    assert.strictEqual(confirmationNotSent({ customerEmail: 'a@b.example', buyerEmailedAt: null, createdAt: NEW, status: 'refunded' }), false, 'refunded: moot');
    assert.strictEqual(confirmationNotSent({ customerEmail: 'a@b.example', buyerEmailedAt: null, createdAt: NEW, status: 'done' }), false, 'review #923: cleared once dealt with');
});

check('both order lists carry it, with the same words as the server', () => {
    for (const f of ['src/components/assistant-shop.js', 'src/components/assistant-site-editor.js']) {
        const src = read(f);
        assert.ok(src.includes('data-order-not-confirmed') && src.includes('o.confirmationNotSent ?'), f);
        assert.ok(src.includes(CONFIRMATION_NOT_SENT_LINE.replace("couldn't", "couldn\\'t")), `${f}: words match`);
    }
    assert.ok(read('netlify/functions/shop.ts').includes('confirmationNotSent: confirmationNotSent({ ...o, buyerEmailedAt })'));
    assert.ok(read('netlify/functions/sites.ts').includes('confirmationNotSent: confirmationNotSent({ ...o, buyerEmailedAt })'));
    assert.ok(read('src/utils/shop-snapshot.ts').includes('NO ORDER CONFIRMATION reached the buyer'), 'review #923: the chat sees it too');
});

console.log(`\n${passed}/${total} passed`);
