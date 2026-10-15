// netlify/functions/stripe-connect-webhook.ts
// Stripe events from CONNECTED accounts — the Website Assistant's shops (step 3c). Separate from
// stripe-webhook.ts (our own billing) on purpose: a different endpoint, a different signing secret
// (STRIPE_CONNECT_WEBHOOK_SECRET), and nothing here may ever touch a customer's Be More Swan plan.
//
// Set up in the Stripe dashboard → Developers → Webhooks → Add endpoint →
// "Events on Connected accounts", URL https://bemoreswan.com/.netlify/functions/stripe-connect-webhook,
// events: checkout.session.completed, checkout.session.async_payment_succeeded, account.updated.
//
//   checkout.session.completed / async_payment_succeeded → record the order (site-shop.ts), if paid
//   account.updated                                       → keep charges_enabled & co. in step
//
// Fails closed without the secret. Repeat deliveries are harmless: orders are unique per session.

import Stripe from 'stripe';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { STRIPE_API_VERSION } from '../../src/utils/stripe';
import { recordPaidCheckout, syncConnectAccount } from '../../src/utils/site-shop';

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
            await recordPaidCheckout(db, evt.account, evt.data.object as Stripe.Checkout.Session);
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
