// tests/shop-receipts-own-address.test.ts
// Buyers' "Order confirmed" emails go ONLY from the owner's own address (owner 2026-11-27; src/utils/site-shop.ts
// sendBuyerConfirmation): via resolveSendRoute + deliverStep, never "via Be More Swan"; no route = not sent and the
// owner's new-order email says so; the Shop tab and the chat snapshot warn before the first order.
//
// HOW. A tiny fake db (select → the saved Delivery & returns row; update → recorded). Route and sender stubbed.
//
// Run:  npx tsx tests/shop-receipts-own-address.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyerConfirmationLine, buyerConfirmationsBlocked, sendBuyerConfirmation } from '../src/utils/site-shop';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const SETTINGS_ROW = {
    organisationId: 5, traderName: 'Willowbrook Coffee Ltd', traderAddress: '12 Mill Lane\nWB1 2CD', contactEmail: 'hello@willowbrook.example',
    contactPhone: null, vatNumber: null, deliveryText: 'Royal Mail Tracked 48', returnsDays: 14, returnPostage: 'buyer', exceptions: [], extraTerms: null, updatedAt: null,
};
function fakeDb(row: object | null = SETTINGS_ROW) {
    const updates: object[] = [];
    const chain = { from: () => chain, where: () => chain, limit: async () => (row ? [row] : []) };
    const db = {
        select: () => chain,
        update: () => ({ set: (v: object) => ({ where: async () => { updates.push(v); } }) }),
    };
    return { db: db as never, updates };
}
const ORDER = { id: 77, siteId: 3, organisationId: 5, quantity: 1, itemName: 'House Blend', currency: 'gbp', customerName: 'Jo', customerEmail: 'jo@buyer.example', shippingAddress: null } as never;
const SITE = { id: 3, organisationId: 5, slug: null } as never;
type Sent = { route: { provider: string; from: string | null; replyTo: string | null }; to: string; subject: string; text: string; html: string };

async function main() {
    console.log('\nshop-receipts-own-address');

    await check('with a route: sent through it (never a Be More Swan sender), with a text part; marked emailed', async () => {
        const { db, updates } = fakeDb();
        const sent: Sent[] = [];
        const r = await sendBuyerConfirmation(db, ORDER, SITE, '£12', null, null, {
            resolveRoute: (async () => ({ route: { provider: 'resend', from: 'Willowbrook <shop@willowbrook.example>', replyTo: null, engagementTracked: false } })) as never,
            deliver: (async (_db: unknown, route: Sent['route'], _org: number, m: Omit<Sent, 'route'>) => { sent.push({ route, ...m }); return null; }) as never,
        });
        assert.strictEqual(r, 'sent');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].to, 'jo@buyer.example');
        assert.strictEqual(sent[0].subject, 'Order confirmed — Willowbrook Coffee Ltd');
        assert.ok(!/bemoreswan|Be More Swan/i.test(String(sent[0].route.from)));
        assert.strictEqual(sent[0].route.replyTo, 'hello@willowbrook.example', '"reply to this email" reaches the shop when the domain has no reply-to');
        assert.ok(sent[0].text.includes('House Blend') && !sent[0].text.includes('<p>'), 'plain-text part for a mailbox send');
        assert.strictEqual(updates.length, 1);
    });

    await check('no route: NOT sent, not marked emailed; the owner\'s email line says to send one yourself', async () => {
        const { db, updates } = fakeDb();
        let delivered = 0;
        const r = await sendBuyerConfirmation(db, ORDER, SITE, '£12', null, null, {
            resolveRoute: (async () => ({ error: 'none' })) as never,
            deliver: (async () => { delivered++; return null; }) as never,
        });
        assert.strictEqual(r, 'no_route');
        assert.strictEqual(delivered, 0);
        assert.strictEqual(updates.length, 0);
        assert.ok(/NOT sent an order confirmation/.test(String(buyerConfirmationLine(r))) && /yourself/.test(String(buyerConfirmationLine(r))));
    });

    await check('the account refuses it → "failed", not marked; no buyer email address → nothing to say', async () => {
        const { db, updates } = fakeDb();
        const r = await sendBuyerConfirmation(db, ORDER, SITE, '£12', null, null, {
            resolveRoute: (async () => ({ route: { provider: 'gmail', from: null, replyTo: null, engagementTracked: false } })) as never,
            deliver: (async () => { throw new Error('quota'); }) as never,
        });
        assert.strictEqual(r, 'failed');
        assert.strictEqual(updates.length, 0);
        assert.ok(buyerConfirmationLine('failed'));
        assert.strictEqual(buyerConfirmationLine('sent'), null);
        assert.strictEqual(buyerConfirmationLine('no_email'), null);
        assert.strictEqual(await sendBuyerConfirmation(db, { ...(ORDER as object), customerEmail: null } as never, SITE, '£12'), 'no_email');
    });

    await check('Shop tab warning: only while selling with no route', async () => {
        const none = (async () => ({ error: 'none' })) as never;
        const ok = (async () => ({ route: { provider: 'gmail' } })) as never;
        assert.ok(/no order confirmation email/.test(String(await buyerConfirmationsBlocked(fakeDb().db, 5, none))));
        assert.strictEqual(await buyerConfirmationsBlocked(fakeDb().db, 5, ok), null);
        assert.strictEqual(await buyerConfirmationsBlocked(fakeDb(null).db, 5, none), null, 'not selling yet: no warning');
    });

    await check('wired: no Be More Swan sender left in the shop; owner email carries the line; Shop tab + snapshot', async () => {
        const shop = read('src/utils/site-shop.ts');
        assert.ok(!/noreply@|\(via Be More Swan\)/.test(shop));
        assert.ok(shop.indexOf('const buyerSent = await sendBuyerConfirmation(') < shop.indexOf('subject: `New order from your website:'), 'buyer first, so the owner email can say');
        assert.ok(shop.includes("${buyerLine ? `<p><strong>⚠️ ${esc(buyerLine)}</strong></p>` : ''}"));
        assert.ok(read('netlify/functions/shop.ts').includes('confirmBlocked: await buyerConfirmationsBlocked(db, orgId),'));
        assert.ok(read('src/components/assistant-shop.js').includes('data-shop-confirm-blocked'));
        assert.ok(read('src/utils/shop-snapshot.ts').includes('ORDER CONFIRMATIONS: each buyer'));
    });

    console.log(`\n${passed}/${total} passed`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
