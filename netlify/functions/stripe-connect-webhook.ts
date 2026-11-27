// netlify/functions/stripe-connect-webhook.ts
// Stripe events from CONNECTED accounts — the Website Assistant's shops (step 3c). Separate from
// stripe-webhook.ts (our own billing) on purpose: a different endpoint, a different signing secret
// (STRIPE_CONNECT_WEBHOOK_SECRET), and nothing here may ever touch a customer's Be More Swan plan.
//
// Set up in the Stripe dashboard → Developers → Webhooks → Add endpoint →
// "Events on Connected accounts", URL https://bemoreswan.com/.netlify/functions/stripe-connect-webhook,
// events: checkout.session.completed, checkout.session.async_payment_succeeded, account.updated
// and checkout.session.expired (unpaid deposit holds also lapse on their own; the shop's abandoned-checkout
// reminder needs it — without it no reminder is ever sent).
//
//   checkout.session.completed / async_payment_succeeded → a booking deposit (booking-deposits.ts),
//                                                           else record the order (site-shop.ts), if paid
//   checkout.session.expired                              → let an unpaid deposit hold go now, or send a basket's
//                                                           one abandoned-checkout reminder (shop-checkout-reminder.ts)
//   account.updated                                       → keep charges_enabled & co. in step
//
// Fails closed without the secret. Repeat deliveries are harmless: orders are unique per session.

import Stripe from 'stripe';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { STRIPE_API_VERSION } from '../../src/utils/stripe';
import { connectAccountFor, recordPaidCheckout, recordRefund, syncConnectAccount } from '../../src/utils/site-shop';
import { sendCheckoutReminder } from '../../src/utils/shop-checkout-reminder';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { depositPaid, releaseHold } from '../../src/utils/booking-deposits';
import { balanceCharge, stayBalancePaid, stayModeFor, stayPaymentSettled } from '../../src/utils/stay-charges';
import { formatMoney } from '../../src/utils/product-price';
import { describeCancellation } from '../../src/utils/stay-quote';
import { loadStays, pricingOf } from '../../src/utils/stays';
import { announceNewBooking, describeBooking, loadBookingSetup } from '../../src/utils/bookings';
import { sendBusinessEmail } from '../../src/utils/business-email';
import { organisations, sites } from '../../db/schema';
import { siteOrigin } from '../../src/utils/site-hosting';
import { esc } from '../../src/utils/site-render';
import { eq } from 'drizzle-orm';

/**
 * A deposit was paid: the held booking becomes a real one and everyone is told now (bookings.ts).
 * If the hold had already gone, the payment was refunded (booking-deposits.ts) and they're told so.
 */
async function depositSettled(db: ReturnType<typeof getDb>, accountId: string, session: Stripe.Checkout.Session): Promise<void> {
    const orgId = Number(session.metadata?.bms_org);
    if (!Number.isInteger(orgId)) return;
    const setup = await loadBookingSetup(db, orgId);
    // A stay (holiday let / B&B room) confirms by its OWN instant / request setting (stay-charges.ts).
    const stayId = Number(session.metadata?.bms_stay);
    const stayMode = Number.isInteger(stayId) && stayId > 0 ? await stayModeFor(db, stayId) : null;
    const r = await depositPaid(db, accountId, session, stayMode ?? setup.settings.mode);
    if (!r) return;
    const b = r.lateRefund ? r.booking : await stayPaymentSettled(db, r.booking, session);
    // A stay's cancellation terms are its own, in words (the business's booking policy is for appointments).
    const [stay] = b.kind === 'stay' && b.stayTypeId ? await loadStays(db, b.organisationId, { ids: [b.stayTypeId] }) : [];
    const cancellationPolicy = stay ? describeCancellation(pricingOf(stay).cancellation) : setup.settings.cancellationPolicy;
    const [site] = b.siteId ? await db.select({ slug: sites.slug, aiAssistantId: sites.aiAssistantId }).from(sites).where(eq(sites.id, b.siteId)).limit(1) : [];
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, b.organisationId)).limit(1);
    const business = org?.name || 'Your booking';
    if (r.lateRefund) {
        const { when, what } = describeBooking(b, setup.settings.timezone);
        // Own address only (business-email.ts); with none, Stripe's own refund receipt is what they get.
        await sendBusinessEmail(db, b.organisationId, {
            business, to: b.customerEmail, subject: `Your deposit has been refunded — ${business}`,
            html: `<p>Sorry, ${esc(b.customerName)} — your payment for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong> arrived after the time was released, so nothing was booked. Your deposit has been refunded in full; it usually reaches your card within 5–10 days.</p><p>Please book again on our website.</p>`,
        });
        return;
    }
    await announceNewBooking(db, b, {
        business, timezone: setup.settings.timezone, assistantId: site?.aiAssistantId ?? null,
        cancellationPolicy, siteOrigin: site?.slug ? siteOrigin(site.slug) : null,
    });
}

/** A stay's balance came in from the guest's link: record it, and send them a receipt. */
async function balanceSettled(db: ReturnType<typeof getDb>, accountId: string, session: Stripe.Checkout.Session): Promise<void> {
    const b = await stayBalancePaid(db, accountId, session);
    if (!b) return;
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, b.organisationId)).limit(1);
    const business = org?.name || 'Your stay';
    const { what, when } = describeBooking(b, 'UTC');
    const paid = balanceCharge({ ...b, damageDepositStatus: session.metadata?.bms_damage === '1' ? 'due' : 'none' });
    const m = (n: number) => formatMoney(n, b.currency || 'GBP');
    await sendBusinessEmail(db, b.organisationId, {
        business, to: b.customerEmail, subject: `Balance paid — ${business}`,
        html: `<p>Hi ${esc(b.customerName)},</p><p>Thank you — we've received your balance of <strong>${esc(m(paid.balance))}</strong> for <strong>${esc(what)}</strong>, ${esc(when)}${paid.damage ? `, with the refundable damage deposit of ${esc(m(paid.damage))}` : ''}. You're all paid up.</p>`,
    });
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!secret || !key) {
        console.error('[stripe-connect-webhook] STRIPE_CONNECT_WEBHOOK_SECRET or STRIPE_SECRET_KEY is not set');
        return { statusCode: 500, body: 'Not configured' };
    }
    // constructEvent must see the exact bytes Stripe signed (same rule as stripe-webhook.ts).
    const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '');
    let evt: Stripe.Event;
    try {
        evt = new Stripe(key, { apiVersion: STRIPE_API_VERSION }).webhooks.constructEvent(rawBody, event.headers['stripe-signature'] || '', secret);
    } catch (err) {
        console.error('[stripe-connect-webhook] bad signature', err instanceof Error ? err.message : err);
        return { statusCode: 400, body: 'Bad signature' };
    }
    if (!evt.account) return { statusCode: 200, body: 'ignored: not a connected-account event' };

    const db = getDb();
    try {
        if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
            const session = evt.data.object as Stripe.Checkout.Session;
            if (session.metadata?.bms_kind === 'booking_deposit') await depositSettled(db, evt.account, session);
            // A stay's balance, paid from the guest's link (stay-charges.ts).
            else if (session.metadata?.bms_kind === 'stay_balance') await balanceSettled(db, evt.account, session);
            else await recordPaidCheckout(db, evt.account, session);
        } else if (evt.type === 'checkout.session.expired') {
            const session = evt.data.object as Stripe.Checkout.Session;
            const id = Number(session.metadata?.bms_booking);
            if (session.metadata?.bms_kind === 'booking_deposit' && Number.isInteger(id)) await releaseHold(db, id);
            // A shop basket's checkout lapsed: its one reminder, only if the buyer ticked "Send me news" (slice 5).
            else if (session.metadata?.bms_basket) {
                const r = await sendCheckoutReminder(db, evt.account, session, { baseUrl: resolveBaseUrl((event.headers || {}) as Record<string, string | undefined>), connectAccountFor });
                if (r !== 'not_ticked') console.log('[stripe-connect-webhook] checkout reminder', { session: session.id, result: r });
            }
        } else if (evt.type === 'account.updated') {
            await syncConnectAccount(db, evt.data.object as Stripe.Account);
        } else if (evt.type === 'charge.refunded') {
            // A refund made in the business's own Stripe dashboard → the shop order shows it (site-shop.ts).
            // ⚠️ The Connect endpoint must list charge.refunded in Stripe (Developers → Webhooks).
            await recordRefund(db, evt.account, evt.data.object as Stripe.Charge);
        }
    } catch (err) {
        // A 500 makes Stripe retry, which is what we want for a database blip.
        console.error('[stripe-connect-webhook] failed', { type: evt.type, id: evt.id, message: err instanceof Error ? err.message : String(err) });
        return { statusCode: 500, body: 'Failed' };
    }
    return { statusCode: 200, body: 'ok' };
});
