// netlify/functions/renewal-reminder.ts
// US-LEGAL-1.5: 14-day pre-renewal email for all subscription plans (DMCCA / FTC compliance).
//
// Scheduled daily at 07:00 UTC (schedule: "0 7 * * *")
// Queries Stripe for subscriptions whose current_period_end is exactly 14 days from now (±12h window).
// Sends one email per user per renewal cycle; deduplication via processedWebhookEvents keyed on
// sub_id + renewal_cycle_start.

import type { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, processedWebhookEvents } from '../../db/schema';
import { sendTemplatedEmail } from '../../src/utils/email';
import { DISCOUNT_EXPANDS, renewalDiscountNote, summariseDiscount } from '../../src/utils/billing-doc';
import Stripe from 'stripe';
import { withLambda } from '@netlify/aws-lambda-compat';

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

const BASE_URL = process.env.BASE_URL || '';

async function runRenewalReminder() {
    if (!stripe) { console.warn('[renewal-reminder] Stripe not configured.'); return; }

    const db = getDb();
    const now = new Date();

    // Window: subscriptions renewing between 13.5 and 14.5 days from now
    const windowStart = Math.floor((now.getTime() + 13.5 * 24 * 60 * 60 * 1000) / 1000);
    const windowEnd   = Math.floor((now.getTime() + 14.5 * 24 * 60 * 60 * 1000) / 1000);

    // Fetch active subscriptions from Stripe renewing in the 14-day window
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
        const page = await stripe.subscriptions.list({
            status: 'active',
            limit: 100,
            // The subscription's CURRENT discount, to tell a customer when it has run out.
            expand: DISCOUNT_EXPANDS.map((e) => `data.${e}`),
            ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        for (const sub of page.data) {
            const periodEnd = sub.items.data[0]?.current_period_end ?? 0;
            if (periodEnd < windowStart || periodEnd > windowEnd) continue;

            const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
            const dedupeKey  = `renewal_reminder:${sub.id}:${sub.items.data[0]?.current_period_start ?? 0}`;

            // Skip if already sent for this cycle
            const [existing] = await db.select({ id: processedWebhookEvents.id })
                .from(processedWebhookEvents)
                .where(eq(processedWebhookEvents.stripeEventId, dedupeKey))
                .limit(1);
            if (existing) continue;

            // Resolve userId via our plans table
            const [plan] = await db.select({ userId: plans.userId })
                .from(plans)
                .where(and(eq(plans.stripeCustomerId, customerId), eq(plans.status, 'active')))
                .limit(1);
            if (!plan?.userId) continue;

            const [user] = await db.select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
                .from(users)
                .where(eq(users.id, plan.userId))
                .limit(1);
            if (!user?.email) continue;

            const renewalDate = new Date(periodEnd * 1000).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long', year: 'numeric',
            });
            const item   = sub.items.data[0];
            const interval = item?.price?.recurring?.interval === 'year' ? 'year' : 'month';
            // ⚠️ What Stripe will ACTUALLY charge, from a preview of the next invoice. This used to be
            // item.price.unit_amount — the list price — so a founding member on 30% off was told
            // "renews for £29.00" and then charged £20.30: a wrong amount in the notice the
            // DMCCA requires us to send. The list price stays only as a fallback if the preview fails.
            let amountMinor: number | null = item?.price?.unit_amount ?? null;
            let next = null as ReturnType<typeof summariseDiscount>;
            try {
                const preview = await stripe.invoices.createPreview({ subscription: sub.id, expand: DISCOUNT_EXPANDS }) as any;
                amountMinor = typeof preview.amount_due === 'number' ? preview.amount_due : amountMinor;
                next = summariseDiscount(preview.discounts || [], preview.subtotal ?? 0, preview.currency || 'gbp');
            } catch (err) {
                console.warn('[renewal-reminder] invoice preview failed — falling back to the list price:', (err as Error)?.message);
            }
            const current = summariseDiscount(((sub as any).discounts || []) as any[], item?.price?.unit_amount ?? 0, 'gbp');
            const amount = amountMinor != null ? `£${(amountMinor / 100).toFixed(2)}` : '';
            const discountNote = renewalDiscountNote(next, current);

            // US-COMMS-1: admin-editable template 'renewal_reminder'.
            void renewalDate;
            await sendTemplatedEmail({
                triggerKey: 'renewal_reminder',
                to: user.email,
                vars: {
                    user: { first_name: user.firstName || '' },
                    billing: {
                        amount: amount ? `${amount}/${interval}` : '',
                        discount_note: discountNote,
                        portal_url: `${BASE_URL}/user-settings.html`,
                    },
                },
            }).catch(err => console.warn('[renewal-reminder] Email send failed:', err?.message));

            // Mark sent
            await db.insert(processedWebhookEvents).values({
                stripeEventId: dedupeKey,
                eventType:     'renewal_reminder',
                processedAt:   now,
            }).onConflictDoNothing();
        }

        hasMore = page.has_more;
        if (hasMore) startingAfter = page.data[page.data.length - 1].id;
    }
}

export default withLambda(async () => {
    try {
        await runRenewalReminder();
        return { statusCode: 200, body: 'ok' };
    } catch (err) {
        console.error('[renewal-reminder]', err);
        return { statusCode: 500, body: 'error' };
    }
});
