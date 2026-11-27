// src/utils/shop-mentor.ts — the Business Mentor watches the shop (online shop Phase 2, slice 8; feature request #35,
// docs/online-shop-review-plan.md §12, owner Q7 2026-11-26: no "delivery above your sector's average" — we have no
// reliable sector figures). tests/shop-mentor.test.ts, tests/shop-mentor-db.test.ts.
//
// Facts, never a model's guess:
//   • best seller of the last 7 days (units, from order lines and Buy orders — shop-sales.ts)
//   • products at or below their low-stock level, and sold out (shop-stock.ts)
//   • products that can be bought, have sold online before, but haven't sold in 60 days (and are at least 60 days
//     old, and the shop HAS sold something in that time — a shop nobody buys from yet isn't "slow", it's new);
//     never one whose options are all sold out
// Read by the morning summary (mentor-morning.ts: best seller + stock, by rules, no task) and the Mentor's workspace
// snapshot (mentor-snapshot.ts: all three, so the weekly review and the chat may suggest a post about a slow product
// or that the owner looks at its price). The owner sets every price: the Mentor never names one.
//
// Only for a workspace with a shop: an active Shopkeeper, or an order in the last 90 days. Null otherwise, and on any
// read failure (never breaks the summary or the snapshot).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bestSellersSince } from './shop-sales';
import { loadStockList } from './shop-stock';

type Db = ReturnType<typeof getDb>;

export const BEST_SELLER_WEEK_DAYS = 7;
/** A best seller needs at least this many sold in the week to be called one. */
export const BEST_SELLER_MIN_UNITS = 2;
export const SLOW_DAYS = 60;
export const MAX_LISTED = 5;

export interface ShopWatch {
    bestSeller: { name: string; units: number } | null;
    low: Array<{ name: string; left: number }>;
    soldOut: string[];
    /** Buyable (options included), sold online before, at least SLOW_DAYS old, no sale in SLOW_DAYS. */
    slow: Array<{ id: number; name: string }>;
}

const asRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** The facts. Null when there is no shop to watch, or they can't be read. Never throws. */
export async function loadShopWatch(db: Db, orgId: number): Promise<ShopWatch | null> {
    try {
        const [has] = asRows<{ keeper: boolean; recent: boolean; sold_slow: boolean }>(await db.execute(sql`
            SELECT EXISTS (SELECT 1 FROM ai_assistants WHERE organisation_id = ${orgId} AND is_active AND archived_at IS NULL
                             AND lifecycle_status <> 'archived' AND (configuration ->> 'type') = 'shopkeeper') AS keeper,
                   EXISTS (SELECT 1 FROM site_orders WHERE organisation_id = ${orgId} AND created_at > now() - interval '90 days') AS recent,
                   EXISTS (SELECT 1 FROM site_orders WHERE organisation_id = ${orgId} AND status <> 'refunded'
                             AND created_at > now() - make_interval(days => ${SLOW_DAYS})) AS sold_slow`));
        if (!has?.keeper && !has?.recent) return null;
        const [best] = await bestSellersSince(db, orgId, BEST_SELLER_WEEK_DAYS, 1);
        const stock = await loadStockList(db, orgId);
        const low = stock.items.filter((i) => i.state === 'low').slice(0, MAX_LISTED).map((i) => ({ name: i.name, left: Number(i.stock) }));
        const soldOut = stock.items.filter((i) => i.state === 'sold_out').slice(0, MAX_LISTED).map((i) => i.name);
        const buyable = stock.items.filter((i) => i.state !== 'sold_out');
        let slow: ShopWatch['slow'] = [];
        if (has?.sold_slow && buyable.length) {
            slow = asRows<{ id: number; name: string }>(await db.execute(sql`
                SELECT p.id, p.name FROM org_products p
                 WHERE p.organisation_id = ${orgId} AND p.status = 'active'
                   AND p.id IN (${sql.join(buyable.map((i) => sql`${i.id}`), sql`, `)})
                   AND p.created_at < now() - make_interval(days => ${SLOW_DAYS})
                   -- It HAS sold online before (review #910): proof it is for sale online, not sold in person only —
                   -- "slow" means it used to sell and has stopped.
                   AND (EXISTS (SELECT 1 FROM site_order_lines l JOIN site_orders o ON o.id = l.order_id
                                 WHERE l.product_id = p.id AND o.organisation_id = ${orgId})
                        OR EXISTS (SELECT 1 FROM site_orders o WHERE o.organisation_id = ${orgId} AND o.item_name = p.name))
                   -- Not when every option is sold out: it can't be bought.
                   AND NOT (EXISTS (SELECT 1 FROM product_options po WHERE po.product_id = p.id AND po.organisation_id = ${orgId} AND po.status = 'active')
                        AND NOT EXISTS (SELECT 1 FROM product_options po WHERE po.product_id = p.id AND po.organisation_id = ${orgId} AND po.status = 'active'
                                         AND (po.stock IS NULL OR po.stock > 0)))
                   AND NOT EXISTS (SELECT 1 FROM site_order_lines l JOIN site_orders o ON o.id = l.order_id
                                    WHERE l.product_id = p.id AND o.organisation_id = ${orgId} AND o.created_at > now() - make_interval(days => ${SLOW_DAYS}))
                   AND NOT EXISTS (SELECT 1 FROM site_orders o WHERE o.organisation_id = ${orgId} AND o.item_name = p.name
                                    AND o.created_at > now() - make_interval(days => ${SLOW_DAYS}))
                 ORDER BY p.created_at, p.id LIMIT ${MAX_LISTED}`).catch((err: unknown) => {
                // No order-lines table yet (db/z-shop-basket.sql): skip "slow" rather than call everything slow.
                console.error('[shop-mentor] slow-product read failed', err instanceof Error ? err.message : err);
                return [];
            })).map((r) => ({ id: Number(r.id), name: r.name }));
        }
        return {
            bestSeller: best && best.units >= BEST_SELLER_MIN_UNITS ? { name: best.name, units: best.units } : null,
            low, soldOut, slow,
        };
    } catch (err) {
        console.error('[shop-mentor] read failed (left out)', { orgId, message: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

/** The morning summary's "Your shop" lines (best seller, stock — not "slow": that's for the weekly review). Pure. */
export function shopMorningLines(w: ShopWatch | null): string[] {
    if (!w) return [];
    const out: string[] = [];
    if (w.bestSeller) out.push(`Best seller this week: ${w.bestSeller.name} (${w.bestSeller.units} sold)`);
    if (w.low.length) out.push(`Low stock: ${w.low.map((l) => `${l.name} (${l.left} left)`).join(', ')} (Shopkeeper ▸ Shop)`);
    if (w.soldOut.length) out.push(`Sold out: ${w.soldOut.join(', ')} (Shopkeeper ▸ Shop)`);
    return out;
}

/** The Mentor's workspace snapshot section. Pure. */
export function shopSnapshotForMentor(w: ShopWatch | null | undefined): string[] {
    if (!w) return [];
    const lines = ['', 'YOUR SHOP (facts from the Shopkeeper; the owner sets every price — never name or suggest a price figure):'];
    lines.push(`- Best seller, last 7 days: ${w.bestSeller ? `${w.bestSeller.name}, ${w.bestSeller.units} sold` : 'none yet (fewer than 2 of anything sold)'}`);
    lines.push(`- Low stock: ${w.low.length ? w.low.map((l) => `${l.name} (${l.left} left)`).join(', ') : 'none'}; sold out: ${w.soldOut.length ? w.soldOut.join(', ') : 'none'}`);
    if (w.slow.length) {
        lines.push(`- NOT SOLD IN ${SLOW_DAYS} DAYS (sold online before, buyable, listed at least ${SLOW_DAYS} days): ${w.slow.map((s) => `${s.name} (#${s.id})`).join(', ')}.`);
        lines.push(`  You may suggest ONE of these at a time: a post about it (a draft request to the Social Media assistant, if one is active) or that the owner looks at its price, description or photo on the Shopkeeper's Shop tab. Say "you decide the price"; never propose a number, a discount or a sale yourself.`);
    }
    return lines;
}
