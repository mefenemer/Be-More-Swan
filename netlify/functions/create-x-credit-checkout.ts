// netlify/functions/create-x-credit-checkout.ts
// Phase 2: self-serve X credit "booster pack" purchase.
// POST { packId } → creates a one-time Stripe Checkout Session (mode: 'payment') and returns { url }.
// The grant itself happens post-payment in stripe-webhook.ts on checkout.session.completed, keyed
// by metadata.purpose === 'x_credit_pack' (grantXCredits → x_bonus). Nothing is granted here.
//
// Pack prices are defined in code (X_CREDIT_PACKS) and sent as inline price_data, so no Stripe
// dashboard product/price setup is required. Reuses the already-registered webhook endpoint.

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import { xCreditPack, xPackPrice } from '../../src/utils/ai-credits';
import { withLambda } from '@netlify/aws-lambda-compat';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId: currentUserId, organisationId: orgId } = ctx;

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured: base URL unavailable' }) };

    let packId: string; let requestedCurrency: string | undefined;
    try { ({ packId, currency: requestedCurrency } = JSON.parse(event.body || '{}')); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const pack = xCreditPack(packId);
    if (!pack) return { statusCode: 400, body: JSON.stringify({ error: 'Unknown X credit pack' }) };

    // Price authoritatively server-side in the requested currency (unknown → GBP).
    const { currency, amountMinor } = xPackPrice(pack, requestedCurrency || 'gbp');

    const [user] = await db.select({ id: users.id, email: users.email })
        .from(users).where(eq(users.id, currentUserId)).limit(1);
    if (!user?.email) return { statusCode: 403, body: JSON.stringify({ error: 'User not found' }) };

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{
                quantity: 1,
                price_data: {
                    currency,
                    product_data: { name: `Be More Swan — ${pack.label}` },
                    unit_amount: amountMinor,
                },
            }],
            customer_email: user.email,
            success_url: `${baseUrl}/workspace.html?x_credits_purchased=${pack.credits}`,
            cancel_url: `${baseUrl}/workspace.html?x_credits_cancelled=true`,
            // The webhook grants credits off THIS metadata — purpose disambiguates it from plan
            // checkouts (which carry masterPlanId). credits is authoritative from the server-side pack.
            metadata: {
                purpose: 'x_credit_pack',
                organisationId: String(orgId),
                userId: String(user.id),
                packId: pack.id,
                credits: String(pack.credits),
            },
        });
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: session.url }) };
    } catch (err) {
        console.error('[create-x-credit-checkout] stripe', (err as Error).message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create checkout session' }) };
    }
});
