// src/utils/shop-stock-alerts.ts — "Stock that talks" (online shop Phase 2, slice 2; feature request #35,
// docs/online-shop-review-plan.md §12). tests/shop-stock-alerts.test.ts.
//
// When a paid order takes a product (or one of its options) DOWN TO its low-stock level, or to 0, the owner gets a
// bell notice and the Shopkeeper says so in Team Chat. Once per crossing, with no extra column: stock only goes
// down through orders (takeStock / takeOptionStock run once per order — recordPaidCheckout inserts the order
// first, so a repeated webhook never gets here), and an alert fires only when THIS order crossed the line
// (before > level ≥ after). Restocking above the level and selling down again alerts again.
//
// Options use their product's low-stock level ("warn me at 3" means each size): one setting per product, no
// second box to fill in. The words are written here from the counts — never composed by a model (Team Chat rule:
// a message is written when the state actually changes).

import { and, eq, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { createNotification } from './notify';
import { postTeamMessage } from './team-messages';
import type { StockTaken } from './shop-stock';

type Db = ReturnType<typeof getDb>;

export interface StockAlert { name: string; kind: 'low' | 'sold_out'; left: number }

/** Did this order cross a line? Sold out wins over low. Pure. */
export function stockCrossing(taken: Pick<StockTaken, 'before' | 'after' | 'lowStockAt'> | null, name: string): StockAlert | null {
    if (!taken) return null;
    const { before, after, lowStockAt } = taken;
    if (before > 0 && after === 0) return { name, kind: 'sold_out', left: 0 };
    if (lowStockAt != null && lowStockAt > 0 && before > lowStockAt && after <= lowStockAt && after > 0) return { name, kind: 'low', left: after };
    return null;
}

/** Bell notice title, e.g. "Sold out: Lavender candle" / "Low stock: 3 left of Lavender candle" / "Stock: 2 products need you". Pure. */
export function stockAlertTitle(alerts: StockAlert[]): string {
    if (alerts.length === 1) {
        const a = alerts[0];
        return a.kind === 'sold_out' ? `Sold out: ${a.name}` : `Low stock: ${a.left} left of ${a.name}`;
    }
    return `Stock: ${alerts.length} products need you`;
}

/** The Shopkeeper's Team Chat message. Pure. */
export function stockAlertMessage(alerts: StockAlert[]): string {
    const line = (a: StockAlert) => a.kind === 'sold_out'
        ? `${a.name} is sold out — it shows Sold out on your website now.`
        : `${a.left} left of ${a.name} — that's the low-stock level you set.`;
    const tail = 'Set a new count on the Shop tab when more arrive.';
    if (alerts.length === 1) return `${line(alerts[0])} ${tail}`;
    return `After the latest order:\n${alerts.map((a) => `• ${line(a)}`).join('\n')}\n${tail}`;
}

/**
 * Tell the owner: a bell notice (to the order's owner, as the order notice is) and, when the workspace has an
 * active Shopkeeper, its Team Chat message linking to the Shop tab. Never throws; an alert that fails is logged
 * and the order is unaffected.
 */
export async function sendStockAlerts(db: Db, o: { orgId: number; ownerUserId: number | null; orderId: number; alerts: StockAlert[] }): Promise<void> {
    if (!o.alerts.length) return;
    try {
        const [keeper] = await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(aiAssistants)
            .where(and(eq(aiAssistants.organisationId, o.orgId), eq(aiAssistants.isActive, true), ne(aiAssistants.lifecycleStatus, 'archived'),
                sql`${aiAssistants.archivedAt} IS NULL`, sql`(${aiAssistants.configuration} ->> 'type') = 'shopkeeper'`))
            .limit(1);
        const title = stockAlertTitle(o.alerts);
        const message = stockAlertMessage(o.alerts);
        if (o.ownerUserId) {
            await createNotification(db, 'shop_stock_alert', {
                userId: o.ownerUserId, assistantId: keeper?.id, category: 'suggested_action',
                context: { stock: { title, message } },
                metadata: { assistantId: keeper?.id ?? null, orderId: o.orderId, alerts: o.alerts },
            });
        }
        if (keeper) {
            await postTeamMessage(db, {
                organisationId: o.orgId, fromAssistantId: keeper.id, toUser: true, kind: 'message', body: message,
                link: { assistantId: keeper.id, tab: 'datahub', label: 'Open the Shop tab' },
            });
        }
    } catch (err) {
        console.error('[shop-stock-alerts] alert failed (the order is unaffected)', { orderId: o.orderId, message: err instanceof Error ? err.message : String(err) });
    }
}
