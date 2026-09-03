import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, payments, masterPlans } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { resolveActionNotifications, PAYMENT_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { withLambda } from '@netlify/aws-lambda-compat';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const jwtSecret = process.env.JWT_SECRET!;

/**
 * Fill in Stripe references an already-present plan row is missing, without ever clobbering
 * one that is already set.
 *
 * Both writers for a first subscription — this function and stripe-webhook.ts — race, and
 * either can arrive with metadata the other lacked. COALESCE makes the write idempotent and
 * order-independent in both directions: a populated column keeps its value, and a NULL we
 * have nothing to supply for stays NULL rather than being overwritten with NULL. Safe to run
 * on every landing, including repeat visits to workspace.html?payment=success.
 */
export type PlanRefs = { stripeCustomerId?: string; stripeSubscriptionId?: string; masterPlanIdInt: number | null };

/**
 * Which references the existing row is missing AND we can actually supply. Pure, so the
 * interleaving invariant is testable without a database or a Stripe key.
 *
 * A field is only "missing" when the row lacks it and we hold a value for it: that is what
 * makes the write a no-op on the common path (both writers holding the same metadata) and
 * keeps a populated id safe from a writer that arrived without one.
 */
export function missingPlanRefs(existing: typeof plans.$inferSelect, refs: PlanRefs) {
    return {
        customer:     !existing.stripeCustomerId && !!refs.stripeCustomerId,
        subscription: !existing.stripeSubscriptionId && !!refs.stripeSubscriptionId,
        masterPlan:   existing.masterPlanId == null && refs.masterPlanIdInt != null,
    };
}

async function backfillPlanRefs(
    existing: typeof plans.$inferSelect,
    refs: PlanRefs,
): Promise<void> {
    const { customer: missingCustomer, subscription: missingSub, masterPlan: missingMaster } =
        missingPlanRefs(existing, refs);
    if (!missingCustomer && !missingSub && !missingMaster) return; // nothing to add — leave updated_at alone

    await getDb().update(plans).set({
        stripeCustomerId:     sql`COALESCE(${plans.stripeCustomerId}, ${refs.stripeCustomerId ?? null})`,
        stripeSubscriptionId: sql`COALESCE(${plans.stripeSubscriptionId}, ${refs.stripeSubscriptionId ?? null})`,
        masterPlanId:         sql`COALESCE(${plans.masterPlanId}, ${refs.masterPlanIdInt ?? null})`,
        updatedAt:            new Date(),
    }).where(eq(plans.id, existing.id));

    console.warn(
        `[confirm-payment] Backfilled Stripe refs onto plan ${existing.id} (org ${existing.organisationId}):` +
        `${missingCustomer ? ' customer' : ''}${missingSub ? ' subscription' : ''}${missingMaster ? ' masterPlan' : ''}`,
    );
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        // 1. Auth
        const cookieHeader = event.headers.cookie || '';
        const match = cookieHeader.match(/aura_session=([^;]+)/);
        const token = match ? match[1] : null;
        if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

        let userId: number;
        try {
            const decoded = jwt.verify(token, jwtSecret) as { userId: number };
            userId = decoded.userId;
        } catch {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
        }

        const { paymentIntentId } = JSON.parse(event.body || '{}');
        if (!paymentIntentId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentIntentId' }) };

        const db = getDb();

        // 2. Retrieve the PaymentIntent from Stripe to verify it succeeded and get metadata.
        // This happens BEFORE the existing-plan lookup because the organisation this payment
        // belongs to is carried in the PI metadata, and the plan uniqueness this function has
        // to reason about is scoped per ORGANISATION, not per user.
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (pi.status !== 'succeeded') {
            return { statusCode: 400, body: JSON.stringify({ error: `Payment not succeeded: ${pi.status}` }) };
        }

        const { organisationId, tier, masterPlanId, stripeCustomerId, stripeSubscriptionId } = pi.metadata || {};

        // Confirm the PaymentIntent belongs to this user
        if (parseInt(pi.metadata?.userId || '0') !== userId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'PaymentIntent does not belong to this user' }) };
        }

        // plans.organisation_id is NOT NULL and every lookup below is keyed on it, so an
        // unstamped PI must be rejected rather than parsed into NaN.
        if (!organisationId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'PaymentIntent is missing organisation metadata' }) };
        }

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };

        const orgIdInt = parseInt(organisationId);
        const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;
        const amountGbp = pi.amount ? (pi.amount / 100).toFixed(2) : '0.00';

        // 4. Look up plan name
        let planName = tier ? `Be More Swan (${tier})` : 'Be More Swan Subscription';
        if (masterPlanIdInt) {
            const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
            if (mp) planName = mp.name;
        }

        // 5. Create plan record.
        // The Stripe subscription is created up-front by create-subscription.ts (default_incomplete
        // pattern) and this PaymentIntent is its first invoice payment — so we never create a
        // subscription here (that double-charged). We just persist the existing subscription's
        // references, read from the PI metadata. The webhook normally creates this record first;
        // this is the safety net for when the user lands before the webhook fires.
        //
        // Whichever of the two writers arrives second must BACKFILL rather than walk away: this
        // function and stripe-webhook.ts genuinely race, and previously either one finding a row
        // already present returned alreadyExists without ever looking at what that row contained.
        // That made an active plan with NULL Stripe ids permanently unhealable — and every admin
        // action in admin-billing-override.ts is gated on both ids being present.
        //
        // The lookup is scoped to the ORGANISATION because that is what
        // plans_one_active_per_org_unique keys on and what the insert below would collide with.
        // Scoping it to the user instead (as this did) both missed the row the insert would
        // actually hit and skipped provisioning for a user who happened to hold an active plan
        // in some other organisation.
        const [existingPlan] = await db
            .select()
            .from(plans)
            .where(and(
                eq(plans.organisationId, orgIdInt),
                inArray(plans.status, ['active', 'past_due']),
            ))
            .limit(1);

        if (existingPlan) {
            await backfillPlanRefs(existingPlan, { stripeCustomerId, stripeSubscriptionId, masterPlanIdInt });
            return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: true }) };
        }

        let newPlan: typeof plans.$inferSelect;
        try {
            const [inserted] = await db.insert(plans).values({
                userId,
                organisationId: orgIdInt,
                masterPlanId: masterPlanIdInt,
                planName,
                planType: 'subscription',
                status: 'active',
                stripeCustomerId: stripeCustomerId || null,
                stripeSubscriptionId: stripeSubscriptionId || null,
            }).returning();
            newPlan = inserted;
        } catch (planErr: any) {
            // Webhook won the race between the SELECT above and this INSERT. Re-read the row it
            // created and fill in anything it could not supply.
            if (planErr?.code === '23505' || planErr?.message?.includes('plans_one_active_per_org_unique')) {
                const [racedPlan] = await db
                    .select()
                    .from(plans)
                    .where(and(
                        eq(plans.organisationId, orgIdInt),
                        inArray(plans.status, ['active', 'past_due']),
                    ))
                    .limit(1);
                if (racedPlan) {
                    await backfillPlanRefs(racedPlan, { stripeCustomerId, stripeSubscriptionId, masterPlanIdInt });
                }
                return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: true }) };
            }
            throw planErr;
        }

        // 7. Create payment record
        await db.insert(payments).values({
            userId,
            organisationId: orgIdInt,
            planId: newPlan.id,
            masterPlanId: masterPlanIdInt,
            amount: amountGbp,
            currency: 'GBP',
            status: 'completed',
            externalPaymentId: pi.id,
            description: `${planName} — first payment`,
        });

        // 8. Notify user
        await createNotification(db, 'payment_successful_setup', { userId, isRead: false });

        // Clear any lingering "fix your billing" action items now the subscription is active.
        await resolveActionNotifications(db, userId, PAYMENT_RESTORED_TYPES);

        return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: false }) };

    } catch (err: any) {
        console.error('confirm-payment error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Server error' }) };
    }
});
