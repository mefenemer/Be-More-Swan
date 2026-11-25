// src/utils/site-shop.ts — selling on a hosted Website Assistant site (step 3c, decision D4).
// docs/website-assistant-plan.md §5.4. tests/site-shop.test.ts.
//
// ── The money never touches us ──────────────────────────────────────────────────────────────────
// Each workspace connects its OWN Stripe STANDARD account (stripe_connect_accounts). A Buy button
// starts a Stripe Checkout Session ON THAT ACCOUNT (the `stripeAccount` request option): the business
// is the merchant of record — their refunds, disputes, VAT and payouts — and Be More Swan takes NO
// fee (decision D5: 0%, so there is no application_fee_amount anywhere in this file).
//
// ── The price is never the visitor's, and never the site's ──────────────────────────────────────
// Prices live in ONE place: Business Information ▸ Products & Services (org_products, structured by
// product-price.ts). The Buy form carries only which product (section id, product id, and the name
// and price the visitor SAW, as a check). At the click the product is read from Business Information
// and must still be offered by that section on the PUBLISHED site; if its name or price changed since
// the page was drawn, the visitor is sent back rather than charged a surprise.
//
// ── Shop settings (Phase 0, FR#35) ──────────────────────────────────────────────────────────────
// Buy buttons show only once the Delivery & returns details are filled in (shop-settings.ts
// shopReady): a buyer sees who they buy from and their right to cancel before paying, and gets it
// again by email afterwards (sendBuyerConfirmation). Checkout refuses too, not just the drawing.
//
// ── Stock (Phase 1, FR#35) ──────────────────────────────────────────────────────────────────────
// shop-stock.ts: a product at 0 shows "Sold out" and checkout refuses it; the quantity a buyer can
// pick is capped at what is left; stock is taken when the order is recorded as paid.
//
// ── Orders ──────────────────────────────────────────────────────────────────────────────────────
// Recorded from the Connect webhook (stripe-connect-webhook.ts → recordPaidCheckout), not from the
// success page: a visitor who closes the tab after paying has still paid.

import { and, eq, inArray, ne } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { getDb } from '../../db/client';
import { aiAssistants, orgProducts, siteOrders, sites, stripeConnectAccounts, users } from '../../db/schema';
import { createNotification } from './notify';
import { sendEmail } from './email';
import { checkRateLimit } from './rate-limit';
// Stripe's SDK (~0.7 MB) loads on first use, not at cold start: site-store.ts imports this module for
// connectAccountFor, and chat-orchestrator imports site-store. See src/lib/render-libs.ts.
const stripeClient = async () => (await import('./stripe')).getStripe();
import { currentEnv } from './env-context';
import { esc, formatPrice, FORM_SENT_PATH } from './site-render';
import type { SiteDefinition } from './site-definition';
import { buyablePence, cleanCurrency, formatMoney } from './product-price';
import { loadShopSettings, shopReady, checkoutNote, returnsSummaryText, traderBlockHtml, SHOP_TERMS_PATH, type ShopSettings } from './shop-settings';
import { loadStockLevels, maxBuyable, stockAfterOrderLine, takeStock, STOCK_NOT_UPDATED_LINE, type StockTaken } from './shop-stock';
import { loadProductOptions, optionItemName, optionPence, takeOptionStock, type ProductOptions } from './shop-options';
import { productPagePath } from './site-product-page';
import { deliveryOptionsFor, hasDelivery, loadDelivery, recordOrderDelivery, stripeShippingOptions, type DeliverySetup } from './shop-delivery';
import {
    addItem, basketOn, basketTotal, checkoutBlocker, checkoutLinesFor, emptyBasket, loadBasket, markBasketCheckout, orderSummaryName, priceBasket,
    saveBasket, setQty, withBasket, writeOrderLines, BASKET_PATH, type CheckoutLine, type OrderLine, type PricedLine,
} from './shop-basket';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;
export type ConnectRow = typeof stripeConnectAccounts.$inferSelect;

export const BUY_LIMIT = { maxAttempts: 20, windowSecs: 3600 };
export const MAX_QUANTITY = 10;
/** Every UK address; Checkout's own list. A business that ships abroad can ask us (v1 is UK-only). */
export const SHIPPING_COUNTRIES: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] = ['GB'];

export async function connectAccountFor(db: Db, orgId: number): Promise<ConnectRow | null> {
    const [row] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.organisationId, orgId)).limit(1);
    return row ?? null;
}

/** Whether this workspace's site may show Buy buttons right now: Stripe can take payments AND the
 *  Delivery & returns details are filled in (shop-settings.ts). */
export async function canSell(db: Db, orgId: number): Promise<boolean> {
    const row = await connectAccountFor(db, orgId).catch(() => null);
    if (!row?.chargesEnabled) return false;
    return shopReady(await loadShopSettings(db, orgId));
}

/** Copy Stripe's flags onto our row. Used on return from onboarding and by account.updated. */
export async function syncConnectAccount(db: Db, account: Stripe.Account): Promise<ConnectRow | null> {
    const [before] = await db.select({ chargesEnabled: stripeConnectAccounts.chargesEnabled }).from(stripeConnectAccounts).where(eq(stripeConnectAccounts.stripeAccountId, account.id)).limit(1);
    const [row] = await db.update(stripeConnectAccounts).set({
        chargesEnabled: !!account.charges_enabled, detailsSubmitted: !!account.details_submitted,
        payoutsEnabled: !!account.payouts_enabled, updatedAt: new Date(),
    }).where(eq(stripeConnectAccounts.stripeAccountId, account.id)).returning();
    // The moment it can take payments (whichever path noticed first: the return from Stripe, or the
    // webhook), tell the owner — once, because only that one update sees false → true.
    if (row && before && !before.chargesEnabled && row.chargesEnabled) await announcePaymentsReady(db, row.organisationId).catch((err) => console.error('[site-shop] payments-ready notice failed', err));
    return row ?? null;
}

/** "Stripe is connected" — a card for the Website Assistant's owner. */
async function announcePaymentsReady(db: Db, orgId: number): Promise<void> {
    const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name, assistantId: aiAssistants.id })
        .from(sites).innerJoin(aiAssistants, eq(aiAssistants.id, sites.aiAssistantId)).where(eq(sites.organisationId, orgId)).limit(1);
    if (!owner?.userId) return;
    await createNotification(db, 'site_payments_ready', {
        userId: owner.userId, assistantId: owner.assistantId, category: 'state_change',
        context: { assistant: { name: owner.name } },
        metadata: { assistantId: owner.assistantId },
    });
}

/**
 * Start (or continue) Stripe's own onboarding for this workspace and return the link to send the
 * owner to. Creates the Standard account the first time. Owner/admin only (sites.ts checks).
 */
export async function connectOnboardingLink(db: Db, opts: { orgId: number; userId: number; email: string | null; returnUrl: string; refreshUrl: string }): Promise<string> {
    const stripe = await stripeClient();
    let row = await connectAccountFor(db, opts.orgId);
    if (!row) {
        const account = await stripe.accounts.create({
            type: 'standard', country: 'GB',
            ...(opts.email ? { email: opts.email } : {}),
            metadata: { organisation_id: String(opts.orgId), source: 'website_assistant' },
        });
        const [created] = await db.insert(stripeConnectAccounts).values({
            organisationId: opts.orgId, stripeAccountId: account.id, livemode: currentEnv() !== 'sandbox' && (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live'), createdBy: opts.userId,
        }).onConflictDoNothing({ target: stripeConnectAccounts.organisationId }).returning();
        // Two clicks at once: keep whichever account landed first.
        row = created ?? await connectAccountFor(db, opts.orgId);
    }
    if (!row) throw new Error('Could not start connecting Stripe.');
    const link = await stripe.accountLinks.create({
        account: row.stripeAccountId, type: 'account_onboarding', return_url: opts.returnUrl, refresh_url: opts.refreshUrl,
    });
    return link.url;
}

/** Ask Stripe for the account's current state (the owner just came back from onboarding). */
export async function refreshConnectAccount(db: Db, orgId: number): Promise<ConnectRow | null> {
    const row = await connectAccountFor(db, orgId);
    if (!row) return null;
    const account = await (await stripeClient()).accounts.retrieve(row.stripeAccountId);
    return (await syncConnectAccount(db, account)) ?? row;
}

// ── Buying ────────────────────────────────────────────────────────────────────────────────────

export type BuyOutcome =
    | { kind: 'redirect'; location: string }
    | { kind: 'error'; status: 400 | 404 | 409 | 429 | 503; title: string; message: string; backPath: string };

/** A product as a site shows it — read from Business Information (org_products), never from the site. */
export interface SiteProduct {
    id: number;
    name: string;
    description: string | null;
    /** The displayed price ("£24", "from £450", "Price on request", their own words), or null. */
    price: string | null;
    /** Minor units (pence / cents) of `currency`, when it can be bought online (a fixed price); else null. */
    buyPence: number | null;
    /** The price's currency, ISO 4217 (product-price.ts PRICE_CURRENCIES); GBP for every older product. */
    currency?: string;
    imageAssetId: number | null;
    /** Minutes, for a service with a length (shown on a menu / price list when asked). */
    durationMinutes?: number | null;
    /** Dietary markers and allergen words (product-dietary.ts), for a menu. */
    dietary?: unknown;
    allergens?: string | null;
    /** Stock (shop-stock.ts): null/absent = not tracked, 0 = Sold out. Not used while it has options. */
    stock?: number | null;
    /** Its options (shop-options.ts), when it has any: then it is bought by option only. */
    options?: ProductOptions | null;
}

/** The active products a site's products sections name, keyed by id — only this workspace's. */
export async function loadSiteProducts(db: Db, orgId: number, def: SiteDefinition): Promise<Record<number, SiteProduct>> {
    const ids = [...new Set(def.pages.flatMap((p) => p.sections).flatMap((s) => (s.type === 'products' ? s.props.productIds
        : s.type === 'menu' ? s.props.groups.flatMap((g) => g.productIds) : [])))];
    if (!ids.length) return {};
    const rows = await db.select({
        id: orgProducts.id, name: orgProducts.name, description: orgProducts.description, price: orgProducts.price,
        priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount, priceCurrency: orgProducts.priceCurrency, imageAssetId: orgProducts.imageAssetId,
        durationMinutes: orgProducts.durationMinutes, dietary: orgProducts.dietary, allergens: orgProducts.allergens,
    }).from(orgProducts).where(and(inArray(orgProducts.id, ids), eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active')));
    // Stock (Phase 1): read apart, raw, so a database without the columns sells exactly as before.
    const stock = await loadStockLevels(db, orgId, rows.map((r) => r.id));
    const options = await loadProductOptions(db, orgId, rows.map((r) => r.id));
    return Object.fromEntries(rows.map((r) => [r.id, {
        id: r.id, name: r.name, description: r.description, price: r.price, buyPence: buyablePence(r), currency: r.priceCurrency ?? 'GBP', imageAssetId: r.imageAssetId,
        durationMinutes: r.durationMinutes ?? null, dietary: r.dietary ?? null, allergens: r.allergens ?? null,
        stock: stock[r.id]?.stock ?? null,
        options: options[r.id]?.options.length ? options[r.id] : null,
    }]));
}

export interface BuyRequest {
    site: SiteRow;
    definition: SiteDefinition;
    origin: string;
    body: URLSearchParams;
    ip: string;
    backPath: string;
    /** Library pictures → their public link (site-serve.ts passes newsletterMediaUrl). */
    assetUrl?: (assetId: number) => string | null;
}

/** The Checkout Session parameters for one product — pure, so the money rules are testable. For an option,
 *  `product` is already that option's sellable form (its name, price and stock) and `optionId` names it. */
export function checkoutParams(req: { origin: string; site: SiteRow; sectionId: string; product: SiteProduct; collectAddress: boolean; backPath: string; imageUrl?: string | null; shop?: ShopSettings | null; optionId?: number | null }): Stripe.Checkout.SessionCreateParams {
    const { product } = req;
    // Stripe shows the picture on its checkout page: it needs a real https address.
    const picture = req.imageUrl ?? null;
    // Never more than are in stock (shop-stock.ts); with one left, the buyer can't change the quantity.
    const most = maxBuyable(product.stock, MAX_QUANTITY);
    return {
        mode: 'payment',
        line_items: [{
            quantity: 1,
            ...(most > 1 ? { adjustable_quantity: { enabled: true, minimum: 1, maximum: most } } : {}),
            price_data: {
                currency: (product.currency || 'GBP').toLowerCase(),
                unit_amount: product.buyPence!,
                product_data: {
                    name: product.name,
                    ...(product.description ? { description: product.description.slice(0, 500) } : {}),
                    ...(picture && picture.startsWith('https://') ? { images: [picture] } : {}),
                },
            },
        }],
        ...(req.collectAddress ? { shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES } } : {}),
        // Who sells it and the right to cancel, beside the Pay button — before the buyer pays (CCR 2013).
        ...(req.shop ? { custom_text: { submit: { message: checkoutNote(req.shop, `${req.origin}${SHOP_TERMS_PATH}`) } } } : {}),
        success_url: `${req.origin}${FORM_SENT_PATH}?k=order&b=${encodeURIComponent(req.backPath)}`,
        cancel_url: `${req.origin}${req.backPath}`,
        // What the order records — the name and unit price as they were at checkout (Stripe caps a
        // metadata value at 500 characters; names are capped at 120 in Business Information).
        metadata: {
            bms_site_id: String(req.site.id), bms_org_id: String(req.site.organisationId), bms_section: req.sectionId,
            bms_product: String(product.id), bms_item_name: product.name, bms_unit: String(product.buyPence), bms_page: req.backPath,
            ...(req.optionId ? { bms_option: String(req.optionId) } : {}),
        },
    };
}

type Resolved = { kind: 'ok'; section: Extract<SiteDefinition['pages'][number]['sections'][number], { type: 'products' }>; sectionId: string; product: SiteProduct; optionId: number | null };

/** The product (or option) a Buy / Add to basket form names, checked against the PUBLISHED site and
 *  Business Information: offered by that section, still for sale, the name and price the visitor saw, in stock. */
async function resolveBuy(db: Db, req: BuyRequest): Promise<Resolved | BuyOutcome> {
    const back = req.backPath;
    const sectionId = String(req.body.get('_s') || '');
    const productId = Number(req.body.get('_pid'));
    const notForSale: BuyOutcome = { kind: 'error', status: 404, title: 'That item isn\'t for sale here any more', message: 'The page may have changed since you opened it. Go back and have another look.', backPath: back };
    // The section must be on the PUBLISHED site and must offer this product.
    const section = req.definition.pages.flatMap((p) => p.sections).find((s) => s.id === sectionId);
    if (!section || section.type !== 'products' || !Number.isInteger(productId) || !section.props.productIds.includes(productId)) return notForSale;
    // Name, price and picture: read from Business Information now — never from the visitor's browser.
    const found = (await loadSiteProducts(db, req.site.organisationId, req.definition))[productId];
    if (!found || found.buyPence === null) return notForSale;
    const changed: BuyOutcome = { kind: 'error', status: 409, title: 'This item has changed', message: 'The details changed since you opened the page. Go back to see the current price before you buy.', backPath: back };
    const soldOut: BuyOutcome = { kind: 'error', status: 409, title: 'Sold out', message: 'Sorry, this item has just sold out. Go back to see what else is available.', backPath: back };
    if (String(req.body.get('_n') || '') !== found.name) return changed;
    // A product with options is bought by option only (shop-options.ts): the option must be this
    // product's, and it is charged at ITS price, with ITS stock.
    let product: SiteProduct = found;
    let optionId: number | null = null;
    if (found.options?.options.length) {
        const option = found.options.options.find((o) => o.id === Number(req.body.get('_o')));
        if (!option) return { kind: 'error', status: 409, title: 'Choose an option', message: `Please choose a ${found.options.group.toLowerCase()} on the product's page first.`, backPath: productPagePath(found) };
        const pence = optionPence(found.buyPence, option, found.currency);
        if (pence === null) return notForSale;
        product = { ...found, name: optionItemName(found.name, option.label), buyPence: pence, stock: option.stock, options: null };
        optionId = option.id;
    }
    // Sold out since the page was drawn (pages are cached for two minutes): refuse before Stripe.
    if (product.stock != null && product.stock <= 0) return soldOut;
    // The price the visitor saw must be the price they pay.
    if (Number(req.body.get('_v')) !== product.buyPence) return changed;
    return { kind: 'ok', section, sectionId, product, optionId };
}

/** Stripe can take payments AND the Delivery & returns details are filled in; else the buyer is told so. */
async function readyToSell(db: Db, orgId: number, back: string): Promise<{ account: ConnectRow; shop: ShopSettings } | BuyOutcome> {
    const account = await connectAccountFor(db, orgId);
    const shop = await loadShopSettings(db, orgId);
    if (!account?.chargesEnabled || !shopReady(shop)) {
        return { kind: 'error', status: 503, title: 'Online payments aren\'t available right now', message: 'Please get in touch with the business to buy this.', backPath: back };
    }
    return { account, shop: shop! };
}

/** Baskets a visitor may START in an hour (each Add without a basket makes one; adding to one is free). */
export const NEW_BASKET_LIMIT = { maxAttempts: 30, windowSecs: 3600 };

async function rateLimited(db: Db, ip: string, back: string, key = 'site_buy_ip', limit = BUY_LIMIT): Promise<BuyOutcome | null> {
    try {
        const limited = await checkRateLimit(db, key, ip, limit);
        if (!limited.allowed) return { kind: 'error', status: 429, title: 'Please try again shortly', message: key === 'site_basket_ip' ? 'Too many baskets were started from here just now.' : 'Too many checkouts were started from here just now.', backPath: back };
    } catch (err) {
        console.error('[site-shop] rate limiter unavailable — allowing the checkout', err);
    }
    return null;
}

export async function startCheckout(db: Db, req: BuyRequest): Promise<BuyOutcome> {
    // A basket action (shop-basket.ts): add / set / remove / checkout, all posted to /_buy.
    const act = String(req.body.get('_a') || '');
    if (act) return basketAction(db, req, act);
    const back = req.backPath;
    const r = await resolveBuy(db, req);
    if (r.kind !== 'ok') return r;
    const { section, sectionId, product, optionId } = r;
    const ready = await readyToSell(db, req.site.organisationId, back);
    if ('kind' in ready) return ready;
    const { account, shop } = ready;
    const limited = await rateLimited(db, req.ip, back);
    if (limited) return limited;
    try {
        const session = await (await stripeClient()).checkout.sessions.create(
            checkoutParams({
                origin: req.origin, site: req.site, sectionId, product, collectAddress: section.props.collectAddress, backPath: back,
                imageUrl: product.imageAssetId ? (req.assetUrl?.(product.imageAssetId) ?? null) : null, shop, optionId,
            }),
            { stripeAccount: account.stripeAccountId },
        );
        if (!session.url) throw new Error('Stripe returned no checkout address');
        return { kind: 'redirect', location: session.url };
    } catch (err) {
        console.error('[site-shop] checkout failed', { siteId: req.site.id, message: err instanceof Error ? err.message : String(err) });
        return { kind: 'error', status: 503, title: 'Checkout couldn\'t be started', message: 'Nothing was charged. Please try again in a minute.', backPath: back };
    }
}

// ── The basket (Shopkeeper workspaces, shop-basket.ts) ─────────────────────────────────────────

export const basketPagePath = (id: string) => `${BASKET_PATH}?b=${encodeURIComponent(id)}`;

/** The Checkout Session for a whole basket — pure. Quantities were chosen on the basket page. */
export function basketCheckoutParams(req: { origin: string; site: SiteRow; basketId: string; lines: PricedLine[]; collectAddress: boolean; shop?: ShopSettings | null; imageUrl?: (assetId: number) => string | null; delivery?: DeliverySetup | null }): Stripe.Checkout.SessionCreateParams {
    const back = basketPagePath(req.basketId);
    // UK delivery rates (shop-delivery.ts): the buyer picks one on Stripe's page; a rate is free over its threshold.
    const shipping = hasDelivery(req.delivery) ? stripeShippingOptions(deliveryOptionsFor(req.delivery, basketTotal(req.lines))) : [];
    return {
        mode: 'payment',
        line_items: req.lines.map((l) => {
            const picture = l.imageAssetId ? req.imageUrl?.(l.imageAssetId) ?? null : null;
            return {
                quantity: l.qty,
                price_data: {
                    currency: l.currency.toLowerCase(),
                    unit_amount: l.unit,
                    product_data: { name: l.name, ...(picture && picture.startsWith('https://') ? { images: [picture] } : {}) },
                },
            };
        }),
        ...(req.collectAddress || shipping.length ? { shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES } } : {}),
        ...(shipping.length ? { shipping_options: shipping } : {}),
        ...(req.shop ? { custom_text: { submit: { message: checkoutNote(req.shop, `${req.origin}${SHOP_TERMS_PATH}`) } } } : {}),
        success_url: `${req.origin}${FORM_SENT_PATH}?k=order&b=${encodeURIComponent('/')}`,
        cancel_url: `${req.origin}${back}`,
        metadata: {
            bms_site_id: String(req.site.id), bms_org_id: String(req.site.organisationId), bms_basket: req.basketId,
            bms_item_name: orderSummaryName(req.lines), bms_page: BASKET_PATH,
        },
    };
}

/**
 * add      { _s, _pid, _n, _v, _o?, _q?, _b? } → checked exactly like a Buy, then into the basket (a new one when
 *                                                 `_b` isn't this site's fresh basket) → the basket page
 * set      { _b, _i, _q }  → change a line's quantity (0 removes it)          remove { _b, _i }
 * checkout { _b }          → every line priced again, then one Stripe Checkout for all of it
 */
async function basketAction(db: Db, req: BuyRequest, act: string): Promise<BuyOutcome> {
    const back = req.backPath;
    const orgId = req.site.organisationId;
    if (!(await basketOn(db, orgId))) return { kind: 'error', status: 404, title: 'There\'s no basket here', message: 'Go back and use the Buy button instead.', backPath: back };
    const basket = await loadBasket(db, req.site.id, req.body.get('_b'));
    if (act === 'add') {
        const r = await resolveBuy(db, req);
        // A refused Add keeps the buyer's basket in its "Go back" link, so their next Add goes into it.
        if (r.kind !== 'ok') return basket && r.kind === 'error' ? { ...r, backPath: withBasket(r.backPath, basket.id) } : r;
        if (!basket) {
            const limited = await rateLimited(db, req.ip, back, 'site_basket_ip', NEW_BASKET_LIMIT);
            if (limited) return limited;
        }
        const qty = Math.max(1, Math.floor(Number(req.body.get('_q') || 1)) || 1);
        const added = addItem(basket?.items ?? [], { productId: r.product.id, optionId: r.optionId, sectionId: r.sectionId, qty });
        if (added.error) return { kind: 'error', status: 409, title: 'Your basket is full', message: added.error, backPath: basket ? basketPagePath(basket.id) : back };
        const id = await saveBasket(db, { id: basket?.id ?? null, siteId: req.site.id, orgId, items: added.items });
        return { kind: 'redirect', location: basketPagePath(id) };
    }
    if (!basket) return { kind: 'error', status: 404, title: 'Your basket has expired', message: 'Baskets are kept for a day. Please add your items again.', backPath: '/' };
    if (act === 'set' || act === 'remove') {
        const items = setQty(basket.items, Number(req.body.get('_i')), act === 'remove' ? 0 : Number(req.body.get('_q')));
        const id = await saveBasket(db, { id: basket.id, siteId: req.site.id, orgId, items });
        return { kind: 'redirect', location: basketPagePath(id) };
    }
    if (act !== 'checkout') return { kind: 'error', status: 400, title: 'That didn\'t work', message: 'Please go back and try again.', backPath: basketPagePath(basket.id) };
    const priced = priceBasket(basket.items, await loadSiteProducts(db, orgId, req.definition), req.definition);
    const blocker = priced.dropped.length ? 'Some items are no longer for sale: they have been taken out. Check your basket, then check out.' : checkoutBlocker(priced.lines);
    if (priced.dropped.length) await saveBasket(db, { id: basket.id, siteId: req.site.id, orgId, items: basket.items.filter((_, n) => priced.lines.some((l) => l.index === n)) });
    if (blocker) return { kind: 'error', status: 409, title: 'Please check your basket', message: blocker, backPath: basketPagePath(basket.id) };
    const ready = await readyToSell(db, orgId, basketPagePath(basket.id));
    if ('kind' in ready) return ready;
    const limited = await rateLimited(db, req.ip, basketPagePath(basket.id));
    if (limited) return limited;
    const sections = req.definition.pages.flatMap((p) => p.sections);
    const collectAddress = priced.lines.some((l) => { const s = sections.find((x) => x.id === l.sectionId); return s?.type === 'products' && s.props.collectAddress; });
    try {
        const session = await (await stripeClient()).checkout.sessions.create(
            basketCheckoutParams({ origin: req.origin, site: req.site, basketId: basket.id, lines: priced.lines, collectAddress, shop: ready.shop, imageUrl: req.assetUrl, delivery: await loadDelivery(db, orgId) }),
            { stripeAccount: ready.account.stripeAccountId },
        );
        if (!session.url) throw new Error('Stripe returned no checkout address');
        await markBasketCheckout(db, basket.id, req.site.id, priced.lines.map((l) => ({ productId: l.productId, optionId: l.optionId, name: l.name, unit: l.unit, qty: l.qty })), session.id);
        return { kind: 'redirect', location: session.url };
    } catch (err) {
        console.error('[site-shop] basket checkout failed', { siteId: req.site.id, message: err instanceof Error ? err.message : String(err) });
        return { kind: 'error', status: 503, title: 'Checkout couldn\'t be started', message: 'Nothing was charged. Please try again in a minute.', backPath: basketPagePath(basket.id) };
    }
}

// ── Recording an order (Connect webhook) ──────────────────────────────────────────────────────

/**
 * A completed, PAID Checkout Session on a connected account → one site_orders row, and the owner is
 * told. Checks that the session's account is the one that workspace connected (metadata alone is
 * never trusted). Returns false when the event is not ours or not paid; repeat deliveries are no-ops.
 */
export async function recordPaidCheckout(db: Db, accountId: string, session: Stripe.Checkout.Session): Promise<boolean> {
    if (session.payment_status !== 'paid') return false;
    // A booking deposit is not an order (booking-deposits.ts; the webhook routes it there first).
    if (session.metadata?.bms_kind === 'booking_deposit') return false;
    // A stay's balance (stay-charges.ts) is a booking payment, never a shop order.
    if (session.metadata?.bms_kind === 'stay_balance') return false;
    const siteId = Number(session.metadata?.bms_site_id);
    if (!Number.isInteger(siteId)) return false;
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return false;
    const account = await connectAccountFor(db, site.organisationId);
    if (!account || account.stripeAccountId !== accountId) {
        console.error('[site-shop] checkout for a site whose workspace did not connect this account', { siteId, accountId });
        return false;
    }

    // A basket (shop-basket.ts): its lines are the snapshot saved for THIS session when the buyer checked out.
    const basketId = session.metadata?.bms_basket || null;
    const lines = basketId ? await checkoutLinesFor(db, site.organisationId, basketId, session.id) : null;
    if (basketId && !lines) console.error('[site-shop] basket order without its saved lines', { siteId, session: session.id });
    const unit = Number(session.metadata?.bms_unit);
    // One product: the subtotal is the unit price times the quantity chosen. A basket: the lines' quantities.
    const quantity = lines ? Math.max(1, lines.reduce((n, l) => n + l.qty, 0))
        : unit > 0 && session.amount_subtotal ? Math.max(1, Math.round(session.amount_subtotal / unit)) : 1;
    const shipping = session.collected_information?.shipping_details ?? null;
    const [order] = await db.insert(siteOrders).values({
        siteId: site.id, organisationId: site.organisationId, stripeAccountId: accountId, checkoutSessionId: session.id,
        itemName: (session.metadata?.bms_item_name || 'Item').slice(0, 120),
        quantity,
        amountTotal: session.amount_total ?? 0, currency: session.currency ?? 'gbp',
        customerName: session.customer_details?.name ?? null, customerEmail: session.customer_details?.email ?? null,
        shippingAddress: shipping ? { name: shipping.name, address: shipping.address } : null,
        pagePath: session.metadata?.bms_page ?? null,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
    }).onConflictDoNothing({ target: siteOrders.checkoutSessionId }).returning();
    if (!order) return true;   // a retry of an order already recorded

    // Take it from stock — once, here, because only the first delivery of this webhook inserts the order.
    // A blip is tried once more; if it still fails, the owner is told to check the count (a repeat
    // webhook never gets here, so nothing else would correct it).
    // An option has its own stock (shop-options.ts); otherwise the product's.
    const takeOne = async (productId: number, optionId: number | null, qty: number): Promise<{ taken: StockTaken | null; failed: boolean }> => {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const taken = optionId && optionId > 0
                    ? await takeOptionStock(db, site.organisationId, optionId, qty)
                    : await takeStock(db, site.organisationId, productId, qty);
                return { taken, failed: false };
            } catch (err) {
                console.error('[site-shop] stock update failed', { orderId: order.id, attempt, message: err instanceof Error ? err.message : String(err) });
            }
        }
        return { taken: null, failed: true };
    };
    let stockLine: string | null;
    let orderLines: OrderLine[] | null = null;
    let linesFailed = false;
    // The delivery the buyer chose on Stripe (shop-delivery.ts): its name from the shipping rate, its cost.
    const delivery = await chosenDelivery(accountId, session);
    if (delivery) await recordOrderDelivery(db, order.id, delivery.name, delivery.amount);
    if (lines) {
        // A basket: its lines, each line's stock, and the basket emptied.
        // One statement (all lines or none); if it fails the owner is told, since a repeated webhook never comes back here.
        await writeOrderLines(db, order.id, site.organisationId, lines).catch((err) => {
            linesFailed = true;
            console.error('[site-shop] order lines failed', { orderId: order.id, message: err instanceof Error ? err.message : String(err) });
        });
        orderLines = lines.map((l) => ({ name: l.name, unit: l.unit, qty: l.qty }));
        const notes: string[] = [];
        let failed = false;
        for (const l of lines) {
            const r = await takeOne(l.productId, l.optionId, l.qty);
            failed ||= r.failed;
            const note = stockAfterOrderLine(r.taken, l.qty);
            if (note) notes.push(`${l.name}: ${note}`);
        }
        stockLine = failed ? STOCK_NOT_UPDATED_LINE : notes.length ? notes.join(' ') : null;
        if (basketId) await emptyBasket(db, basketId, site.organisationId).catch(() => undefined);
    } else if (basketId) {
        stockLine = STOCK_NOT_UPDATED_LINE;   // the saved lines couldn't be read: the owner checks Stripe and the counts
    } else {
        const optionId = Number(session.metadata?.bms_option);
        const r = await takeOne(Number(session.metadata?.bms_product), Number.isInteger(optionId) && optionId > 0 ? optionId : null, order.quantity);
        stockLine = r.failed ? STOCK_NOT_UPDATED_LINE : stockAfterOrderLine(r.taken, order.quantity);
    }

    const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name, email: users.email })
        .from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId))
        .where(eq(aiAssistants.id, site.aiAssistantId)).limit(1);
    const total = order.currency === 'gbp' ? formatPrice(order.amountTotal)
        : cleanCurrency(order.currency) ? formatMoney(order.amountTotal, order.currency) : `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`;
    if (owner?.userId) {
        await createNotification(db, 'site_order_received', {
            userId: owner.userId, assistantId: site.aiAssistantId, category: 'state_change',
            context: { assistant: { name: owner.name }, order: { item: order.itemName, total } },
            metadata: { assistantId: site.aiAssistantId, siteId: site.id, orderId: order.id },
        }).catch((err) => console.error('[site-shop] notification failed', err));
    }
    if (owner?.email) {
        const addr = order.shippingAddress as { name?: string; address?: Record<string, string | null> } | null;
        const addrLines = addr?.address ? [addr.name, addr.address.line1, addr.address.line2, addr.address.city, addr.address.postal_code].filter(Boolean) : [];
        await sendEmail({
            to: owner.email,
            ...(order.customerEmail ? { replyTo: order.customerEmail } : {}),
            subject: `New order from your website: ${order.itemName} (${total})`,
            html: `<p>${esc(order.customerName || 'Someone')} paid <strong>${esc(total)}</strong> for ${orderLines ? 'these items:' : `${order.quantity} × ${esc(order.itemName)}.`}</p>
${orderLines ? orderLinesHtml(orderLines, order.currency) : ''}
${delivery ? `<p><strong>Delivery:</strong> ${esc(deliveryLine(delivery, order.currency))}</p>` : ''}
${order.customerEmail ? `<p><strong>Email:</strong> ${esc(order.customerEmail)}</p>` : ''}
${addrLines.length ? `<p><strong>Deliver to:</strong><br>${addrLines.map((l) => esc(String(l))).join('<br>')}</p>` : ''}
${stockLine ? `<p><strong>Stock:</strong> ${esc(stockLine)}</p>` : ''}
${linesFailed ? `<p><strong>⚠️ ${esc(ORDER_LINES_NOT_SAVED_LINE)}</strong></p>` : ''}
<p>The money goes to your Stripe account; refunds are made from your Stripe dashboard. It is also on your Orders page.</p>`,
        }).catch((err: unknown) => console.error('[site-shop] owner email failed', err instanceof Error ? err.message : err));
    }
    await sendBuyerConfirmation(db, order, site, total, orderLines, delivery).catch((err: unknown) => console.error('[site-shop] buyer email failed', err instanceof Error ? err.message : err));
    return true;
}

type OrderRow = typeof siteOrders.$inferSelect;

/** "Royal Mail Tracked 48 — £3.95" / "Collect in person — free". Pure. */
export function deliveryLine(d: { name: string | null; amount: number | null }, currency: string): string {
    const cost = d.amount == null ? '' : d.amount === 0 ? 'free' : formatMoney(d.amount, currency);
    return [d.name || 'Delivery', cost].filter(Boolean).join(' — ');
}

/** The delivery chosen on Stripe's page: its amount from the session; its name from the shipping rate (an id in
 *  the webhook, so it is read from the connected account; on failure the amount alone is recorded). */
async function chosenDelivery(accountId: string, session: Stripe.Checkout.Session): Promise<{ name: string | null; amount: number | null } | null> {
    const cost = session.shipping_cost;
    if (!cost) return null;
    const rate = cost.shipping_rate;
    let name: string | null = typeof rate === 'object' && rate ? (rate.metadata?.bms_delivery || rate.display_name || null) : null;
    if (!name && typeof rate === 'string') {
        try {
            const r = await (await stripeClient()).shippingRates.retrieve(rate, {}, { stripeAccount: accountId });
            name = r.metadata?.bms_delivery || r.display_name || null;
        } catch (err) {
            console.error('[site-shop] shipping rate not read', err instanceof Error ? err.message : err);
        }
    }
    return { name, amount: cost.amount_total ?? null };
}

/** The owner's email when a basket order's items couldn't be saved on the order (the email still lists them). */
export const ORDER_LINES_NOT_SAVED_LINE = 'We couldn\'t save this order\'s items on your Shop tab. They are listed above and in your Stripe dashboard.';

/** A basket order's lines, for the owner's and the buyer's emails. */
export function orderLinesHtml(lines: OrderLine[], currency: string): string {
    return `<ul>${lines.map((l) => `<li>${l.qty} × ${esc(l.name)} — ${esc(formatMoney(l.unit * l.qty, currency))}</li>`).join('')}</ul>`;
}

/** "Order confirmed" — from the business, to the buyer (CCR 2013: confirmation in a durable form). */
export function buyerEmail(o: { order: OrderRow; shop: ShopSettings; total: string; termsUrl: string | null; lines?: OrderLine[] | null; delivery?: { name: string | null; amount: number | null } | null }): { subject: string; html: string } {
    const { order, shop } = o;
    const addr = order.shippingAddress as { name?: string; address?: Record<string, string | null> } | null;
    const addrLines = addr?.address ? [addr.name, addr.address.line1, addr.address.line2, addr.address.city, addr.address.postal_code].filter(Boolean) : [];
    const business = shop.traderName || 'the shop';
    return {
        subject: `Order confirmed — ${business}`,
        html: `<p>Hi ${esc(order.customerName || 'there')},</p>
<p>Thank you for your order. We've received your payment of <strong>${esc(o.total)}</strong>${shop.vatNumber ? ' (including VAT)' : ''}.</p>
${o.lines?.length ? `<p><strong>Your order</strong> (reference ${order.id}):</p>${orderLinesHtml(o.lines, order.currency)}` : `<p><strong>Your order:</strong> ${order.quantity} × ${esc(order.itemName)}<br><strong>Order reference:</strong> ${order.id}</p>`}
${addrLines.length ? `<p><strong>Delivering to:</strong><br>${addrLines.map((l) => esc(String(l))).join('<br>')}</p>` : ''}
${o.delivery ? `<p><strong>Delivery chosen:</strong> ${esc(deliveryLine(o.delivery, order.currency))}</p>` : ''}
<p><strong>Delivery:</strong> ${esc(shop.deliveryText || '')}</p>
<p><strong>Changed your mind?</strong> ${esc(returnsSummaryText(shop))} To cancel, reply to this email.${o.termsUrl ? ` Full details and a cancellation form: <a href="${esc(o.termsUrl)}">${esc(o.termsUrl)}</a>` : ''}</p>
<p><strong>Sold by:</strong></p>${traderBlockHtml(shop)}
<p style="color:#666;font-size:12px">Payment was taken by Stripe for ${esc(business)}. Keep this email as your record of the order.</p>`,
    };
}

async function sendBuyerConfirmation(db: Db, order: OrderRow, site: SiteRow, total: string, lines: OrderLine[] | null = null, delivery: { name: string | null; amount: number | null } | null = null): Promise<void> {
    if (!order.customerEmail) return;
    const shop = await loadShopSettings(db, site.organisationId);
    if (!shop || !shopReady(shop)) return;   // never sell without these; an old open checkout is the only way here
    const termsUrl = site.slug ? `${(await import('./site-hosting')).siteOrigin(site.slug)}${SHOP_TERMS_PATH}` : null;
    const mail = buyerEmail({ order, shop, total, termsUrl, lines, delivery });
    await sendEmail({
        to: order.customerEmail,
        from: `${(shop.traderName || 'Your order').replace(/[<>"\\\r\n]/g, '').slice(0, 60)} (via Be More Swan) <noreply@bemoreswan.com>`,
        ...(shop.contactEmail ? { replyTo: shop.contactEmail } : {}),
        subject: mail.subject, html: mail.html,
    });
    await db.update(siteOrders).set({ buyerEmailedAt: new Date() }).where(eq(siteOrders.id, order.id));
}

/**
 * A refund made in the business's Stripe dashboard (charge.refunded on the Connect webhook): note the
 * amount on the order, and mark it refunded when all of it is. Only the account that took the order
 * can refund it. Returns false when no order matches.
 */
export async function recordRefund(db: Db, accountId: string, charge: Stripe.Charge): Promise<boolean> {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!pi) return false;
    let [order] = await db.select().from(siteOrders).where(and(eq(siteOrders.paymentIntentId, pi), eq(siteOrders.stripeAccountId, accountId))).limit(1);
    if (!order) {
        // An order recorded before payment_intent_id existed: find its Checkout Session by payment.
        const list = await (await stripeClient()).checkout.sessions.list({ payment_intent: pi, limit: 1 }, { stripeAccount: accountId }).catch(() => null);
        const sessionId = list?.data?.[0]?.id;
        if (!sessionId) return false;
        [order] = await db.select().from(siteOrders).where(and(eq(siteOrders.checkoutSessionId, sessionId), eq(siteOrders.stripeAccountId, accountId))).limit(1);
        if (!order) return false;
    }
    const refunded = Math.min(charge.amount_refunded ?? 0, order.amountTotal);
    await db.update(siteOrders).set({
        paymentIntentId: pi, refundedAmount: refunded,
        ...(refunded >= order.amountTotal && order.amountTotal > 0 ? { status: 'refunded' } : {}),
    }).where(eq(siteOrders.id, order.id));
    return true;
}

/** The Shopkeeper's Shop tab (shop.ts): the same rule as markOrderDone across the whole workspace's
 *  orders, since a Shopkeeper is not tied to one website. */
export async function markShopOrderDone(db: Db, orgId: number, orderId: number, done: boolean): Promise<boolean> {
    if (!Number.isInteger(orderId) || orderId <= 0) return false;
    const [row] = await db.update(siteOrders).set({ status: done ? 'done' : 'paid' })
        .where(and(eq(siteOrders.id, orderId), eq(siteOrders.organisationId, orgId), ne(siteOrders.status, 'refunded'))).returning({ id: siteOrders.id });
    return !!row;
}

export async function markOrderDone(db: Db, orgId: number, siteId: number, orderId: number, done: boolean): Promise<boolean> {
    // A refunded order stays refunded: "Mark as done" never hides a refund.
    const [row] = await db.update(siteOrders).set({ status: done ? 'done' : 'paid' })
        .where(and(eq(siteOrders.id, orderId), eq(siteOrders.siteId, siteId), eq(siteOrders.organisationId, orgId), ne(siteOrders.status, 'refunded'))).returning({ id: siteOrders.id });
    return !!row;
}
