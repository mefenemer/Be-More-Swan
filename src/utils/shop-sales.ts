// src/utils/shop-sales.ts — "Ask your shop" (online shop Phase 2, slice 1; feature request #35,
// docs/online-shop-review-plan.md §12). tests/shop-sales.test.ts.
//
// Totals over ALL of a workspace's orders, so the Shopkeeper chat can answer "how much did I sell in October?",
// "what are my best sellers?" and "who's still waiting for their order?" — the snapshot's ORDERS list only
// carries the newest 15. Read by shop-snapshot.ts (chat) and shop.ts (the Shop tab's "This month" line).
//
// Months are UK months (created_at is stored in UTC). Money is per currency, never added across currencies.
// Sold = net of refunds (amount_total − refunded_amount); a fully refunded order isn't counted as an order.
// Best sellers count units: a basket order by its lines (site_order_lines, by the product's name today), a
// single Buy-button order by its own item name. All read-only; a missing order-lines table (z-shop-basket.sql
// not applied) falls back to orders alone.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { formatMoney } from './product-price';

type Db = ReturnType<typeof getDb>;
const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** Months of totals the chat sees (this one and the 11 before). */
export const SALES_MONTHS = 12;
/** Best sellers listed per window. */
export const BEST_SELLERS = 5;
/** Orders still waiting to be posted that the chat sees by name (oldest first). */
export const WAITING_SHOWN = 30;
/** The longer best-seller window, in days. */
export const BEST_SELLER_DAYS = 90;

export interface MoneyByCurrency { [currency: string]: number }
export interface MonthTotal { month: string /* YYYY-MM, UK */; orders: number; sold: MoneyByCurrency; /** Orders refunded in full (not in `orders`). */ refunded?: number }
export interface BestSeller { name: string; units: number; sold: MoneyByCurrency }
export interface WaitingOrder { id: number; date: string /* YYYY-MM-DD, UK */; itemName: string; quantity: number; customerName: string | null }
export interface ShopSales {
    /** Newest first; months with no orders are left out. */
    months: MonthTotal[];
    /** This UK month's key (YYYY-MM), so "this month" / "last month" never depend on the server's clock zone. */
    thisMonth: string;
    bestThisMonth: BestSeller[];
    bestRecent: BestSeller[];
    /** Paid, not yet posted or dealt with — every one counted, the oldest WAITING_SHOWN named. */
    waitingCount: number;
    waiting: WaitingOrder[];
}

/** "£340 + €20" — each currency on its own, biggest first. Pure. */
export function moneyWords(m: MoneyByCurrency): string {
    const parts = Object.entries(m).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]).map(([c, v]) => formatMoney(v, c));
    return parts.length ? parts.join(' + ') : formatMoney(0, 'GBP');
}

/** "2026-10" → "October 2026". Pure. */
export function monthName(key: string): string {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The YYYY-MM key of the month before. Pure. */
export function previousMonth(key: string): string {
    const [y, m] = key.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function addMoney(into: MoneyByCurrency, currency: string, amount: number): void {
    const c = (currency || 'gbp').toUpperCase();
    into[c] = (into[c] ?? 0) + amount;
}

/** Group raw rows into best sellers, most units first (then most sold). Pure. */
export function rankBestSellers(rows: Array<{ name: string; units: number; amount: number; currency: string }>, limit = BEST_SELLERS): BestSeller[] {
    const by = new Map<string, BestSeller>();
    for (const r of rows) {
        const name = String(r.name || '').trim() || 'Unnamed item';
        const b = by.get(name) ?? { name, units: 0, sold: {} };
        b.units += Number(r.units) || 0;
        addMoney(b.sold, r.currency, Number(r.amount) || 0);
        by.set(name, b);
    }
    const total = (b: BestSeller) => Object.values(b.sold).reduce((a, v) => a + v, 0);
    return [...by.values()].filter((b) => b.units > 0).sort((a, b) => b.units - a.units || total(b) - total(a) || a.name.localeCompare(b.name)).slice(0, limit);
}

const UK = sql`(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')`;

async function bestSellerRows(db: Db, orgId: number, windowSql: ReturnType<typeof sql>): Promise<Array<{ name: string; units: number; amount: number; currency: string }>> {
    const withLines = sql`
        WITH o AS (SELECT id, item_name, quantity, amount_total, refunded_amount, currency FROM site_orders
                   WHERE organisation_id = ${orgId} AND status <> 'refunded' AND ${windowSql})
        SELECT COALESCE(p.name, l.item_name) AS name, l.quantity::int AS units, (l.unit_amount * l.quantity)::int AS amount, o.currency
          FROM site_order_lines l JOIN o ON o.id = l.order_id LEFT JOIN org_products p ON p.id = l.product_id AND p.organisation_id = ${orgId}
        UNION ALL
        SELECT o.item_name, o.quantity::int, (o.amount_total - o.refunded_amount)::int, o.currency FROM o
         WHERE NOT EXISTS (SELECT 1 FROM site_order_lines l WHERE l.order_id = o.id)`;
    try {
        return asRows(await db.execute(withLines));
    } catch (err) {
        const e = err as { code?: string; cause?: { code?: string }; message?: string };
        if ((e?.code ?? e?.cause?.code) !== '42P01' && !/site_order_lines/.test(String(e?.message ?? ''))) throw err;
        return asRows(await db.execute(sql`
            SELECT item_name AS name, quantity::int AS units, (amount_total - refunded_amount)::int AS amount, currency FROM site_orders
             WHERE organisation_id = ${orgId} AND status <> 'refunded' AND ${windowSql}`));
    }
}

/** Best sellers of the last `days` days (the Mentor's morning summary, shop-mentor.ts). */
export async function bestSellersSince(db: Db, orgId: number, days: number, limit = BEST_SELLERS): Promise<BestSeller[]> {
    return rankBestSellers(await bestSellerRows(db, orgId, sql`created_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days})`), limit);
}

/** Everything "Ask your shop" needs, in four small queries. */
export async function loadShopSales(db: Db, orgId: number): Promise<ShopSales> {
    const [now] = asRows<{ month: string }>(await db.execute(sql`SELECT to_char(now() AT TIME ZONE 'Europe/London', 'YYYY-MM') AS month`));
    const thisMonth = now?.month ?? new Date().toISOString().slice(0, 7);
    const monthRows = asRows<{ month: string; currency: string; orders: number; refunded: number; sold: number }>(await db.execute(sql`
        SELECT to_char(${UK}, 'YYYY-MM') AS month, upper(currency) AS currency,
               count(*) FILTER (WHERE status <> 'refunded')::int AS orders,
               count(*) FILTER (WHERE status = 'refunded')::int AS refunded, sum(amount_total - refunded_amount)::int AS sold
          FROM site_orders
         WHERE organisation_id = ${orgId}
           AND ${UK} >= date_trunc('month', now() AT TIME ZONE 'Europe/London') - make_interval(months => ${SALES_MONTHS - 1})
         GROUP BY 1, 2 ORDER BY 1 DESC`));
    const months: MonthTotal[] = [];
    for (const r of monthRows) {
        let m = months.find((x) => x.month === r.month);
        if (!m) { m = { month: r.month, orders: 0, sold: {}, refunded: 0 }; months.push(m); }
        m.orders += Number(r.orders) || 0;
        m.refunded = (m.refunded ?? 0) + (Number(r.refunded) || 0);
        addMoney(m.sold, r.currency, Number(r.sold) || 0);
    }
    const [thisRows, recentRows, waitingRows, waitingTotal] = await Promise.all([
        bestSellerRows(db, orgId, sql`${UK} >= date_trunc('month', now() AT TIME ZONE 'Europe/London')`),
        bestSellerRows(db, orgId, sql`created_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${BEST_SELLER_DAYS})`),
        db.execute(sql`
            SELECT id, to_char(${UK}, 'YYYY-MM-DD') AS date, item_name AS "itemName", quantity, customer_name AS "customerName"
              FROM site_orders WHERE organisation_id = ${orgId} AND status = 'paid' ORDER BY created_at ASC, id ASC LIMIT ${WAITING_SHOWN}`),
        db.execute(sql`SELECT count(*)::int AS n FROM site_orders WHERE organisation_id = ${orgId} AND status = 'paid'`),
    ]);
    return {
        // Every month with any order, a refunded-in-full one included, so "a month not listed had no orders" is true (review #894).
        months,
        thisMonth,
        bestThisMonth: rankBestSellers(thisRows),
        bestRecent: rankBestSellers(recentRows),
        waitingCount: Number(asRows<{ n: number }>(waitingTotal)[0]?.n) || 0,
        waiting: asRows<WaitingOrder>(waitingRows).map((w) => ({ ...w, id: Number(w.id), quantity: Number(w.quantity) || 1 })),
    };
}

/** This month and last month, for the Shop tab. Pure. */
export function monthSummary(s: ShopSales): { thisMonth: MonthTotal; lastMonth: MonthTotal } {
    const find = (k: string) => s.months.find((m) => m.month === k) ?? { month: k, orders: 0, sold: {} };
    return { thisMonth: find(s.thisMonth), lastMonth: find(previousMonth(s.thisMonth)) };
}

/** "12 orders, £340 sold" — the Shop tab's month line. Pure. */
export function salesMonthWords(m: MonthTotal): string {
    return `${m.orders} order${m.orders === 1 ? '' : 's'}, ${moneyWords(m.sold)} sold${m.refunded ? ` (${m.refunded} more refunded in full)` : ''}`;
}

/** The SALES and WAITING lines of the chat snapshot. Pure. */
export function salesSnapshotLines(s: ShopSales | null | undefined): string[] {
    if (!s) return [];
    const out: string[] = ['', `SALES (every order, UK months; "sold" is after refunds; ${monthName(s.thisMonth)} is this month, so far):`];
    if (!s.months.length) out.push(`- No orders in the last ${SALES_MONTHS} months.`);
    for (const m of s.months) out.push(`- ${monthName(m.month)}: ${salesMonthWords(m)}`);
    if (s.months.length) {
        const n = s.months.reduce((a, m) => a + m.orders, 0);
        const sold: MoneyByCurrency = {};
        for (const m of s.months) for (const [c, v] of Object.entries(m.sold)) addMoney(sold, c, v);
        out.push(`- Last ${SALES_MONTHS} months together: ${n} order${n === 1 ? '' : 's'}, ${moneyWords(sold)} sold. Months not listed had no orders.`);
    }
    const best = (label: string, list: BestSeller[]) => list.length
        ? [`BEST SELLERS ${label} (by units sold; no amounts here — use SALES for money):`, ...list.map((b, i) => `${i + 1}. ${b.name}: ${b.units} sold`)]
        : [`BEST SELLERS ${label}: nothing sold yet.`];
    out.push('', ...best('THIS MONTH', s.bestThisMonth), ...best(`LAST ${BEST_SELLER_DAYS} DAYS`, s.bestRecent));
    if (!s.waitingCount) {
        out.push('', 'WAITING TO BE POSTED: none — every paid order has been posted or dealt with.');
    } else {
        out.push('', `WAITING TO BE POSTED (paid, not yet posted or dealt with): ${s.waitingCount} order${s.waitingCount === 1 ? '' : 's'}${s.waitingCount > s.waiting.length ? `; the oldest ${s.waiting.length} listed` : ''}, oldest first:`);
        for (const w of s.waiting) out.push(`- #${w.id} ${w.date}: ${w.quantity} × ${w.itemName}, ${w.customerName || 'a buyer'}`);
    }
    return out;
}
