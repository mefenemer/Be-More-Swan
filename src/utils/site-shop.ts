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
// ── Orders ──────────────────────────────────────────────────────────────────────────────────────
// Recorded from the Connect webhook (stripe-connect-webhook.ts → recordPaidCheckout), not from the
// success page: a visitor who closes the tab after paying has still paid.

import { and, eq, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { getDb } from '../../db/client';
import { aiAssistants, orgProducts, siteOrders, sites, stripeConnectAccounts, users } from '../../db/schema';
import { createNotification } from './notify';
import { sendEmail } from './email';
import { checkRateLimit } from './rate-limit';
import { getStripe } from './stripe';
import { currentEnv } from './env-context';
import { esc, formatPrice, FORM_SENT_PATH } from './site-render';
import type { SiteDefinition } from './site-definition';
import { buyablePence } from './product-price';
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

/** Whether this workspace's site may show Buy buttons right now. */
export async function canSell(db: Db, orgId: number): Promise<boolean> {
    const row = await connectAccountFor(db, orgId).catch(() => null);
    return !!row?.chargesEnabled;
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
    const stripe = getStripe();
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
    const account = await getStripe().accounts.retrieve(row.stripeAccountId);
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
    /** Pence, when it can be bought online (a fixed price); else null. */
    buyPence: number | null;
    imageAssetId: number | null;
    /** Minutes, for a service with a length (shown on a menu / price list when asked). */
    durationMinutes?: number | null;
    /** Dietary markers and allergen words (product-dietary.ts), for a menu. */
    dietary?: unknown;
    allergens?: string | null;
}

/** The active products a site's products sections name, keyed by id — only this workspace's. */
export async function loadSiteProducts(db: Db, orgId: number, def: SiteDefinition): Promise<Record<number, SiteProduct>> {
    const ids = [...new Set(def.pages.flatMap((p) => p.sections).flatMap((s) => (s.type === 'products' ? s.props.productIds
        : s.type === 'menu' ? s.props.groups.flatMap((g) => g.productIds) : [])))];
    if (!ids.length) return {};
    const rows = await db.select({
        id: orgProducts.id, name: orgProducts.name, description: orgProducts.description, price: orgProducts.price,
        priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount, imageAssetId: orgProducts.imageAssetId,
        durationMinutes: orgProducts.durationMinutes, dietary: orgProducts.dietary, allergens: orgProducts.allergens,
    }).from(orgProducts).where(and(inArray(orgProducts.id, ids), eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active')));
    return Object.fromEntries(rows.map((r) => [r.id, {
        id: r.id, name: r.name, description: r.description, price: r.price, buyPence: buyablePence(r), imageAssetId: r.imageAssetId,
        durationMinutes: r.durationMinutes ?? null, dietary: r.dietary ?? null, allergens: r.allergens ?? null,
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

/** The Checkout Session parameters for one product — pure, so the money rules are testable. */
export function checkoutParams(req: { origin: string; site: SiteRow; sectionId: string; product: SiteProduct; collectAddress: boolean; backPath: string; imageUrl?: string | null }): Stripe.Checkout.SessionCreateParams {
    const { product } = req;
    // Stripe shows the picture on its checkout page: it needs a real https address.
    const picture = req.imageUrl ?? null;
    return {
        mode: 'payment',
        line_items: [{
            quantity: 1,
            adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_QUANTITY },
            price_data: {
                currency: 'gbp',
                unit_amount: product.buyPence!,
                product_data: {
                    name: product.name,
                    ...(product.description ? { description: product.description.slice(0, 500) } : {}),
                    ...(picture && picture.startsWith('https://') ? { images: [picture] } : {}),
                },
            },
        }],
        ...(req.collectAddress ? { shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES } } : {}),
        success_url: `${req.origin}${FORM_SENT_PATH}?k=order&b=${encodeURIComponent(req.backPath)}`,
        cancel_url: `${req.origin}${req.backPath}`,
        // What the order records — the name and unit price as they were at checkout (Stripe caps a
        // metadata value at 500 characters; names are capped at 120 in Business Information).
        metadata: {
            bms_site_id: String(req.site.id), bms_org_id: String(req.site.organisationId), bms_section: req.sectionId,
            bms_product: String(product.id), bms_item_name: product.name, bms_unit: String(product.buyPence), bms_page: req.backPath,
        },
    };
}

export async function startCheckout(db: Db, req: BuyRequest): Promise<BuyOutcome> {
    const back = req.backPath;
    const sectionId = String(req.body.get('_s') || '');
    const productId = Number(req.body.get('_pid'));
    const notForSale: BuyOutcome = { kind: 'error', status: 404, title: 'That item isn\'t for sale here any more', message: 'The page may have changed since you opened it. Go back and have another look.', backPath: back };
    // The section must be on the PUBLISHED site and must offer this product.
    const section = req.definition.pages.flatMap((p) => p.sections).find((s) => s.id === sectionId);
    if (!section || section.type !== 'products' || !Number.isInteger(productId) || !section.props.productIds.includes(productId)) return notForSale;
    // Name, price and picture: read from Business Information now — never from the visitor's browser.
    const product = (await loadSiteProducts(db, req.site.organisationId, req.definition))[productId];
    if (!product || product.buyPence === null) return notForSale;
    // The item the visitor saw must be the item they buy.
    if (String(req.body.get('_n') || '') !== product.name || Number(req.body.get('_v')) !== product.buyPence) {
        return { kind: 'error', status: 409, title: 'This item has changed', message: 'The details changed since you opened the page. Go back to see the current price before you buy.', backPath: back };
    }
    const account = await connectAccountFor(db, req.site.organisationId);
    if (!account?.chargesEnabled) {
        return { kind: 'error', status: 503, title: 'Online payments aren\'t available right now', message: 'Please get in touch with the business to buy this.', backPath: back };
    }
    try {
        const limited = await checkRateLimit(db, 'site_buy_ip', req.ip, BUY_LIMIT);
        if (!limited.allowed) return { kind: 'error', status: 429, title: 'Please try again shortly', message: 'Too many checkouts were started from here just now.', backPath: back };
    } catch (err) {
        console.error('[site-shop] rate limiter unavailable — allowing the checkout', err);
    }
    try {
        const session = await getStripe().checkout.sessions.create(
            checkoutParams({
                origin: req.origin, site: req.site, sectionId, product, collectAddress: section.props.collectAddress, backPath: back,
                imageUrl: product.imageAssetId ? (req.assetUrl?.(product.imageAssetId) ?? null) : null,
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
    const siteId = Number(session.metadata?.bms_site_id);
    if (!Number.isInteger(siteId)) return false;
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return false;
    const account = await connectAccountFor(db, site.organisationId);
    if (!account || account.stripeAccountId !== accountId) {
        console.error('[site-shop] checkout for a site whose workspace did not connect this account', { siteId, accountId });
        return false;
    }

    const unit = Number(session.metadata?.bms_unit);
    // One line, no shipping charge: the subtotal is the unit price times the quantity chosen.
    const quantity = unit > 0 && session.amount_subtotal ? Math.max(1, Math.round(session.amount_subtotal / unit)) : 1;
    const shipping = session.collected_information?.shipping_details ?? null;
    const [order] = await db.insert(siteOrders).values({
        siteId: site.id, organisationId: site.organisationId, stripeAccountId: accountId, checkoutSessionId: session.id,
        itemName: (session.metadata?.bms_item_name || 'Item').slice(0, 120),
        quantity,
        amountTotal: session.amount_total ?? 0, currency: session.currency ?? 'gbp',
        customerName: session.customer_details?.name ?? null, customerEmail: session.customer_details?.email ?? null,
        shippingAddress: shipping ? { name: shipping.name, address: shipping.address } : null,
        pagePath: session.metadata?.bms_page ?? null,
    }).onConflictDoNothing({ target: siteOrders.checkoutSessionId }).returning();
    if (!order) return true;   // a retry of an order already recorded

    const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name, email: users.email })
        .from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId))
        .where(eq(aiAssistants.id, site.aiAssistantId)).limit(1);
    const total = order.currency === 'gbp' ? formatPrice(order.amountTotal) : `${(order.amountTotal / 100).toFixed(2)} ${order.currency.toUpperCase()}`;
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
            html: `<p>${esc(order.customerName || 'Someone')} paid <strong>${esc(total)}</strong> for ${order.quantity} × ${esc(order.itemName)}.</p>
${order.customerEmail ? `<p><strong>Email:</strong> ${esc(order.customerEmail)}</p>` : ''}
${addrLines.length ? `<p><strong>Deliver to:</strong><br>${addrLines.map((l) => esc(String(l))).join('<br>')}</p>` : ''}
<p>The money goes to your Stripe account; refunds are made from your Stripe dashboard. It is also on your Website Assistant's Orders tab.</p>`,
        }).catch((err: unknown) => console.error('[site-shop] owner email failed', err instanceof Error ? err.message : err));
    }
    return true;
}

export async function markOrderDone(db: Db, orgId: number, siteId: number, orderId: number, done: boolean): Promise<boolean> {
    const [row] = await db.update(siteOrders).set({ status: done ? 'done' : 'paid' })
        .where(and(eq(siteOrders.id, orderId), eq(siteOrders.siteId, siteId), eq(siteOrders.organisationId, orgId))).returning({ id: siteOrders.id });
    return !!row;
}
