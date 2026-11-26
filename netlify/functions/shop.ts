// netlify/functions/shop.ts — the Shopkeeper Assistant's Shop tab and chat cards (online shop FR#35,
// docs/online-shop-review-plan.md §10). Workspace-level: the Stripe account, the Delivery & returns
// details and the orders belong to the workspace, not to one website, so a Shopkeeper works without a
// Be More Swan site too. The Website Assistant keeps its own Orders tab (sites.ts) on the same rows.
//
//   POST { action, assistantId, ... }
//   get              → { payments, shop, shopMissing, exceptions, orders, stats, canEdit }
//   shop_settings    { settings }  → save the Delivery & returns details (owner/admin); the Shop tab's form
//                                    and the chat's shop_settings card send exactly this
//   payments_connect → Stripe's onboarding link for the workspace's Standard account (owner/admin)
//   payments_refresh → re-read the account from Stripe (back from onboarding)
//   order_done       { id, done }  → mark an order dealt with (or new again); a refund stays a refund
//   order_update     { id, status: 'posted'|'done'|'new', trackingNumber?, trackingUrl? } → the Shop tab's "Mark as
//                    posted" and the chat's order_update card; posted emails the buyer from the owner's own inbox
//   orders_csv       → { filename, csv } every order (the newest 5000), for the Shop tab's "Download CSV"
//   shop_page_publish { slug } → write and publish the shop page for a business with no website (owner/admin;
//                    also "Update shop page"); shop_page_offline → take it offline (shop-page.ts). A click only.
//   product_stock    { productId, stock?, lowStockAt? } → set a product's stock / low-stock level (any
//                    member, like Business Information ▸ Products); the Shop tab's Stock card and the
//                    chat's product_stock card send exactly this (shop-stock.ts, Phase 1)
//   delivery_rates   { rates: [{ name, price, freeOver?, days? }], collect: { on, note? } } → REPLACE the UK delivery
//                    choices (owner/admin, like the Delivery & returns details); the Shop tab's Delivery card and
//                    the chat's delivery_rates card send exactly this (shop-delivery.ts, Phase 1)
//   product_options  { productId, group, options: [{ id?, label, price?, stock? }] } → REPLACE a product's
//                    options (any member); an empty list removes them. The Shop tab's Options editor and
//                    the chat's product_options card send exactly this (shop-options.ts, Phase 1)
//
// assistantId must be THIS workspace's Shopkeeper. shop_settings also accepts the Website Assistant, so
// one chat card (disruptive-ui-registry.js `shop_settings`) saves through one path for both roles.
// Nothing here moves money: refunds and payouts stay in the business's own Stripe dashboard.

import { and, desc, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, siteOrders, users } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { SHOPKEEPER_ROLE_KEY, WEBSITE_ASSISTANT_ROLE_KEY } from '../../src/constants/roles';
import { connectAccountFor, connectOnboardingLink, markShopOrderDone, refreshConnectAccount } from '../../src/utils/site-shop';
import { loadShopSettings, missingFields, saveShopSettings, RETURN_EXCEPTIONS, type SettingsInput } from '../../src/utils/shop-settings';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { loadStockList, saveProductStock, stockWords } from '../../src/utils/shop-stock';
import { loadProductOptions, saveProductOptions } from '../../src/utils/shop-options';
import { loadOrderLines } from '../../src/utils/shop-basket';
import { loadOrderPosting, markOrderPosted, ordersCsv, ordersPostingOn, postedMessage } from '../../src/utils/shop-orders';
import { publishShopPage, shopPageOffline, shopPageState } from '../../src/utils/shop-page';
import { shopStepsLeft } from '../../src/utils/shop-snapshot';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { cleanSiteSlugInput, siteCacheTag, siteOrigin, siteVisibleText } from '../../src/utils/site-hosting';
import { refreshDirectoryAfterAddressChange, refreshDirectoryAfterPublish } from '../../src/utils/site-directory-store';
import { purgeCache } from '@netlify/functions';
import { deliveryWords, hasDelivery, loadDelivery, loadOrderDelivery, saveDelivery } from '../../src/utils/shop-delivery';
import { loadShopSales, monthSummary, salesMonthWords } from '../../src/utils/shop-sales';
import { draftProductFromPhoto } from '../../src/utils/shop-product-photo';
import { getTaskCosts } from '../../src/utils/task-costs';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Orders shown on the tab: the newest 200 is plenty for a micro seller (plan §8, decision 1). */
export const SHOP_ORDER_LIMIT = 200;

/** Clear a site's cached pages so the shop page shows at once (as sites.ts does). Never fails the action. */
async function purgeSitePages(slug: string | null | undefined): Promise<void> {
    if (!slug) return;
    try { await purgeCache({ tags: [siteCacheTag(slug)] }); }
    catch (err) { console.error('[shop] cache purge failed (the change shows within a minute)', err instanceof Error ? err.message : err); }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId, role } = ctx;
    const canEdit = role === 'owner' || role === 'admin';

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    // IDOR + role guard: only THIS organisation's Shopkeeper (or, for shop_settings, its Website Assistant).
    const id = Number(body.assistantId);
    if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'assistantId required.' });
    const roles = action === 'shop_settings' ? [SHOPKEEPER_ROLE_KEY, WEBSITE_ASSISTANT_ROLE_KEY] : [SHOPKEEPER_ROLE_KEY];
    const [assistant] = await db.select({ id: aiAssistants.id, archivedAt: aiAssistants.archivedAt, lifecycleStatus: aiAssistants.lifecycleStatus }).from(aiAssistants).where(and(
        eq(aiAssistants.id, id), eq(aiAssistants.organisationId, orgId),
        sql`(${aiAssistants.configuration} ->> 'type') IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})`,
    )).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    async function view(warnings: string[] = []) {
        const [acct, shop, orders, [counts], stock] = await Promise.all([
            connectAccountFor(db, orgId),
            loadShopSettings(db, orgId),
            db.select({
                id: siteOrders.id, itemName: siteOrders.itemName, quantity: siteOrders.quantity, amountTotal: siteOrders.amountTotal, currency: siteOrders.currency,
                customerName: siteOrders.customerName, customerEmail: siteOrders.customerEmail, shippingAddress: siteOrders.shippingAddress,
                status: siteOrders.status, refundedAmount: siteOrders.refundedAmount, createdAt: siteOrders.createdAt,
            }).from(siteOrders).where(eq(siteOrders.organisationId, orgId)).orderBy(desc(siteOrders.createdAt)).limit(SHOP_ORDER_LIMIT),
            db.select({
                newOrders: sql<number>`count(*) filter (where ${siteOrders.status} = 'paid')::int`,
                orders30: sql<number>`count(*) filter (where ${siteOrders.createdAt} > now() - interval '30 days')::int`,
                takenPence30: sql<number>`coalesce(sum(${siteOrders.amountTotal} - ${siteOrders.refundedAmount}) filter (where ${siteOrders.createdAt} > now() - interval '30 days' and lower(${siteOrders.currency}) = 'gbp'), 0)::int`,
                refunds30: sql<number>`count(*) filter (where ${siteOrders.refundedAmount} > 0 and ${siteOrders.createdAt} > now() - interval '30 days')::int`,
            }).from(siteOrders).where(eq(siteOrders.organisationId, orgId)),
            loadStockList(db, orgId).catch((err) => { console.error('[shop] stock list failed', err instanceof Error ? err.message : err); return { ready: false, items: [] }; }),
        ]);
        return {
            payments: { connected: !!acct, chargesEnabled: !!acct?.chargesEnabled, detailsSubmitted: !!acct?.detailsSubmitted, canConnect: canEdit },
            shop, shopMissing: missingFields(shop), exceptions: RETURN_EXCEPTIONS,
            orders, stats: counts ?? { newOrders: 0, orders30: 0, takenPence30: 0, refunds30: 0 },
            stock, options: stock.items.length ? await loadProductOptions(db, orgId, stock.items.map((i) => i.id)) : {},
            // A basket order's items (shop-basket.ts), by order id.
            orderLines: orders.length ? await loadOrderLines(db, orgId, orders.map((o) => o.id)) : {},
            // UK delivery choices (shop-delivery.ts) and the one each order chose.
            delivery: await loadDelivery(db, orgId),
            orderDelivery: orders.length ? await loadOrderDelivery(db, orgId, orders.map((o) => o.id)) : {},
            // Posted orders' tracking (shop-orders.ts); postingOn = db/z-shop-orders.sql has reached this database.
            orderPosting: orders.length ? await loadOrderPosting(db, orgId, orders.map((o) => o.id)) : {},
            postingOn: await ordersPostingOn(db),
            // The shop page for a business with no Be More Swan website (shop-page.ts).
            shopPage: await shopPageState(db, orgId, assistant.id).catch((err) => { console.error('[shop] shop page read failed', err instanceof Error ? err.message : err); return null; }),
            // "This month" on the Orders card (shop-sales.ts, Phase 2 slice 1): UK months, after refunds, per currency.
            sales: orders.length ? await loadShopSales(db, orgId).then((s) => { const m = monthSummary(s); return { thisMonth: salesMonthWords(m.thisMonth), lastMonth: salesMonthWords(m.lastMonth) }; })
                .catch((err) => { console.error('[shop] sales read failed', err instanceof Error ? err.message : err); return null; }) : null,
            // Product from a photo (shop-product-photo.ts): its task cost, for the button's label.
            photoTaskCost: (await getTaskCosts()).weights.product_from_photo,
            canEdit, warnings,
        };
    }

    if (action === 'get') return json(200, await view());

    if (action === 'shop_settings') {
        if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can change the shop\'s Delivery & returns details.' });
        const input = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as SettingsInput;
        const r = await saveShopSettings(db, orgId, userId, input);
        if (!r.ok) return json(400, { error: r.error });
        const gaps = missingFields(r.value);
        return json(200, await view([gaps.length ? `Saved. Still needed before Buy buttons show: ${gaps.join(', ')}.` : 'Saved. Your Delivery & returns page is ready.']));
    }

    if (action === 'payments_connect') {
        if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can connect a Stripe account.' });
        const base = resolveBaseUrl(event.headers as Record<string, string | undefined>) || 'https://bemoreswan.com';
        const back = `${base}/workspace.html?view=assistant-detail&assistantId=${assistant.id}&tab=datahub&payments=return`;
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        try {
            return json(200, { url: await connectOnboardingLink(db, { orgId, userId, email: u?.email ?? null, returnUrl: back, refreshUrl: back }) });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[shop] Stripe connect failed', msg);
            if (/platform profile|connect.*(not enabled|isn't enabled)|signed up for connect/i.test(msg)) {
                return json(503, { error: 'Taking payments isn\'t available just yet — Be More Swan is finishing its set-up with Stripe. Please try again later today.' });
            }
            return json(503, { error: 'Stripe couldn\'t be reached just now. Try again in a minute.' });
        }
    }

    if (action === 'payments_refresh') {
        try { await refreshConnectAccount(db, orgId); } catch (err) { console.error('[shop] Stripe refresh failed', err instanceof Error ? err.message : err); }
        return json(200, await view());
    }

    if (action === 'order_done') {
        if (!(await markShopOrderDone(db, orgId, Number(body.id), body.done !== false))) return json(404, { error: 'Order not found.' });
        return json(200, await view());
    }

    if (action === 'order_update') {
        const orderId = Number(body.id);
        if (body.status === 'posted') {
            const r = await markOrderPosted(db, orgId, orderId, { trackingNumber: body.trackingNumber, trackingUrl: body.trackingUrl });
            if (!r.ok) return json(r.status, { error: r.error });
            return json(200, await view([postedMessage(r, orderId)]));
        }
        if (body.status !== 'done' && body.status !== 'new') return json(400, { error: 'Choose posted, done or new.' });
        const now = await markShopOrderDone(db, orgId, orderId, body.status === 'done');
        if (!now) return json(404, { error: 'Order not found, or it was refunded.' });
        // Worded from where the order ended up: "new" on a posted order keeps it posted.
        return json(200, await view([now === 'done' ? `Order ${orderId} marked as dealt with.` : now === 'posted' ? `Order ${orderId} is no longer marked as dealt with: it's back to Posted.` : `Order ${orderId} marked as new again.`]));
    }

    if (action === 'orders_csv') {
        // Every buyer's name, email and address in one file: owner/admin only, like the shop's other settings.
        if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can download the orders.' });
        return json(200, await ordersCsv(db, orgId));
    }

    if (action === 'shop_page_publish') {
        if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can publish the shop page.' });
        // An archived Shopkeeper's page is taken offline (site-offline.ts); it can't go live again (review #884).
        if (assistant.archivedAt || assistant.lifecycleStatus === 'archived') return json(409, { error: 'This Shopkeeper is archived. Reinstate it first to publish its shop page.' });
        const [acct, shop] = await Promise.all([connectAccountFor(db, orgId), loadShopSettings(db, orgId)]);
        const left = shopStepsLeft({ connected: !!acct, chargesEnabled: !!acct?.chargesEnabled, shop });
        if (left.length) return json(400, { error: `Get your shop ready first: ${left.join('; ')}.` });
        const slug = cleanSiteSlugInput(body.slug);
        const r = await publishShopPage(db, {
            orgId, assistantId: assistant.id, userId, slug, contactEmail: shop?.contactEmail ?? null,
            // The safety check reads every word a visitor would read, as a website's Publish does.
            moderate: async (def) => {
                const blocked = await enforcePromptModeration({ text: siteVisibleText(def).slice(0, 20000), userId, organisationId: orgId, source: 'site_publish' });
                return blocked ? 'Something on the page couldn\'t be published. Check your business name, description and product names.' : null;
            },
        });
        if (!r.ok) return json(r.status, { error: r.error });
        await purgeSitePages(r.oldSlug);
        await purgeSitePages(r.site.slug);
        await refreshDirectoryAfterPublish(db, orgId);
        return json(200, await view([`Your shop page is live at ${siteOrigin(r.site.slug!)}.`]));
    }

    if (action === 'shop_page_offline') {
        if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can take the shop page offline.' });
        const slug = await shopPageOffline(db, orgId, assistant.id);
        await purgeSitePages(slug);
        await refreshDirectoryAfterAddressChange(db, orgId);
        return json(200, await view(['Your shop page is offline. Nothing is deleted: "Publish shop page" puts it back.']));
    }

    if (action === 'product_stock') {
        const r = await saveProductStock(db, orgId, Number(body.productId), {
            ...(Object.prototype.hasOwnProperty.call(body, 'stock') ? { stock: body.stock } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'lowStockAt') ? { lowStockAt: body.lowStockAt } : {}),
        });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, await view([`Saved. ${r.item.name}: ${stockWords(r.item)}.`]));
    }

    // Product from a photo (Phase 2 slice 3, shop-product-photo.ts): a name and description drafted from one of the
    // workspace's pictures, never a price. Saves nothing — the Shop tab form and the chat card then add the product
    // through Business Information's own save (org-products.ts POST). Anyone who can add products can draft one.
    if (action === 'product_photo_draft') {
        const r = await draftProductFromPhoto(db, { orgId, assistantId: assistant.id, assetId: Number(body.assetId) });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, { draft: r.draft, charged: r.charged });
    }

    if (action === 'delivery_rates') {
        if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can change the delivery choices.' });
        const r = await saveDelivery(db, orgId, { rates: body.rates, collect: body.collect });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, await view([hasDelivery(r.value) ? `Saved. Buyers choose from: ${deliveryWords(r.value)}.` : 'Delivery choices removed: checkout charges no delivery.']));
    }

    if (action === 'product_options') {
        const r = await saveProductOptions(db, orgId, Number(body.productId), { group: body.group, options: body.options });
        if (!r.ok) return json(r.status, { error: r.error });
        const n = r.value.options.length;
        return json(200, await view([n ? `Saved ${n} option${n === 1 ? '' : 's'} (${r.value.options.map((o) => o.label).join(', ')}).` : 'Options removed: the product is bought as one item again.']));
    }

    return json(400, { error: `Unknown action: ${action}` });
});
