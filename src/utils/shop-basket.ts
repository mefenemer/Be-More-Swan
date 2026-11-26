// src/utils/shop-basket.ts — the online shop's basket (Phase 1, feature request #35,
// docs/online-shop-review-plan.md §6). tests/shop-basket.test.ts.
//
// ── Who gets one ────────────────────────────────────────────────────────────────────────────────
// Only a workspace with an active Shopkeeper Assistant (owner decision 5, 2026-11-15): its Buy buttons
// become "Add to basket". A website-only shop keeps today's one-product Buy button.
//
// ── How it is carried ───────────────────────────────────────────────────────────────────────────
// In the address, ?b=<id>: the *.bemoreswan.site host passes no cookies (sites-host/edge-functions/serve.ts)
// and only lets forms post to /_form, /_buy and /_book, so every basket action posts to /_buy with an `_a`.
// Pages are cached per address, so a page with ?b= is that buyer's own; links on it keep the ?b=.
// The id is 24 random url-safe characters and is the only key to a basket.
//
// ── What it holds ───────────────────────────────────────────────────────────────────────────────
// Product ids, option ids, the section that offered each, and quantities. Never a name or a price:
// those are read again from Business Information every time it is shown and at checkout (priceBasket),
// so a basket can never charge a price the owner has since changed. At Checkout the priced lines are
// saved on the basket (checkout_lines) with Stripe's session id; the webhook writes the order's lines
// from that snapshot and takes each line's stock.
//
// ⚠️ Raw SQL, and missing tables mean "no basket" (db/z-shop-basket.sql): code before the SQL keeps the
// one-product Buy button.

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import type { SiteDefinition } from './site-definition';
import type { SiteProduct } from './site-shop';
import { optionItemName, optionPence } from './shop-options';
import { formatMoney } from './product-price';

type Db = ReturnType<typeof getDb>;

export const BASKET_MAX_LINES = 20;
export const BASKET_LINE_MAX_QTY = 10;
/** A basket is fresh for a day after its last change; kept a week (for late webhooks), then deleted. */
export const BASKET_FRESH_HOURS = 24;
export const BASKET_KEEP_DAYS = 7;
export const BASKET_PATH = '/basket';

export interface BasketItem { productId: number; optionId: number | null; sectionId: string; qty: number }

/** An internal link that keeps this buyer's basket: '/shop#x' → '/shop?b=<id>#x'. Pure. */
export function withBasket(path: string, id: string): string {
    const at = path.indexOf('#');
    const base = at < 0 ? path : path.slice(0, at);
    const hash = at < 0 ? '' : path.slice(at);
    return `${base}${base.includes('?') ? '&' : '?'}b=${encodeURIComponent(id)}${hash}`;
}

export const newBasketId = (): string => randomBytes(18).toString('base64url');   // 24 characters
export const isBasketId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{24}$/.test(v);

/** Whatever is stored, as clean items (bad rows dropped, quantities capped). Pure. */
export function cleanItems(raw: unknown): BasketItem[] {
    if (!Array.isArray(raw)) return [];
    const out: BasketItem[] = [];
    for (const r of raw.slice(0, BASKET_MAX_LINES)) {
        const productId = Number((r as BasketItem)?.productId);
        const optionId = (r as BasketItem)?.optionId == null ? null : Number((r as BasketItem).optionId);
        const qty = Math.floor(Number((r as BasketItem)?.qty));
        const sectionId = String((r as BasketItem)?.sectionId ?? '').slice(0, 40);
        if (!Number.isInteger(productId) || productId <= 0 || (optionId !== null && (!Number.isInteger(optionId) || optionId <= 0)) || !sectionId || !(qty >= 1)) continue;
        out.push({ productId, optionId, sectionId, qty: Math.min(qty, BASKET_LINE_MAX_QTY) });
    }
    return out;
}

const sameLine = (a: BasketItem, b: Pick<BasketItem, 'productId' | 'optionId'>) => a.productId === b.productId && a.optionId === b.optionId;

/** Add one (or more) of a product/option: an existing line grows, up to the cap. Pure. */
export function addItem(items: BasketItem[], item: BasketItem): { items: BasketItem[]; error: string | null } {
    const at = items.findIndex((i) => sameLine(i, item));
    if (at >= 0) {
        const next = items.map((i, n) => (n === at ? { ...i, qty: Math.min(BASKET_LINE_MAX_QTY, i.qty + item.qty) } : i));
        return { items: next, error: null };
    }
    if (items.length >= BASKET_MAX_LINES) return { items, error: `A basket can hold up to ${BASKET_MAX_LINES} different items.` };
    return { items: [...items, { ...item, qty: Math.min(BASKET_LINE_MAX_QTY, Math.max(1, item.qty)) }], error: null };
}

/** Change a line's quantity (0 removes it). Pure. */
export function setQty(items: BasketItem[], index: number, qty: number): BasketItem[] {
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return items;
    const q = Math.floor(Number(qty));
    if (!(q >= 1)) return items.filter((_, n) => n !== index);
    return items.map((i, n) => (n === index ? { ...i, qty: Math.min(BASKET_LINE_MAX_QTY, q) } : i));
}

export interface PricedLine {
    index: number;
    productId: number;
    optionId: number | null;
    sectionId: string;
    name: string;
    /** Minor units of `currency`. */
    unit: number;
    qty: number;
    currency: string;
    /** The most this line may hold (stock and the cap); 0 = sold out. */
    max: number;
    imageAssetId: number | null;
    /** Why it can't be bought as it is, in the buyer's words; null when fine. */
    problem: string | null;
}

/**
 * Price every line from Business Information (never the basket). A line whose product is no longer offered
 * by its section on the PUBLISHED site, or can't be bought online, or whose option has gone, is dropped
 * with a note; a sold-out line or one asking for more than are left is kept with a `problem`. Pure.
 */
export function priceBasket(items: BasketItem[], products: Record<number, SiteProduct>, def: Pick<SiteDefinition, 'pages'>): { lines: PricedLine[]; dropped: string[] } {
    const sections = new Map(def.pages.flatMap((p) => p.sections).filter((s) => s.type === 'products').map((s) => [s.id, s.type === 'products' ? s.props.productIds : []]));
    const lines: PricedLine[] = [];
    const dropped: string[] = [];
    items.forEach((it, index) => {
        const p = products[it.productId];
        const offered = sections.get(it.sectionId)?.includes(it.productId);
        if (!p || !offered || p.buyPence == null) { dropped.push(p ? `${p.name} is no longer for sale here` : 'An item is no longer for sale here'); return; }
        const opts = p.options?.options ?? [];
        let name = p.name;
        let unit = p.buyPence;
        let stock = p.stock ?? null;
        if (opts.length) {
            const o = opts.find((x) => x.id === it.optionId);
            const pence = o ? optionPence(p.buyPence, o, p.currency) : null;
            if (!o || pence == null) { dropped.push(`${p.name}: that choice is no longer available`); return; }
            name = optionItemName(p.name, o.label);
            unit = pence;
            stock = o.stock;
        } else if (it.optionId !== null) { dropped.push(`${p.name}: that choice is no longer available`); return; }
        const max = stock == null ? BASKET_LINE_MAX_QTY : Math.max(0, Math.min(BASKET_LINE_MAX_QTY, stock));
        const problem = max === 0 ? 'Sold out' : it.qty > max ? `Only ${max} left` : null;
        lines.push({ index, productId: it.productId, optionId: it.optionId, sectionId: it.sectionId, name, unit, qty: it.qty, currency: (p.currency || 'GBP').toUpperCase(), max, imageAssetId: p.imageAssetId, problem });
    });
    return { lines, dropped };
}

/** What stops this basket going to checkout; null when it can. Pure. */
export function checkoutBlocker(lines: PricedLine[]): string | null {
    if (!lines.length) return 'Your basket is empty.';
    if (lines.some((l) => l.problem)) return 'Some items have changed: take out what\'s sold out, or lower the quantity, then check out.';
    if (new Set(lines.map((l) => l.currency)).size > 1) return 'These items are priced in different currencies, so they can\'t be paid for together. Please buy them separately.';
    return null;
}

export const basketTotal = (lines: PricedLine[]) => lines.reduce((n, l) => n + l.unit * l.qty, 0);
export const basketCount = (items: BasketItem[]) => items.reduce((n, i) => n + i.qty, 0);
export const lineTotalWords = (l: PricedLine) => formatMoney(l.unit * l.qty, l.currency);

/** "House Blend × 2, Mug + 1 more" — the order's one-line name (site_orders.item_name, 120 chars). Pure. */
export function orderSummaryName(lines: { name: string; qty: number }[]): string {
    const part = (l: { name: string; qty: number }) => (l.qty > 1 ? `${l.name} × ${l.qty}` : l.name);
    if (lines.length <= 2) return lines.map(part).join(', ').slice(0, 120);
    return `${part(lines[0])}, ${part(lines[1])} + ${lines.length - 2} more`.slice(0, 120);
}

// ── Storage (raw SQL; a missing table = no basket) ─────────────────────────────────────────────

export function isMissingBasketTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42P01' || /relation "?(site_baskets|site_order_lines)"? does not exist/i.test(String(e?.message ?? ''));
}
const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** Whether this workspace sells by basket: an active, unarchived Shopkeeper, and the tables exist. */
async function basketOnQuery(db: Db, orgId: number): Promise<boolean> {
    const [r] = asRows<{ enabled: boolean }>(await db.execute(sql`
        SELECT (EXISTS (SELECT 1 FROM ai_assistants WHERE organisation_id = ${orgId} AND is_active
                         AND lifecycle_status <> 'archived' AND configuration->>'type' = 'shopkeeper')
                AND to_regclass('public.site_baskets') IS NOT NULL) AS enabled`));
    return !!r?.enabled;
}

export async function basketOn(db: Db, orgId: number): Promise<boolean> {
    try {
        return await basketOnQuery(db, orgId);
    } catch (err) {
        console.error('[shop-basket] basketOn failed', err instanceof Error ? err.message : err);
        return false;
    }
}

const basketOnSeen = new Map<number, { on: boolean; at: number }>();
const BASKET_ON_TTL_MS = 60_000;

/**
 * basketOn for page views, remembered per workspace for a minute while the function instance lives (review #885:
 * one query fewer on every uncached page). A minute matches the pages' own public cache, so archiving the
 * Shopkeeper hides the basket no later than a cached page would. Checkout keeps the fresh basketOn.
 */
export async function basketOnCached(db: Db, orgId: number): Promise<boolean> {
    const seen = basketOnSeen.get(orgId);
    if (seen && Date.now() - seen.at < BASKET_ON_TTL_MS) return seen.on;
    let on: boolean;
    try { on = await basketOnQuery(db, orgId); }
    catch (err) {
        // A failed read isn't remembered (review #887): this view goes without the basket, the next one asks again.
        console.error('[shop-basket] basketOn failed', err instanceof Error ? err.message : err);
        return false;
    }
    if (basketOnSeen.size > 5000) basketOnSeen.clear();
    basketOnSeen.set(orgId, { on, at: Date.now() });
    return on;
}

/** A fresh basket of this site (null: none, another site's, or older than a day). */
export async function loadBasket(db: Db, siteId: number, id: unknown): Promise<{ id: string; items: BasketItem[] } | null> {
    if (!isBasketId(id)) return null;
    try {
        const [r] = asRows<{ id: string; items: unknown }>(await db.execute(sql`
            SELECT id, items FROM site_baskets
             WHERE id = ${id} AND site_id = ${siteId} AND updated_at > now() - make_interval(hours => ${BASKET_FRESH_HOURS})`));
        return r ? { id: r.id, items: cleanItems(r.items) } : null;
    } catch (err) {
        if (!isMissingBasketTable(err)) console.error('[shop-basket] read failed', err instanceof Error ? err.message : err);
        return null;
    }
}

/** Save the items: the same basket when `id` is this site's and fresh, else a new one. Returns its id. */
export async function saveBasket(db: Db, b: { id: string | null; siteId: number; orgId: number; items: BasketItem[] }): Promise<string> {
    const items = JSON.stringify(cleanItems(b.items));
    if (b.id && isBasketId(b.id)) {
        const [r] = asRows<{ id: string }>(await db.execute(sql`
            UPDATE site_baskets SET items = ${items}::jsonb, updated_at = now()
             WHERE id = ${b.id} AND site_id = ${b.siteId} AND updated_at > now() - make_interval(hours => ${BASKET_FRESH_HOURS})
         RETURNING id`));
        if (r) return r.id;
    }
    const id = newBasketId();
    await db.execute(sql`INSERT INTO site_baskets (id, site_id, organisation_id, items) VALUES (${id}, ${b.siteId}, ${b.orgId}, ${items}::jsonb)`);
    return id;
}

export interface CheckoutLine { productId: number; optionId: number | null; name: string; unit: number; qty: number }

/**
 * At Checkout: what Stripe is about to charge, saved on the basket UNDER THAT SESSION'S ID (checkout_lines is
 * { sessionId: lines }), so changing the basket afterwards, or opening a second checkout, never changes what
 * an earlier session's order records. checkout_session_id keeps the latest, for reading by eye.
 */
export async function markBasketCheckout(db: Db, basketId: string, siteId: number, lines: CheckoutLine[], sessionId: string): Promise<void> {
    await db.execute(sql`
        UPDATE site_baskets
           SET checkout_lines = (CASE WHEN jsonb_typeof(checkout_lines) = 'object' THEN checkout_lines ELSE '{}'::jsonb END)
                                || jsonb_build_object(${sessionId}::text, ${JSON.stringify(lines)}::jsonb),
               checkout_session_id = ${sessionId}, updated_at = now()
         WHERE id = ${basketId} AND site_id = ${siteId}`);
}

/** The webhook: the lines saved for THIS session of this workspace's basket (never trusted otherwise). */
export async function checkoutLinesFor(db: Db, orgId: number, basketId: unknown, sessionId: string): Promise<CheckoutLine[] | null> {
    if (!isBasketId(basketId)) return null;
    try {
        const [r] = asRows<{ lines: unknown }>(await db.execute(sql`
            SELECT checkout_lines -> ${sessionId}::text AS lines FROM site_baskets WHERE id = ${basketId} AND organisation_id = ${orgId}`));
        if (!r || !Array.isArray(r.lines)) return null;
        return (r.lines as CheckoutLine[]).filter((l) => l && Number.isInteger(l.productId) && l.qty >= 1 && l.unit >= 0 && typeof l.name === 'string');
    } catch (err) {
        if (isMissingBasketTable(err)) return null;
        throw err;
    }
}

/** Paid: empty the basket (its lines are now the order's). */
export async function emptyBasket(db: Db, basketId: string, orgId: number): Promise<void> {
    await db.execute(sql`UPDATE site_baskets SET items = '[]'::jsonb, updated_at = now() WHERE id = ${basketId} AND organisation_id = ${orgId}`);
}

/** All of an order's lines in ONE statement: every line is saved, or none. */
export async function writeOrderLines(db: Db, orderId: number, orgId: number, lines: CheckoutLine[]): Promise<void> {
    if (!lines.length) return;
    await db.execute(sql`
        INSERT INTO site_order_lines (order_id, organisation_id, product_id, option_id, item_name, unit_amount, quantity)
        VALUES ${sql.join(lines.map((l) => sql`(${orderId}, ${orgId}, ${l.productId}, ${l.optionId}, ${l.name.slice(0, 160)}, ${l.unit}, ${Math.min(100, l.qty)})`), sql`, `)}`);
}

export interface OrderLine { name: string; unit: number; qty: number }

/** Lines of these orders (only this workspace's), keyed by order id. Never throws: no table → {}. */
export async function loadOrderLines(db: Db, orgId: number, orderIds: number[]): Promise<Record<number, OrderLine[]>> {
    const ids = [...new Set(orderIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return {};
    try {
        const rows = asRows<{ order_id: number; item_name: string; unit_amount: number; quantity: number }>(await db.execute(sql`
            SELECT order_id, item_name, unit_amount, quantity FROM site_order_lines
             WHERE organisation_id = ${orgId} AND order_id IN (${sql.join(ids.map((n) => sql`${n}`), sql`, `)}) ORDER BY id`));
        const out: Record<number, OrderLine[]> = {};
        for (const r of rows) (out[Number(r.order_id)] ??= []).push({ name: r.item_name, unit: Number(r.unit_amount), qty: Number(r.quantity) });
        return out;
    } catch (err) {
        if (!isMissingBasketTable(err)) console.error('[shop-basket] order lines read failed', err instanceof Error ? err.message : err);
        return {};
    }
}

/** A reminded basket (shop-checkout-reminder.ts) is kept this long, so the reminder's unsubscribe link keeps working. */
export const REMINDED_BASKET_KEEP_DAYS = 60;

/** The daily sweep: baskets untouched for a week go; a reminded one stays 60 days from its reminder. */
export async function sweepBaskets(db: Db): Promise<number> {
    try {
        const rows = asRows<{ id: string }>(await db.execute(sql`
            DELETE FROM site_baskets WHERE updated_at < now() - make_interval(days => ${BASKET_KEEP_DAYS})
               AND (reminded_at IS NULL OR reminded_at < now() - make_interval(days => ${REMINDED_BASKET_KEEP_DAYS})) RETURNING id`));
        return rows.length;
    } catch (err) {
        if (isMissingBasketTable(err)) return 0;
        // Before db/z-shop-checkout-reminder.sql there is no reminded_at: the week-old rule alone.
        if ((err as { code?: string; cause?: { code?: string } })?.code === '42703' || (err as { cause?: { code?: string } })?.cause?.code === '42703') {
            const rows = asRows<{ id: string }>(await db.execute(sql`
                DELETE FROM site_baskets WHERE updated_at < now() - make_interval(days => ${BASKET_KEEP_DAYS}) RETURNING id`));
            return rows.length;
        }
        throw err;
    }
}
