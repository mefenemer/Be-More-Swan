// src/utils/shop-snapshot.ts — what the Shopkeeper Assistant's chat sees each turn (online shop FR#35,
// docs/online-shop-review-plan.md §10): whether Stripe can take payments, which Delivery & returns
// details are filled in or missing, and the newest orders. Read by chat-orchestrator.ts (routes with
// usesShopSnapshot). Same rows as the Shop tab (netlify/functions/shop.ts): workspace-level.
//
// Buyers' names are shown (the owner needs "any orders from Jo?"); emails and addresses are not, since
// the chat never needs them to answer and the Shop tab already shows them.

import { desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { siteOrders } from '../../db/schema';
import { connectAccountFor } from './site-shop';
import { loadShopSettings, missingFields, RETURN_EXCEPTIONS, returnsSummaryText } from './shop-settings';
import { formatMoney } from './product-price';

type Db = ReturnType<typeof getDb>;

export const SNAPSHOT_ORDERS = 15;

export interface ShopSnapshotInput {
    connected: boolean;
    chargesEnabled: boolean;
    shop: Awaited<ReturnType<typeof loadShopSettings>>;
    orders: { id: number; itemName: string; quantity: number; amountTotal: number; currency: string; customerName: string | null; status: string; refundedAmount: number; createdAt: Date }[];
}

/** Pure: the snapshot text from what was read (tests call this directly). */
export function shopSnapshotText(input: ShopSnapshotInput): string {
    const missing = missingFields(input.shop);
    const s = input.shop;
    const lines: string[] = ['THEIR SHOP (read this turn — the Shop tab shows the same):'];
    lines.push(input.chargesEnabled
        ? '- Payments: Stripe connected and taking payments (buyers pay the business directly; Be More Swan takes no fee).'
        : input.connected
            ? '- Payments: Stripe started but NOT finished — they press "Finish setting up Stripe" on the Shop tab. Buy buttons are hidden until it is done.'
            : '- Payments: Stripe NOT connected — they press "Connect Stripe" on the Shop tab (owner or admin). Buy buttons are hidden until it is done.');
    if (missing.length) {
        lines.push(`- Delivery & returns details: NOT complete — missing ${missing.join(', ')}. Buy buttons stay hidden until they are filled in.`);
    } else {
        lines.push('- Delivery & returns details: complete.');
    }
    if (s) {
        const given = [
            s.traderName && `trading name "${s.traderName}"`,
            s.traderAddress && 'business address given',
            s.contactEmail && `customer email ${s.contactEmail}`,
            s.contactPhone && 'phone given',
            s.deliveryText && `delivery: "${s.deliveryText.slice(0, 200)}"`,
            s.vatNumber && 'VAT registered',
        ].filter(Boolean);
        if (given.length) lines.push(`- What they have filled in: ${given.join('; ')}.`);
        lines.push(`- Returns: ${returnsSummaryText(s)}`);
        const ex = (s.exceptions || []).map((k) => RETURN_EXCEPTIONS[k as keyof typeof RETURN_EXCEPTIONS]).filter(Boolean);
        if (ex.length) lines.push(`- Not returnable for a change of mind: ${ex.join('; ')}.`);
    }
    lines.push(input.chargesEnabled && !missing.length
        ? '- So: the shop CAN take orders now.'
        : '- So: the shop can NOT take orders yet.');
    if (!input.orders.length) {
        lines.push('', 'ORDERS: none yet.');
    } else {
        const fresh = input.orders.filter((o) => o.status === 'paid').length;
        lines.push('', `ORDERS (newest ${input.orders.length}; ${fresh} not yet marked as dealt with):`);
        for (const o of input.orders) {
            const state = o.status === 'refunded' ? 'refunded' : o.refundedAmount > 0 ? `part refunded (${formatMoney(o.refundedAmount, o.currency)})` : o.status === 'done' ? 'dealt with' : 'NEW';
            lines.push(`- #${o.id} ${o.createdAt.toISOString().slice(0, 10)}: ${o.quantity} × ${o.itemName}, ${formatMoney(o.amountTotal, o.currency)}, ${o.customerName || 'a buyer'} — ${state}`);
        }
    }
    return lines.join('\n');
}

export async function buildShopSnapshot(db: Db, orgId: number): Promise<string> {
    const [acct, shop, orders] = await Promise.all([
        connectAccountFor(db, orgId),
        loadShopSettings(db, orgId),
        db.select({
            id: siteOrders.id, itemName: siteOrders.itemName, quantity: siteOrders.quantity, amountTotal: siteOrders.amountTotal, currency: siteOrders.currency,
            customerName: siteOrders.customerName, status: siteOrders.status, refundedAmount: siteOrders.refundedAmount, createdAt: siteOrders.createdAt,
        }).from(siteOrders).where(eq(siteOrders.organisationId, orgId)).orderBy(desc(siteOrders.createdAt)).limit(SNAPSHOT_ORDERS),
    ]);
    return shopSnapshotText({ connected: !!acct, chargesEnabled: !!acct?.chargesEnabled, shop, orders });
}
