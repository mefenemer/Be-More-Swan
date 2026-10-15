// netlify/functions/stripe-connect-webhook.ts
// Stripe events from CONNECTED accounts — the Website Assistant's shops (step 3c). Separate from
// stripe-webhook.ts (our own billing) on purpose: a different endpoint, a different signing secret
// (STRIPE_CONNECT_WEBHOOK_SECRET), and nothing here may ever touch a customer's Be More Swan plan.
//
// Set up in the Stripe dashboard → Developers → Webhooks → Add endpoint →
// "Events on Connected accounts", URL https://bemoreswan.com/.netlify/functions/stripe-connect-webhook,
// events: checkout.session.completed, checkout.session.async_payment_succeeded, account.updated
// (and, optionally, checkout.session.expired — unpaid deposit holds also lapse on their own).
//
//   checkout.session.completed / async_payment_succeeded → a booking deposit (booking-deposits.ts),
//                                                           else record the order (site-shop.ts), if paid
//   checkout.session.expired                              → let an unpaid deposit hold go now
//   account.updated                                       → keep charges_enabled & co. in step
//
// Fails closed without the secret. Repeat deliveries are harmless: orders are unique per session.

import Stripe from 'stripe';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { STRIPE_API_VERSION } from '../../src/utils/stripe';
import { recordPaidCheckout, syncConnectAccount } from '../../src/utils/site-shop';
import { depositPaid, releaseHold } from '../../src/utils/booking-deposits';
import { announceNewBooking, describeBooking, fromLine, loadBookingSetup } from '../../src/utils/bookings';
import { organisations, sites } from '../../db/schema';
import { siteOrigin } from '../../src/utils/site-hosting';
import { sendEmail } from '../../src/utils/email';
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
    const r = await depositPaid(db, accountId, session, setup.settings.mode);
    if (!r) return;
    const b = r.booking;
    const [site] = b.siteId ? await db.select({ slug: sites.slug, aiAssistantId: sites.aiAssistantId }).from(sites).where(eq(sites.id, b.siteId)).limit(1) : [];
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, b.organisationId)).limit(1);
    const business = org?.name || 'Your booking';
    if (r.lateRefund) {
        const { when, what } = describeBooking(b, setup.settings.timezone);
        await sendEmail({
            to: b.customerEmail, from: fromLine(business), subject: `Your deposit has been refunded — ${business}`,
            html: `<p>Sorry, ${esc(b.customerName)} — your payment for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong> arrived after the time was released, so nothing was booked. Your deposit has been refunded in full; it usually reaches your card within 5–10 days.</p><p>Please book again on our website.</p>`,
        }).catch((err: unknown) => console.error('[stripe-connect-webhook] late-refund email failed', err instanceof Error ? err.message : err));
        return;
    }
    await announceNewBooking(db, b, {
        business, timezone: setup.settings.timezone, assistantId: site?.aiAssistantId ?? null,
        cancellationPolicy: setup.settings.cancellationPolicy, siteOrigin: site?.slug ? siteOrigin(site.slug) : null,
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
            else await recordPaidCheckout(db, evt.account, session);
        } else if (evt.type === 'checkout.session.expired') {
            const session = evt.data.object as Stripe.Checkout.Session;
            const id = Number(session.metadata?.bms_booking);
            if (session.metadata?.bms_kind === 'booking_deposit' && Number.isInteger(id)) await releaseHold(db, id);
        } else if (evt.type === 'account.updated') {
            await syncConnectAccount(db, evt.data.object as Stripe.Account);
        }
    } catch (err) {
        // A 500 makes Stripe retry, which is what we want for a database blip.
        console.error('[stripe-connect-webhook] failed', { type: evt.type, id: evt.id, message: err instanceof Error ? err.message : String(err) });
        return { statusCode: 500, body: 'Failed' };
    }
    return { statusCode: 200, body: 'ok' };
});
