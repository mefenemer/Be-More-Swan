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
import { loadStockList, stockWords, type StockItem } from './shop-stock';
import { loadProductOptions, optionsWords, type ProductOptions } from './shop-options';
import { deliveryWords, hasDelivery, loadDelivery, type DeliverySetup } from './shop-delivery';
import { shopPageSnapshotLines, shopPageState, type ShopPageState } from './shop-page';
import { loadOrderPosting, ordersPostingOn, orderStateWords, type OrderPosting } from './shop-orders';
import { loadShopSales, salesSnapshotLines, type ShopSales } from './shop-sales';
import { loadReminderStats, reminderStatsWords } from './shop-checkout-reminder';
import { waitingCounts } from './shop-waitlist';

type Db = ReturnType<typeof getDb>;

export const SNAPSHOT_ORDERS = 15;

export interface ShopSnapshotInput {
    connected: boolean;
    chargesEnabled: boolean;
    shop: Awaited<ReturnType<typeof loadShopSettings>>;
    orders: { id: number; itemName: string; quantity: number; amountTotal: number; currency: string; customerName: string | null; status: string; refundedAmount: number; createdAt: Date }[];
    /** Stock (Phase 1, shop-stock.ts). Absent = not read. */
    stock?: { ready: boolean; items: StockItem[] };
    /** Options by product id (Phase 1, shop-options.ts). */
    options?: Record<number, ProductOptions>;
    /** UK delivery choices (Phase 1, shop-delivery.ts); undefined = not read. */
    delivery?: DeliverySetup | null;
    /** Posted orders' tracking (shop-orders.ts), by order id; postingOn = db/z-shop-orders.sql is on this database. */
    posting?: Record<number, OrderPosting>;
    postingOn?: boolean;
    /** The shop page for a business with no website (shop-page.ts). */
    shopPage?: ShopPageState | null;
    /** Totals over every order, best sellers and every order waiting to be posted (shop-sales.ts, Phase 2). */
    sales?: ShopSales | null;
    /** This week's abandoned-checkout reminders, in words (shop-checkout-reminder.ts, Phase 2 slice 5); null = none. */
    reminders?: string | null;
    /** People waiting to hear a product is back, by product id (shop-waitlist.ts, Phase 2 slice 6). */
    waiting?: Record<number, number>;
}

/** Pure: the DELIVERY line (what buyers choose from at checkout). */
export function deliverySnapshotLines(delivery: ShopSnapshotInput['delivery']): string[] {
    if (delivery === undefined) return [];
    return ['', hasDelivery(delivery)
        ? `DELIVERY CHOICES (buyers pick one at checkout; basket orders only): ${deliveryWords(delivery)}.`
        : 'DELIVERY CHOICES: none set — basket checkouts charge no delivery. Offer the delivery_rates card when they tell you how they deliver and what it costs.'];
}

/** How many products the stock list carries into the prompt. */
export const SNAPSHOT_STOCK = 40;

/** Pure: the STOCK lines (with each product's id, for the product_stock card). */
export function stockSnapshotLines(stock: ShopSnapshotInput['stock'], options: ShopSnapshotInput['options'] = {}): string[] {
    if (!stock) return [];
    if (!stock.ready) return ['', 'STOCK: stock levels are not switched on yet. Do not offer the product_stock card; say it is coming shortly.'];
    if (!stock.items.length) return ['', 'STOCK: no products can be bought online yet (a product needs a fixed price in Business Information ▸ Products & Services).'];
    const shown = stock.items.slice(0, SNAPSHOT_STOCK);
    const out = ['', `STOCK (products that can be bought online, with the productId the product_stock card needs${stock.items.length > shown.length ? `; first ${shown.length} of ${stock.items.length}` : ''}):`];
    for (const it of shown) {
        const po = options?.[it.id];
        out.push(po?.options.length
            ? `- productId ${it.id}: ${it.name} (${it.price}) — OPTIONS (stock is per option, set with product_options; product_stock only sets lowStockAt here, which warns for EACH option${it.lowStockAt != null ? `, now ${it.lowStockAt}` : ', none set'}): ${optionsWords(po, it.pence ?? null, it.currency)}`
            : `- productId ${it.id}: ${it.name} (${it.price}) — ${stockWords(it)}; no options`);
    }
    return out;
}

/** What still stops the shop taking orders, in the order the Shop tab lists it. Empty = ready. */
export function shopStepsLeft(input: Pick<ShopSnapshotInput, 'connected' | 'chargesEnabled' | 'shop'>): string[] {
    const steps: string[] = [];
    if (!input.chargesEnabled) steps.push(input.connected ? 'finish setting up Stripe' : 'connect Stripe');
    const missing = missingFields(input.shop);
    if (missing.length) steps.push(`fill in the Delivery & returns details (missing: ${missing.join(', ')})`);
    return steps;
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
    // The steps left, named and counted here, so the chat never adds one of its own: on 2026-11-16 (the
    // showcase sample run on staging) it answered "is my shop ready?" with "two things still need doing",
    // the second being to "confirm your returns window", when only Stripe was left.
    const left = shopStepsLeft(input);
    lines.push(left.length
        ? `- So: the shop can NOT take orders yet. Steps left (${left.length}): ${left.join('; ')}. Nothing else is required.`
        : '- So: the shop CAN take orders now. Nothing is left to set up.');
    lines.push(`- Optional, never a step left to do: phone, VAT number, extra terms, the days to cancel (${s?.returnsDays ?? 14} set; 14 is the legal minimum) and the things that can't be returned for a change of mind.`);
    lines.push(...stockSnapshotLines(input.stock, input.options));
    lines.push(...deliverySnapshotLines(input.delivery));
    lines.push(...shopPageSnapshotLines(input.shopPage));
    const waitingRows = Object.entries(input.waiting || {}).filter(([, n]) => n > 0)
        .map(([id, n]) => ({ name: input.stock?.items.find((i) => i.id === Number(id))?.name || `product #${id}`, n }));
    lines.push('', `WAITING LISTS ("Tell me when it's back" on a sold-out product's page; one service email each, never added to the Audience): ${waitingRows.length ? waitingRows.map((w) => `${w.name} — ${w.n} waiting`).join('; ') : 'nobody waiting'}. When a stock save makes a waiting product buyable again, you (the Shopkeeper) ask in Team Chat whether to email them; the owner sends with "Email them" there or on the Shop tab's Stock card. You can't send them from this chat — say where the button is.`);
    lines.push('', `ABANDONED-CHECKOUT REMINDERS: automatic, no setting. A basket buyer who ticks "Send me news" types their email on the basket page; if their checkout lapses unpaid (after 1 hour) they get ONE reminder with a link back to their basket, sent from the business's verified sending domain or connected Gmail/Outlook only (no route = not sent). Never to anyone who didn't tick. Fixed wording, no tasks spent. This week: ${input.reminders || 'none sent'}`);
    if (!input.orders.length) {
        lines.push('', 'ORDERS: none yet.');
    } else {
        const fresh = input.orders.filter((o) => o.status === 'paid').length;
        lines.push('', `ORDERS (newest ${input.orders.length}; ${fresh} NEW, not yet posted or dealt with):`);
        for (const o of input.orders) {
            const state = orderStateWords(o, input.posting?.[o.id]);
            lines.push(`- #${o.id} ${o.createdAt.toISOString().slice(0, 10)}: ${o.quantity} × ${o.itemName}, ${formatMoney(o.amountTotal, o.currency)}, ${o.customerName || 'a buyer'} — ${state}`);
        }
        if (input.postingOn === false) lines.push('- Marking orders as posted isn\'t switched on yet: don\'t offer the order_update card with status "posted".');
        lines.push(...salesSnapshotLines(input.sales));
    }
    return lines.join('\n');
}

export async function buildShopSnapshot(db: Db, orgId: number, assistantId: number | null = null): Promise<string> {
    const [acct, shop, orders, stock] = await Promise.all([
        connectAccountFor(db, orgId),
        loadShopSettings(db, orgId),
        db.select({
            id: siteOrders.id, itemName: siteOrders.itemName, quantity: siteOrders.quantity, amountTotal: siteOrders.amountTotal, currency: siteOrders.currency,
            customerName: siteOrders.customerName, status: siteOrders.status, refundedAmount: siteOrders.refundedAmount, createdAt: siteOrders.createdAt,
        }).from(siteOrders).where(eq(siteOrders.organisationId, orgId)).orderBy(desc(siteOrders.createdAt)).limit(SNAPSHOT_ORDERS),
        loadStockList(db, orgId).catch(() => undefined),
    ]);
    const options = stock?.items.length ? await loadProductOptions(db, orgId, stock.items.map((i) => i.id)) : {};
    const delivery = await loadDelivery(db, orgId);
    const [posting, postingOn] = await Promise.all([loadOrderPosting(db, orgId, orders.map((o) => o.id)), ordersPostingOn(db)]);
    const shopPage = assistantId ? await shopPageState(db, orgId, assistantId).catch(() => null) : null;
    const sales = orders.length ? await loadShopSales(db, orgId).catch((err) => { console.error('[shop-snapshot] sales read failed', err instanceof Error ? err.message : err); return null; }) : null;
    const reminders = reminderStatsWords(await loadReminderStats(db, orgId));
    const waiting = await waitingCounts(db, orgId);
    return shopSnapshotText({ connected: !!acct, chargesEnabled: !!acct?.chargesEnabled, shop, orders, stock, options, delivery, posting, postingOn, shopPage, sales, reminders, waiting });
}
