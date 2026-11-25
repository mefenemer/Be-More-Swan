// src/utils/shop-orders.ts — order statuses and the CSV export (online shop Phase 1, feature request #35,
// docs/online-shop-review-plan.md §6 step 6). tests/shop-orders.test.ts.
//
// Statuses on site_orders.status:
//   paid      "New" — paid, nothing done yet
//   posted    sent to the buyer, with an optional tracking number and/or tracking link
//   done      dealt with (collected, delivered, a service given)
//   refunded  refunded in full in Stripe (charge.refunded) — never changed from here
// "Mark as new" on a done order goes back to posted when it was posted, else to paid.
//
// Posting emails the buyer "on its way" FROM THE OWNER'S OWN Gmail or Outlook (owner, 2026-11-17: Be More
// Swan never sends a customer's email from its own domain). With neither connected the order is still marked
// posted and the owner is told the buyer wasn't emailed. The order confirmation is different: it is the legal
// receipt (CCR 2013) and stays as it is (site-shop.ts sendBuyerConfirmation).
//
// Set from the Shopkeeper's Shop tab and its chat card `order_update` (shop.ts order_update / order_done).
//
// ⚠️ Raw SQL, columns kept out of db/schema.ts (db/z-shop-orders.sql): site-shop.ts selects whole order rows.
// Before the SQL: no posting (a 503 that says so), and every other status works as before.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { formatMoney } from './product-price';
import { esc } from './site-render';
import { IntegrationError } from './workspace-integrations';

type Db = ReturnType<typeof getDb>;

export const TRACKING_NUMBER_MAX = 60;
export const TRACKING_URL_MAX = 500;
export const CSV_ORDER_LIMIT = 5000;
export const ORDER_STATUSES = ['paid', 'posted', 'done', 'refunded'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

/** What the owner sees for each status (Shop tab, chat, CSV). */
export const STATUS_WORDS: Record<OrderStatus, string> = { paid: 'New', posted: 'Posted', done: 'Dealt with', refunded: 'Refunded' };

export interface Tracking { number: string | null; url: string | null }

const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** A tracking number and/or link as typed. Both optional (a letter, or delivered by hand). Pure. */
export function parseTracking(input: { trackingNumber?: unknown; trackingUrl?: unknown }): { ok: true; value: Tracking } | { ok: false; error: string } {
    const num = String(input.trackingNumber ?? '').replace(/\s+/g, ' ').trim();
    const rawUrl = String(input.trackingUrl ?? '').trim();
    if (num && (num.length > TRACKING_NUMBER_MAX || !/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(num))) {
        return { ok: false, error: `The tracking number can only have letters, numbers, spaces and dashes (up to ${TRACKING_NUMBER_MAX}).` };
    }
    let url: string | null = null;
    if (rawUrl) {
        let u: URL | null = null;
        try { u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); } catch { u = null; }
        if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes('.') || u.toString().length > TRACKING_URL_MAX) {
            return { ok: false, error: 'The tracking link must be a web address, like https://www.royalmail.com/track-your-item.' };
        }
        url = u.toString();
    }
    return { ok: true, value: { number: num || null, url } };
}

/** The posting columns or the 'posted' status aren't on this database yet (db/z-shop-orders.sql). */
export function isMissingPostedColumn(err: unknown): boolean {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
    const code = e?.code ?? e?.cause?.code;
    const msg = String(e?.message ?? '') + String(e?.cause?.message ?? '');
    return code === '42703' || /column "?(posted_at|tracking_number|tracking_url|buyer_posted_emailed_at)"? does not exist/i.test(msg)
        || ((code === '23514' || /violates check constraint/i.test(msg)) && /site_orders_status_check/.test(msg));
}

let postingSeen = false;
/** Whether db/z-shop-orders.sql has reached this database. Remembered once true. Never throws. */
export async function ordersPostingOn(db: Db): Promise<boolean> {
    if (postingSeen) return true;
    try {
        const rows = asRows<{ n: unknown }>(await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'site_orders' AND column_name = 'posted_at'`));
        postingSeen = Number(rows[0]?.n ?? 0) > 0;
    } catch { /* treated as off */ }
    return postingSeen;
}

/**
 * "Mark as dealt with" (done) or "Mark as new" (back to posted if it was posted, else paid). A refund stays a
 * refund. `siteId` limits it to one website's orders (the Website Assistant's Orders tab). Returns false when
 * no such order (or it was refunded).
 */
export async function setOrderDone(db: Db, orgId: number, orderId: number, done: boolean, siteId: number | null = null): Promise<boolean> {
    if (!Number.isInteger(orderId) || orderId <= 0) return false;
    const site = siteId == null ? sql`` : sql` AND site_id = ${siteId}`;
    const next = done ? sql`'done'` : (await ordersPostingOn(db)) ? sql`CASE WHEN posted_at IS NOT NULL THEN 'posted' ELSE 'paid' END` : sql`'paid'`;
    const rows = asRows<{ id: number }>(await db.execute(sql`
        UPDATE site_orders SET status = ${next}
         WHERE id = ${orderId} AND organisation_id = ${orgId}${site} AND status <> 'refunded'
        RETURNING id`));
    return rows.length > 0;
}

export interface OrderPosting { postedAt: Date | null; trackingNumber: string | null; trackingUrl: string | null; buyerToldAt: Date | null }

/** Posting details by order id (only orders that were posted). Never throws: before the SQL → {}. */
export async function loadOrderPosting(db: Db, orgId: number, orderIds: number[]): Promise<Record<number, OrderPosting>> {
    const ids = [...new Set(orderIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length || !(await ordersPostingOn(db))) return {};
    try {
        const rows = asRows<{ id: number; posted_at: unknown; tracking_number: string | null; tracking_url: string | null; buyer_posted_emailed_at: unknown }>(await db.execute(sql`
            SELECT id, posted_at, tracking_number, tracking_url, buyer_posted_emailed_at FROM site_orders
             WHERE organisation_id = ${orgId} AND id IN (${sql.join(ids.map((n) => sql`${n}`), sql`, `)}) AND posted_at IS NOT NULL`));
        const at = (v: unknown) => (v == null ? null : new Date(String(v)));
        return Object.fromEntries(rows.map((r) => [Number(r.id), { postedAt: at(r.posted_at), trackingNumber: r.tracking_number, trackingUrl: r.tracking_url, buyerToldAt: at(r.buyer_posted_emailed_at) }]));
    } catch (err) {
        if (!isMissingPostedColumn(err)) console.error('[shop-orders] posting read failed', err instanceof Error ? err.message : err);
        return {};
    }
}

/** "Your order is on its way" — from the business, to the buyer. Pure. */
export function postedEmail(o: { orderId: number; customerName: string | null; business: string; items: string; tracking: Tracking }): { subject: string; text: string; html: string } {
    const t = o.tracking;
    const trackText = [t.number ? `Tracking number: ${t.number}` : '', t.url ? `Track it here: ${t.url}` : ''].filter(Boolean);
    return {
        subject: `Your order from ${o.business} is on its way`,
        text: [`Hi ${o.customerName || 'there'},`, '', `Good news: your order (reference ${o.orderId}) has been sent.`, '', `Your order: ${o.items}`,
            ...(trackText.length ? ['', ...trackText] : []), '', 'Thank you for buying from us.', o.business].join('\n'),
        html: `<p>Hi ${esc(o.customerName || 'there')},</p>
<p>Good news: your order (reference ${o.orderId}) has been sent.</p>
<p><strong>Your order:</strong> ${esc(o.items)}</p>
${t.number ? `<p><strong>Tracking number:</strong> ${esc(t.number)}</p>` : ''}
${t.url ? `<p><a href="${esc(t.url)}">Track your parcel</a></p>` : ''}
<p>Thank you for buying from us.<br>${esc(o.business)}</p>`,
    };
}

export interface MailSenders {
    gmail: (m: { to: string; subject: string; body: string; html?: string }) => Promise<unknown>;
    outlook: (m: { to: string; subject: string; body: string; html?: string }) => Promise<unknown>;
}

/** The owner's Gmail, then Outlook; null when neither is connected. Throws when a connected inbox refuses. */
export async function sendFromOwnInbox(m: { to: string; subject: string; body: string; html?: string }, senders: MailSenders): Promise<'gmail' | 'outlook' | null> {
    for (const via of ['gmail', 'outlook'] as const) {
        try { await senders[via](m); return via; }
        catch (err) { if (!(err instanceof IntegrationError)) throw err; }
    }
    return null;
}

async function defaultSenders(db: Db, orgId: number): Promise<MailSenders> {
    const [{ sendGmailMessage }, { sendOutlookMessage }] = await Promise.all([import('./gmail'), import('./outlook')]);
    return { gmail: (m) => sendGmailMessage(db, orgId, m), outlook: (m) => sendOutlookMessage(db, orgId, m) };
}

export type PostResult =
    | { ok: true; emailed: 'gmail' | 'outlook' | null; reason: 'sent' | 'no_email' | 'no_mailbox' | 'failed' | 'unchanged'; tracking: Tracking }
    | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/**
 * Mark an order as posted, with its tracking. Emails the buyer the first time, and again only when the tracking
 * changes. A refunded order can't be posted. `senders` is for tests.
 */
export async function markOrderPosted(db: Db, orgId: number, orderId: number, input: { trackingNumber?: unknown; trackingUrl?: unknown }, senders?: MailSenders): Promise<PostResult> {
    if (!Number.isInteger(orderId) || orderId <= 0) return { ok: false, status: 404, error: 'Order not found.' };
    const parsed = parseTracking(input);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const t = parsed.value;
    if (!(await ordersPostingOn(db))) return { ok: false, status: 503, error: 'Marking orders as posted isn\'t switched on yet. Please try again later.' };
    type Row = { id: number; status: string; posted_at: unknown; tracking_number: string | null; tracking_url: string | null; customer_name: string | null; customer_email: string | null; item_name: string; quantity: number };
    let before: Row | undefined;
    try {
        [before] = asRows<Row>(await db.execute(sql`
            SELECT id, status, posted_at, tracking_number, tracking_url, customer_name, customer_email, item_name, quantity
              FROM site_orders WHERE id = ${orderId} AND organisation_id = ${orgId}`));
        if (!before) return { ok: false, status: 404, error: 'Order not found.' };
        if (before.status === 'refunded') return { ok: false, status: 409, error: 'This order was refunded, so it can\'t be marked as posted.' };
        const done = asRows<{ id: number }>(await db.execute(sql`
            UPDATE site_orders SET status = 'posted', posted_at = COALESCE(posted_at, now()), tracking_number = ${t.number}, tracking_url = ${t.url}
             WHERE id = ${orderId} AND organisation_id = ${orgId} AND status <> 'refunded' RETURNING id`));
        if (!done.length) return { ok: false, status: 409, error: 'This order was refunded, so it can\'t be marked as posted.' };
    } catch (err) {
        if (isMissingPostedColumn(err)) return { ok: false, status: 503, error: 'Marking orders as posted isn\'t switched on yet. Please try again later.' };
        throw err;
    }
    const wasPosted = before.posted_at != null;
    const changed = (before.tracking_number ?? null) !== t.number || (before.tracking_url ?? null) !== t.url;
    if (wasPosted && !changed) return { ok: true, emailed: null, reason: 'unchanged', tracking: t };
    if (!before.customer_email) return { ok: true, emailed: null, reason: 'no_email', tracking: t };

    const { loadShopSettings } = await import('./shop-settings');
    const { loadOrderLines } = await import('./shop-basket');
    const [shop, lines] = await Promise.all([loadShopSettings(db, orgId).catch(() => null), loadOrderLines(db, orgId, [orderId])]);
    const items = (lines[orderId] ?? []).length ? lines[orderId].map((l) => `${l.qty} × ${l.name}`).join(', ') : `${before.quantity} × ${before.item_name}`;
    const mail = postedEmail({ orderId, customerName: before.customer_name, business: shop?.traderName || 'us', items, tracking: t });
    try {
        const via = await sendFromOwnInbox({ to: before.customer_email.replace(/[\r\n,;]/g, ''), subject: mail.subject, body: mail.text, html: mail.html }, senders ?? await defaultSenders(db, orgId));
        if (!via) return { ok: true, emailed: null, reason: 'no_mailbox', tracking: t };
        await db.execute(sql`UPDATE site_orders SET buyer_posted_emailed_at = now() WHERE id = ${orderId}`).catch(() => undefined);
        return { ok: true, emailed: via, reason: 'sent', tracking: t };
    } catch (err) {
        console.error('[shop-orders] posted email not sent', err instanceof Error ? err.message : err);
        return { ok: true, emailed: null, reason: 'failed', tracking: t };
    }
}

/** What the Shop tab and the chat card say after posting. Pure. */
export function postedMessage(r: Extract<PostResult, { ok: true }>, orderId: number): string {
    const head = `Order ${orderId} marked as posted.`;
    switch (r.reason) {
        case 'sent': return `${head} The buyer was emailed${r.tracking.number || r.tracking.url ? ' the tracking details' : ''} from your ${r.emailed === 'gmail' ? 'Gmail' : 'Outlook'}.`;
        case 'unchanged': return `${head} The tracking didn't change, so the buyer wasn't emailed again.`;
        case 'no_email': return `${head} There's no email address for the buyer, so they weren't told.`;
        case 'no_mailbox': return `${head} The buyer wasn't emailed: connect Gmail or Outlook in Connections and we'll send it from your own inbox next time. You can email them the tracking yourself.`;
        default: return `${head} The email to the buyer didn't go: your inbox refused it. You can email them the tracking yourself.`;
    }
}

// ── CSV export ──────────────────────────────────────────────────────────────────────────────────────────

/** One CSV cell: quoted, and a leading = + - @ (a spreadsheet formula) made plain text. Pure. */
export function csvCell(v: unknown): string {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADERS = ['Order', 'Date', 'Status', 'Items', 'Total', 'Currency', 'Refunded', 'Delivery', 'Delivery cost', 'Buyer', 'Email',
    'Address line 1', 'Address line 2', 'Town or city', 'Postcode', 'Country', 'Tracking number', 'Tracking link'] as const;

export interface CsvOrder {
    id: number; createdAt: Date; status: string; itemName: string; quantity: number; amountTotal: number; currency: string; refundedAmount: number;
    customerName: string | null; customerEmail: string | null; shippingAddress: unknown;
}

const pounds = (minor: number | null | undefined) => (minor == null ? '' : (minor / 100).toFixed(2));

/** The CSV text (header row, then one row per order, newest first), CRLF line ends. Pure. */
export function ordersCsvText(orders: CsvOrder[], extra: {
    lines?: Record<number, { name: string; qty: number }[]>;
    delivery?: Record<number, { name: string | null; amount: number | null }>;
    posting?: Record<number, OrderPosting>;
} = {}): string {
    const rows = orders.map((o) => {
        const a = (o.shippingAddress as { name?: string; address?: Record<string, string | null> } | null)?.address ?? {};
        const items = (extra.lines?.[o.id] ?? []).length ? extra.lines![o.id].map((l) => `${l.qty} × ${l.name}`).join('; ') : `${o.quantity} × ${o.itemName}`;
        const d = extra.delivery?.[o.id];
        const p = extra.posting?.[o.id];
        return [o.id, o.createdAt.toISOString().slice(0, 16).replace('T', ' '), STATUS_WORDS[o.status as OrderStatus] ?? o.status, items,
            pounds(o.amountTotal), o.currency.toUpperCase(), o.refundedAmount ? pounds(o.refundedAmount) : '', d?.name ?? '', d ? pounds(d.amount) : '',
            o.customerName ?? '', o.customerEmail ?? '', a.line1 ?? '', a.line2 ?? '', a.city ?? '', a.postal_code ?? '', a.country ?? '',
            p?.trackingNumber ?? '', p?.trackingUrl ?? ''].map(csvCell).join(',');
    });
    return [CSV_HEADERS.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}

/** The workspace's orders as a CSV file (the newest CSV_ORDER_LIMIT). */
export async function ordersCsv(db: Db, orgId: number, now = new Date()): Promise<{ filename: string; csv: string; count: number }> {
    const rows = asRows<{ id: number; created_at: unknown; status: string; item_name: string; quantity: number; amount_total: number; currency: string; refunded_amount: number; customer_name: string | null; customer_email: string | null; shipping_address: unknown }>(await db.execute(sql`
        SELECT id, created_at, status, item_name, quantity, amount_total, currency, refunded_amount, customer_name, customer_email, shipping_address
          FROM site_orders WHERE organisation_id = ${orgId} ORDER BY created_at DESC, id DESC LIMIT ${CSV_ORDER_LIMIT}`));
    const orders: CsvOrder[] = rows.map((r) => ({
        id: Number(r.id), createdAt: new Date(String(r.created_at)), status: r.status, itemName: r.item_name, quantity: Number(r.quantity), amountTotal: Number(r.amount_total),
        currency: r.currency, refundedAmount: Number(r.refunded_amount ?? 0), customerName: r.customer_name, customerEmail: r.customer_email,
        shippingAddress: typeof r.shipping_address === 'string' ? JSON.parse(r.shipping_address) : r.shipping_address,
    }));
    const ids = orders.map((o) => o.id);
    const [{ loadOrderLines }, { loadOrderDelivery }] = await Promise.all([import('./shop-basket'), import('./shop-delivery')]);
    const [lines, delivery, posting] = ids.length
        ? await Promise.all([loadOrderLines(db, orgId, ids), loadOrderDelivery(db, orgId, ids), loadOrderPosting(db, orgId, ids)])
        : [{}, {}, {}];
    return { filename: `orders-${now.toISOString().slice(0, 10)}.csv`, csv: ordersCsvText(orders, { lines, delivery, posting }), count: orders.length };
}

/** For the snapshot / tab: an order's state in words, posting included. Pure. */
export function orderStateWords(o: { status: string; refundedAmount: number; currency: string }, p?: OrderPosting | null): string {
    if (o.status === 'refunded') return 'refunded';
    const part = o.refundedAmount > 0 ? `part refunded (${formatMoney(o.refundedAmount, o.currency)})` : '';
    if (o.status === 'posted') return [`posted${p?.trackingNumber ? `, tracking ${p.trackingNumber}` : ''}`, part].filter(Boolean).join(', ');
    if (o.status === 'done') return ['dealt with', part].filter(Boolean).join(', ');
    return part || 'NEW';
}
