// src/utils/shop-stock.ts — stock levels for the online shop (Phase 1, feature request #35,
// docs/online-shop-review-plan.md §6). tests/shop-stock.test.ts.
//
// One number per product, on the shared Business Information row (org_products.stock, low_stock_at;
// db/z-shop-stock.sql):
//   stock NULL  → not tracked: always buyable (how every product behaved before Phase 1)
//   stock 0     → "Sold out" on the site, and checkout refuses
//   stock N     → a buyer can take at most N (and never more than MAX_QUANTITY) in one checkout
// Stock is taken when Stripe says an order is PAID (recordPaidCheckout), never when a checkout starts:
// an abandoned checkout holds nothing. Two buyers can pay for the last one at the same moment; the
// count then stops at 0 and the owner's order email says it was oversold, so they can refund or restock.
//
// Who sets it: the Shopkeeper's Shop tab and its chat card `product_stock` — the same server action
// (shop.ts product_stock → saveProductStock), as every capability is GUI and chat alike.
//
// ⚠️ The columns are NOT in db/schema.ts (see the SQL file): every read and write here is raw SQL, and a
// database without them reads as "nothing tracked" and refuses saves with a plain message.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { buyablePence, formatMoney } from './product-price';

type Db = ReturnType<typeof getDb>;

export const STOCK_MAX = 100_000;

export type StockState = 'untracked' | 'in_stock' | 'low' | 'sold_out';

export interface StockLevel { stock: number | null; lowStockAt: number | null }

/** Where a product's stock stands. Pure. */
export function stockState(stock: number | null | undefined, lowStockAt?: number | null): StockState {
    if (stock == null) return 'untracked';
    if (stock <= 0) return 'sold_out';
    if (lowStockAt != null && stock <= lowStockAt) return 'low';
    return 'in_stock';
}

/** The most a buyer may choose in one checkout: the cap, or fewer when fewer are left. 0 = sold out. */
export function maxBuyable(stock: number | null | undefined, cap: number): number {
    if (stock == null) return cap;
    return Math.max(0, Math.min(cap, Math.floor(stock)));
}

/** "12 in stock", "Only 2 left (warn at 3)", "Sold out", "Not tracked" — the owner's words. Pure. */
export function stockWords(level: StockLevel): string {
    const s = stockState(level.stock, level.lowStockAt);
    if (s === 'untracked') return 'Not tracked';
    if (s === 'sold_out') return 'Sold out';
    const warn = level.lowStockAt != null ? ` (low at ${level.lowStockAt})` : '';
    return s === 'low' ? `Low: ${level.stock} left${warn}` : `${level.stock} in stock${warn}`;
}

type Parsed = { ok: true; value: Partial<StockLevel> } | { ok: false; error: string };

function oneNumber(v: unknown, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
    if (v === null || v === '' || (typeof v === 'string' && !v.trim())) return { ok: true, value: null };
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > STOCK_MAX) return { ok: false, error: `${label} must be a whole number from 0 to ${STOCK_MAX.toLocaleString('en-GB')}, or left empty.` };
    return { ok: true, value: n };
}

/**
 * A save from the Shop tab or the chat card, checked. A key that is absent is left as it is; null or
 * an empty box clears it ("not tracked" / "no warning"). Pure.
 */
export function parseStockInput(raw: { stock?: unknown; lowStockAt?: unknown }): Parsed {
    const value: Partial<StockLevel> = {};
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'stock')) {
        const r = oneNumber(raw.stock, 'Stock');
        if (!r.ok) return r;
        value.stock = r.value;
    }
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'lowStockAt')) {
        const r = oneNumber(raw.lowStockAt, 'The low-stock level');
        if (!r.ok) return r;
        value.lowStockAt = r.value;
    }
    if (!('stock' in value) && !('lowStockAt' in value)) return { ok: false, error: 'Nothing to change: give a stock number or a low-stock level.' };
    return { ok: true, value };
}

/** Postgres "column does not exist": db/z-shop-stock.sql has not run on this database. */
export function isMissingStockColumn(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42703' || /column "?(stock|low_stock_at)"? does not exist/i.test(String(e?.message ?? ''));
}

const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Stock for these products of this workspace, keyed by id. Never throws: no columns → {} (untracked). */
export async function loadStockLevels(db: Db, orgId: number, ids: number[]): Promise<Record<number, StockLevel>> {
    const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return {};
    try {
        const rows = asRows<{ id: number; stock: unknown; low_stock_at: unknown }>(await db.execute(sql`
            SELECT id, stock, low_stock_at FROM org_products
             WHERE organisation_id = ${orgId} AND id IN (${sql.join(clean.map((n) => sql`${n}`), sql`, `)})`));
        return Object.fromEntries(rows.map((r) => [Number(r.id), { stock: numOrNull(r.stock), lowStockAt: numOrNull(r.low_stock_at) }]));
    } catch (err) {
        if (!isMissingStockColumn(err)) console.error('[shop-stock] read failed', err instanceof Error ? err.message : err);
        return {};
    }
}

export interface StockItem extends StockLevel {
    id: number;
    name: string;
    /** The displayed price, e.g. "£24". */
    price: string;
    state: StockState;
}

/**
 * The products a shop can sell (active, with a fixed price that can be bought online), with their stock,
 * in Business Information's order. `ready` is false when the stock columns don't exist yet.
 */
export async function loadStockList(db: Db, orgId: number): Promise<{ ready: boolean; items: StockItem[] }> {
    type Row = { id: number; name: string; price_type: string | null; price_amount: unknown; price_currency: string | null; stock?: unknown; low_stock_at?: unknown };
    const base = (withStock: boolean) => db.execute(sql`
        SELECT id, name, price_type, price_amount, price_currency${withStock ? sql`, stock, low_stock_at` : sql``}
          FROM org_products
         WHERE organisation_id = ${orgId} AND status = 'active'
         ORDER BY sort_order, id`);
    let ready = true;
    let rows: Row[];
    try {
        rows = asRows<Row>(await base(true));
    } catch (err) {
        if (!isMissingStockColumn(err)) throw err;
        ready = false;
        rows = asRows<Row>(await base(false));
    }
    const items: StockItem[] = [];
    for (const r of rows) {
        const pence = buyablePence({ priceType: r.price_type, priceAmount: numOrNull(r.price_amount), priceCurrency: r.price_currency });
        if (pence == null) continue;
        const stock = numOrNull(r.stock);
        const lowStockAt = numOrNull(r.low_stock_at);
        items.push({ id: Number(r.id), name: r.name, price: formatMoney(pence, r.price_currency || 'GBP'), stock, lowStockAt, state: stockState(stock, lowStockAt) });
    }
    return { ready, items };
}

export type SaveStockResult = { ok: true; item: { id: number; name: string } & StockLevel } | { ok: false; status: 400 | 404 | 503; error: string };

/** Set a product's stock and/or low-stock level (shop.ts product_stock: the Shop tab and the chat card). */
export async function saveProductStock(db: Db, orgId: number, productId: number, raw: { stock?: unknown; lowStockAt?: unknown }): Promise<SaveStockResult> {
    if (!Number.isInteger(productId) || productId <= 0) return { ok: false, status: 400, error: 'Which product? productId is missing.' };
    const parsed = parseStockInput(raw);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const v = parsed.value;
    try {
        const rows = asRows<{ id: number; name: string; stock: unknown; low_stock_at: unknown }>(await db.execute(sql`
            UPDATE org_products SET
                   stock = ${'stock' in v ? sql`${v.stock}::int` : sql`stock`},
                   low_stock_at = ${'lowStockAt' in v ? sql`${v.lowStockAt}::int` : sql`low_stock_at`},
                   updated_at = now()
             WHERE id = ${productId} AND organisation_id = ${orgId} AND status = 'active'
         RETURNING id, name, stock, low_stock_at`));
        const r = rows[0];
        if (!r) return { ok: false, status: 404, error: 'That product isn\'t in this workspace\'s Business Information (or it is archived).' };
        return { ok: true, item: { id: Number(r.id), name: r.name, stock: numOrNull(r.stock), lowStockAt: numOrNull(r.low_stock_at) } };
    } catch (err) {
        if (isMissingStockColumn(err)) return { ok: false, status: 503, error: 'Stock levels aren\'t switched on yet. Please try again later.' };
        throw err;
    }
}

export interface StockTaken { before: number; after: number; lowStockAt: number | null; oversold: boolean }

/**
 * A paid order: take `qty` from the product's stock, stopping at 0. Null when stock isn't tracked (or
 * the columns don't exist). Called once per order (recordPaidCheckout only after its INSERT succeeded),
 * so a repeated webhook never takes stock twice.
 */
export async function takeStock(db: Db, orgId: number, productId: number, qty: number): Promise<StockTaken | null> {
    if (!Number.isInteger(productId) || productId <= 0 || !(qty > 0)) return null;
    try {
        const rows = asRows<{ before: unknown; after: unknown; low_stock_at: unknown }>(await db.execute(sql`
            UPDATE org_products p SET stock = GREATEST(old.stock - ${Math.floor(qty)}::int, 0), updated_at = now()
              FROM (SELECT id, stock FROM org_products WHERE id = ${productId} AND organisation_id = ${orgId} AND stock IS NOT NULL FOR UPDATE) old
             WHERE p.id = old.id
         RETURNING old.stock AS before, p.stock AS after, p.low_stock_at`));
        const r = rows[0];
        if (!r) return null;
        const before = Number(r.before);
        return { before, after: Number(r.after), lowStockAt: numOrNull(r.low_stock_at), oversold: before < qty };
    } catch (err) {
        if (isMissingStockColumn(err)) return null;
        throw err;
    }
}

/** The owner's email when the stock couldn't be updated for this order (after one retry). */
export const STOCK_NOT_UPDATED_LINE = '⚠️ We couldn\'t update the stock for this order. Check the count on your Shopkeeper\'s Shop tab (Stock) and correct it if needed.';

/** The line for the owner's "New order" email. Pure. */
export function stockAfterOrderLine(taken: StockTaken | null, qty: number): string | null {
    if (!taken) return null;
    if (taken.oversold) return `⚠️ Only ${taken.before} ${taken.before === 1 ? 'was' : 'were'} in stock and ${qty} were paid for. It now shows as Sold out. Refund the difference in your Stripe dashboard, or set the stock again once you have more.`;
    if (taken.after === 0) return 'That was the last one: it now shows as Sold out on your website. Set the stock again on your Shopkeeper\'s Shop tab when you have more.';
    if (taken.lowStockAt != null && taken.after <= taken.lowStockAt) return `Stock is low: ${taken.after} left.`;
    return `${taken.after} left in stock.`;
}
