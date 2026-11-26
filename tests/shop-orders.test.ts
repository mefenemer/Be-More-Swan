// tests/shop-orders.test.ts
// Online shop Phase 1, order statuses and CSV export (FR#35, docs/online-shop-review-plan.md §6 step 6):
// New → Posted (tracking number / link, emailed to the buyer from the owner's OWN Gmail or Outlook) → Dealt with;
// refunded stays refunded; "Mark as new" goes back to posted when it was posted; a CSV of every order
// (src/utils/shop-orders.ts). Shop tab and chat card save through one action (shop.ts order_update).
//
// Run:  npx tsx tests/shop-orders.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    csvCell, isMissingPostedColumn, markOrderPosted, ordersCsvText, orderStateWords, parseTracking, postedEmail, postedMessage, sendFromOwnInbox, setOrderDone,
    CSV_HEADERS, type MailSenders,
} from '../src/utils/shop-orders';
import { termsDeliveryChoices, type DeliverySetup } from '../src/utils/shop-delivery';
import { shopSnapshotText } from '../src/utils/shop-snapshot';
import { classifySql } from '../src/utils/issue-sql';
import { IntegrationError } from '../src/utils/workspace-integrations';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const sqlText = (q: unknown) => JSON.stringify((q as { queryChunks?: unknown })?.queryChunks ?? q);
type Db = Parameters<typeof markOrderPosted>[0];

const notConnected = () => new IntegrationError('not_connected', 'not connected');

/**
 * A fake database: `columns` = whether db/z-shop-orders.sql has run; `order` = the stored row. It keeps the
 * order's tracking and "buyer emailed" mark between calls, so repeat saves behave like the real UPDATEs.
 */
function fakeDb(o: { columns: boolean; order?: Record<string, unknown> | null }) {
    const exec: string[] = [];
    const row = o.order ? { ...o.order } : null;
    let claims = 0;
    const db = {
        execute: async (q: unknown) => {
            const t = sqlText(q); exec.push(t);
            if (t.includes('information_schema.columns')) return [{ n: o.columns ? 1 : 0 }];
            if (t.includes("SET status = 'posted'")) {
                if (!row || row.status === 'refunded') return [];
                // New tracking clears the "buyer emailed" mark (the CASE in the real UPDATE).
                const same = row.tracking_number != null && t.includes(JSON.stringify(row.tracking_number));
                if (!same) row.buyer_posted_emailed_at = null;
                const m = t.match(/"(AB[0-9A-Z]*)"/);
                row.tracking_number = m ? m[1] : null;
                row.status = 'posted';
                return [row];
            }
            if (t.includes('SELECT status FROM site_orders')) return row ? [{ status: row.status }] : [];
            if (t.includes('buyer_posted_emailed_at = clock_timestamp()')) { if (!row || row.buyer_posted_emailed_at) return []; row.buyer_posted_emailed_at = `claim-${++claims}`; return [{ id: 7, at: row.buyer_posted_emailed_at }]; }
            if (t.includes('buyer_posted_emailed_at = NULL')) { if (row && t.includes(JSON.stringify(row.buyer_posted_emailed_at))) row.buyer_posted_emailed_at = null; return []; }
            if (t.includes('UPDATE site_orders SET status =')) return [{ id: 7, status: t.includes("'done'") ? 'done' : t.includes('CASE WHEN posted_at') ? 'posted' : 'paid' }];
            return [];
        },
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    };
    return { db: db as unknown as Db, exec, row };
}

const ORDER = { id: 7, status: 'paid', posted_at: null, tracking_number: null, tracking_url: null, buyer_posted_emailed_at: null, customer_name: 'Sam', customer_email: 'sam@example.com', item_name: 'Mug', quantity: 2 };

(async () => {
    console.log('\nshop-orders');

    // Runs FIRST: ordersPostingOn remembers "on" once seen.
    await check('before db/z-shop-orders.sql: posting answers 503, and "Mark as new" sets paid without touching posted_at', async () => {
        const { db, exec } = fakeDb({ columns: false, order: ORDER });
        const r = await markOrderPosted(db, 1, 7, { trackingNumber: 'AB1' });
        assert.ok(!r.ok && r.status === 503 && /isn't switched on yet/.test(r.error));
        assert.strictEqual(await setOrderDone(db, 1, 7, false), 'paid');
        const upd = exec.find((t) => t.includes('UPDATE site_orders SET status ='))!;
        assert.ok(upd.includes("'paid'") && !upd.includes('posted_at'), upd);
    });

    await check('parseTracking: optional, letters/numbers/dashes, web links only, no credentials', () => {
        assert.deepStrictEqual(parseTracking({}), { ok: true, value: { number: null, url: null } });
        assert.deepStrictEqual(parseTracking({ trackingNumber: '  AB 1234  5678 GB ' }), { ok: true, value: { number: 'AB 1234 5678 GB', url: null } });
        assert.ok(!parseTracking({ trackingNumber: '<script>' }).ok);
        assert.ok(!parseTracking({ trackingNumber: 'A'.repeat(61) }).ok);
        const u = parseTracking({ trackingUrl: 'www.royalmail.com/track-your-item#/tracking-results/AB1' });
        assert.ok(u.ok && u.value.url === 'https://www.royalmail.com/track-your-item#/tracking-results/AB1');
        for (const bad of ['javascript:alert(1)', 'https://user:pw@evil.example', 'not a link', 'ftp://x.example/a', `https://x.example/${'a'.repeat(600)}`]) {
            assert.ok(!parseTracking({ trackingUrl: bad }).ok, bad);
        }
    });

    await check('isMissingPostedColumn: missing column, or the old status CHECK refusing "posted"', () => {
        assert.ok(isMissingPostedColumn(Object.assign(new Error('column "posted_at" does not exist'), { code: '42703' })));
        assert.ok(isMissingPostedColumn(Object.assign(new Error('new row for relation "site_orders" violates check constraint "site_orders_status_check"'), { code: '23514' })));
        assert.ok(!isMissingPostedColumn(new Error('connection reset')));
    });

    await check('posted: status, first posted time kept, tracking saved, buyer emailed from the owner\'s Gmail', async () => {
        const { db, exec } = fakeDb({ columns: true, order: ORDER });
        const sent: { to: string; subject: string; body: string; html?: string }[] = [];
        const senders: MailSenders = { gmail: async (m) => { sent.push(m); }, outlook: async () => { throw new Error('must not be tried'); } };
        const r = await markOrderPosted(db, 1, 7, { trackingNumber: 'AB123456789GB', trackingUrl: 'https://www.royalmail.com/track-your-item' }, senders);
        assert.ok(r.ok && r.emailed === 'gmail' && r.reason === 'sent');
        const upd = exec.find((t) => t.includes("SET status = 'posted'"))!;
        assert.ok(upd.includes('COALESCE(posted_at, now())') && upd.includes('AB123456789GB') && upd.includes("status <> 'refunded'") && upd.includes('organisation_id'));
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].to, 'sam@example.com');
        assert.ok(sent[0].subject.includes('on its way') && sent[0].body.includes('AB123456789GB') && sent[0].html!.includes('https://www.royalmail.com/track-your-item'));
        assert.ok(sent[0].body.includes('2 × Mug'));
        assert.ok(exec.some((t) => t.includes('buyer_posted_emailed_at = clock_timestamp()')));
        assert.ok(/from your Gmail/.test(postedMessage(r as Extract<typeof r, { ok: true }>, 7)));
    });

    await check('no Gmail → Outlook; neither → still posted, buyer NOT emailed, owner told (never a Be More Swan sender)', async () => {
        assert.strictEqual(await sendFromOwnInbox({ to: 'a@b.c', subject: 's', body: 'b' }, { gmail: async () => { throw notConnected(); }, outlook: async () => undefined }), 'outlook');
        const { db, exec } = fakeDb({ columns: true, order: ORDER });
        const r = await markOrderPosted(db, 1, 7, {}, { gmail: async () => { throw notConnected(); }, outlook: async () => { throw notConnected(); } });
        assert.ok(r.ok && r.emailed === null && r.reason === 'no_mailbox');
        assert.ok(exec.some((t) => t.includes("SET status = 'posted'")) && exec.some((t) => t.includes('buyer_posted_emailed_at = NULL')), 'the claim is released');
        assert.ok(/wasn't emailed: connect Gmail or Outlook/.test(postedMessage(r as Extract<typeof r, { ok: true }>, 7)));
        assert.ok(!read('src/utils/shop-orders.ts').includes('sendEmail('), 'posting never uses our own sender');
    });

    await check('a connected inbox that refuses: posted, reported as not sent, and Outlook not tried as well', async () => {
        const { db } = fakeDb({ columns: true, order: ORDER });
        let outlook = 0;
        const r = await markOrderPosted(db, 1, 7, {}, { gmail: async () => { throw new Error('quota'); }, outlook: async () => { outlook++; } });
        assert.ok(r.ok && r.reason === 'failed');
        assert.strictEqual(outlook as number, 0);
    });

    await check('already emailed this tracking: not again; changed tracking: emailed again', async () => {
        const f = fakeDb({ columns: true, order: { ...ORDER, status: 'posted', posted_at: '2026-11-24 10:00:00', tracking_number: 'AB1', buyer_posted_emailed_at: '2026-11-24 10:00:00' } });
        const count: { n: number } = { n: 0 };
        const senders: MailSenders = { gmail: async () => { count.n++; }, outlook: async () => { count.n++; } };
        const same = await markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB1' }, senders);
        assert.ok(same.ok && same.reason === 'unchanged' && count.n === 0);
        assert.ok(/already has these tracking details/.test(postedMessage(same as Extract<typeof same, { ok: true }>, 7)));
        const changed = await markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB2' }, senders);
        assert.ok(changed.ok && changed.reason === 'sent');
        assert.strictEqual(count.n as number, 1);
    });

    await check('review #883: the first email didn\'t go (no inbox), then Gmail connected and the SAME tracking saved → sent', async () => {
        const f = fakeDb({ columns: true, order: ORDER });
        const first = await markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB9' }, { gmail: async () => { throw notConnected(); }, outlook: async () => { throw notConnected(); } });
        assert.ok(first.ok && first.reason === 'no_mailbox' && f.row!.buyer_posted_emailed_at == null);
        assert.ok(/press "Save tracking"/.test(postedMessage(first as Extract<typeof first, { ok: true }>, 7)));
        let n = 0;
        const again = await markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB9' }, { gmail: async () => { n++; }, outlook: async () => { throw new Error('no'); } });
        assert.ok(again.ok && again.reason === 'sent' && n === 1);
    });

    await check('review #883: two saves at the same moment email the buyer once (the claim is one statement)', async () => {
        const f = fakeDb({ columns: true, order: ORDER });
        let n = 0;
        const senders: MailSenders = { gmail: async () => { n++; await new Promise((r) => setTimeout(r, 5)); }, outlook: async () => undefined };
        const [a, b] = await Promise.all([markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB5' }, senders), markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB5' }, senders)]);
        assert.strictEqual(n, 1);
        assert.deepStrictEqual([a, b].map((r) => r.ok && r.reason).sort(), ['sent', 'unchanged']);
        assert.ok(read('src/utils/shop-orders.ts').includes('SET buyer_posted_emailed_at = clock_timestamp() WHERE id = ${orderId} AND buyer_posted_emailed_at IS NULL RETURNING id'));
    });

    await check('review #883 note: a failed save undoes only its own claim, never another save\'s "emailed" mark', async () => {
        const f = fakeDb({ columns: true, order: ORDER });
        let releaseLate: () => void = () => undefined;
        const slow: MailSenders = { gmail: () => new Promise((_, rej) => { releaseLate = () => rej(new Error('refused')); }), outlook: async () => undefined };
        const a = markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB7' }, slow);
        await new Promise((r) => setTimeout(r, 5));
        // Meanwhile a second save with NEW tracking clears the mark, claims it again and sends.
        const b = await markOrderPosted(f.db, 1, 7, { trackingNumber: 'AB8' }, { gmail: async () => undefined, outlook: async () => undefined });
        assert.ok(b.ok && b.reason === 'sent');
        const held = f.row!.buyer_posted_emailed_at;
        releaseLate();
        const ra = await a;
        assert.ok(ra.ok && ra.reason === 'failed');
        assert.strictEqual(f.row!.buyer_posted_emailed_at, held, 'B\'s mark survives A\'s failure');
    });

    await check('refunded, unknown, bad tracking, no buyer email', async () => {
        const refunded = await markOrderPosted(fakeDb({ columns: true, order: { ...ORDER, status: 'refunded' } }).db, 1, 7, {});
        assert.ok(!refunded.ok && refunded.status === 409);
        const missing = await markOrderPosted(fakeDb({ columns: true, order: null }).db, 1, 7, {});
        assert.ok(!missing.ok && missing.status === 404);
        const bad = await markOrderPosted(fakeDb({ columns: true, order: ORDER }).db, 1, 7, { trackingUrl: 'javascript:x' });
        assert.ok(!bad.ok && bad.status === 400);
        const noEmail = await markOrderPosted(fakeDb({ columns: true, order: { ...ORDER, customer_email: null } }).db, 1, 7, {}, { gmail: async () => { throw new Error('no'); }, outlook: async () => { throw new Error('no'); } });
        assert.ok(noEmail.ok && noEmail.reason === 'no_email');
    });

    await check('"Mark as new" goes back to posted when it was posted; done; refunded never changed; one website only when asked', async () => {
        const { db, exec } = fakeDb({ columns: true });
        await setOrderDone(db, 1, 7, false);
        assert.ok(exec.at(-1)!.includes("CASE WHEN posted_at IS NOT NULL THEN 'posted' ELSE 'paid' END") && exec.at(-1)!.includes("status <> 'refunded'"));
        await setOrderDone(db, 1, 7, true, 12);
        assert.ok(exec.at(-1)!.includes("'done'") && exec.at(-1)!.includes('site_id'));
        assert.strictEqual(await setOrderDone(db, 1, 0, true), null);
        // review #883: the chat's "new" on a posted order is worded from where it ends up (still Posted).
        assert.ok(read('netlify/functions/shop.ts').includes("now === 'posted' ? `Order ${orderId} is no longer marked as dealt with: it's back to Posted.`"));
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('a posted order never goes back to New'));
        // review #883: a failed "Mark as posted" keeps what was typed.
        const tab = read('src/components/assistant-shop.js');
        assert.ok(tab.includes('state.ordersError = err.message; state.postDraft = typed;') && tab.includes('data-post-number value="${esc(num)}"'));
    });

    await check('postedEmail escapes the buyer\'s and business\'s names', () => {
        const m = postedEmail({ orderId: 3, customerName: '<b>Sam</b>', business: 'Tea & Co', items: '1 × Mug', tracking: { number: null, url: 'https://t.example/?a=1&b="2"' } });
        assert.ok(!m.html.includes('<b>Sam</b>') && m.html.includes('&lt;b&gt;Sam&lt;/b&gt;') && m.html.includes('Tea &amp; Co') && !m.html.includes('"2"'));
        assert.ok(m.subject === 'Your order from Tea & Co is on its way');
    });

    await check('CSV: header, one row per order, quoting, formula injection made plain, basket lines, delivery and tracking', () => {
        assert.strictEqual(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
        assert.strictEqual(csvCell('+44 7700'), "'+44 7700");
        assert.strictEqual(csvCell('a,b'), '"a,b"');
        assert.strictEqual(csvCell(null), '');
        const text = ordersCsvText([
            { id: 9, createdAt: new Date('2026-11-25T10:30:00Z'), status: 'posted', itemName: 'Order of 2 items', quantity: 1, amountTotal: 2895, currency: 'gbp', refundedAmount: 0,
                customerName: 'Sam Smith', customerEmail: 'sam@example.com', shippingAddress: { name: 'Sam', address: { line1: '1 High St', line2: null, city: 'Leeds', postal_code: 'LS1 1AA', country: 'GB' } } },
            { id: 8, createdAt: new Date('2026-11-24T09:00:00Z'), status: 'refunded', itemName: 'Gift card', quantity: 1, amountTotal: 1000, currency: 'usd', refundedAmount: 1000, customerName: '=cmd|x', customerEmail: null, shippingAddress: null },
        ], {
            lines: { 9: [{ name: 'House Blend', qty: 2 }, { name: 'Mug — Large', qty: 1 }] },
            delivery: { 9: { name: 'Royal Mail Tracked 48', amount: 395 } },
            posting: { 9: { postedAt: new Date(), trackingNumber: 'AB1', trackingUrl: 'https://t.example/AB1', buyerToldAt: null } },
        });
        const rows = text.split('\r\n');
        assert.strictEqual(rows[0], CSV_HEADERS.join(','));
        assert.strictEqual(rows[1], '9,2026-11-25 10:30,Posted,2 × House Blend; 1 × Mug — Large,28.95,GBP,,Royal Mail Tracked 48,3.95,Sam Smith,sam@example.com,1 High St,,Leeds,LS1 1AA,GB,AB1,https://t.example/AB1');
        assert.ok(rows[2].startsWith("8,2026-11-24 09:00,Refunded,1 × Gift card,10.00,USD,10.00,,,'=cmd|x,"), rows[2]);
        assert.strictEqual(rows.length, 4);   // header, 2 rows, trailing CRLF
    });

    await check('snapshot: posted orders with tracking; NEW counted; posting off says so', () => {
        const base = { connected: true, chargesEnabled: true, shop: null, stock: undefined, options: {}, delivery: null };
        const orders = [
            { id: 5, itemName: 'Mug', quantity: 1, amountTotal: 1200, currency: 'gbp', customerName: 'Sam', status: 'posted', refundedAmount: 0, createdAt: new Date('2026-11-25') },
            { id: 4, itemName: 'Tote', quantity: 1, amountTotal: 900, currency: 'gbp', customerName: 'Jo', status: 'paid', refundedAmount: 0, createdAt: new Date('2026-11-24') },
        ];
        const t = shopSnapshotText({ ...base, orders, posting: { 5: { postedAt: new Date(), trackingNumber: 'AB1', trackingUrl: null, buyerToldAt: null } }, postingOn: true } as Parameters<typeof shopSnapshotText>[0]);
        assert.ok(t.includes('#5 2026-11-25: 1 × Mug') && t.includes('posted, tracking AB1') && t.includes('#4') && t.includes('— NEW') && t.includes('1 NEW'));
        const off = shopSnapshotText({ ...base, orders, postingOn: false } as Parameters<typeof shopSnapshotText>[0]);
        assert.ok(off.includes('Marking orders as posted isn\'t switched on yet'));
        assert.strictEqual(orderStateWords({ status: 'done', refundedAmount: 300, currency: 'gbp' }), 'dealt with, part refunded (£3)');
    });

    await check('Delivery & returns page: pound choices hidden when nothing is priced in pounds, noted when only some are', () => {
        const s: DeliverySetup = { rates: [{ name: 'Standard', price: 350, freeOver: null, days: null }], collect: { on: false, note: null } };
        assert.strictEqual(termsDeliveryChoices(s, 'none'), null);
        assert.ok(termsDeliveryChoices(s, 'all')!.startsWith('Standard') && !termsDeliveryChoices(s, 'all')!.includes('priced in pounds'));
        assert.ok(termsDeliveryChoices(s, 'some')!.endsWith('(for orders priced in pounds)'));
        assert.strictEqual(termsDeliveryChoices(null, 'all'), null);
        assert.ok(read('netlify/functions/site-serve.ts').includes('termsDeliveryChoices(await loadDelivery(db, site.organisationId), await poundsPriced(db, site.organisationId))'));
    });

    await check('SQL file: additive, idempotent, adds "posted" to the status CHECK; columns stay out of the Drizzle table', () => {
        const f = read('db/z-shop-orders.sql');
        // "manual", not "additive": it widens the status CHECK (drop + add in one transaction). Nothing else refused.
        const c = classifySql(f);
        assert.ok(c.safety === 'manual' && c.refused.length === 2 && c.refused.every((r) => r.includes('site_orders_status_check')), JSON.stringify(c.refused));
        assert.ok(f.includes('ADD COLUMN IF NOT EXISTS posted_at') && f.includes("CHECK (status IN ('paid', 'posted', 'done', 'refunded'))") && f.includes('DROP CONSTRAINT IF EXISTS site_orders_status_check'));
        const table = read('db/schema.ts').split('export const siteOrders = pgTable')[1].split('});')[0];
        assert.ok(!table.includes('posted_at') && !table.includes('tracking_') && table.includes("'paid','posted','done','refunded'"));
    });

    await check('wiring: shop.ts actions, Shop tab buttons, chat card, prompt, manifest, review asks include posted orders', () => {
        const fn = read('netlify/functions/shop.ts');
        assert.ok(fn.includes("if (action === 'order_update') {") && fn.includes('markOrderPosted(db, orgId, orderId,') && fn.includes('postedMessage(r, orderId)'));
        assert.ok(fn.includes("if (action === 'orders_csv') {") && fn.includes("if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can download the orders.' });"));
        const tab = read('src/components/assistant-shop.js');
        assert.ok(tab.includes("action: 'order_update', id, status: 'posted'") && tab.includes("action: 'orders_csv'") && tab.includes("btn('data-shop-csv', 'Download CSV')") && tab.includes('d.postingOn && o.status !=='));
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('order_update', renderOrderUpdateCard);") && reg.includes("new CustomEvent('shop:orderUpdate'"));
        const chat = read('src/components/chat-session.js');
        assert.ok(chat.includes("container.addEventListener('shop:orderUpdate', onOrderUpdate);") && chat.includes("action: 'order_update', assistantId"));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('emit {"type":"order_update","orderId":') && orch.includes('| { "type": "order_update", … } |'));
        assert.ok(read('src/config/chat-capabilities.generated.ts').includes('"order_update"'));
        assert.ok(read('src/utils/review-requests.ts').includes("inArray(siteOrders.status, ['paid', 'posted', 'done'])"));
        assert.ok(read('src/components/assistant-site-editor.js').includes("o.status === 'posted' ? '<span class=\"text-xs font-bold text-gray-700\">· Posted</span>'"));
    });

    console.log(`\n${passed}/${total} passed`);
})();
