// netlify/functions/billing-downgrade.ts
// US-GAP-1.2.1: Downgrade Plan with Impact Warning
//
//  GET ?targetTierKey=<tier>  → impact preview: which assistants will pause, limit diff (SC2/SC3)
//  POST { targetTierKey }      → schedule downgrade at period end (SC4)
//  DELETE                      → cancel a scheduled downgrade (SC6)

import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, masterPlans, aiAssistants, userOrganisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { checkImpersonationBlock } from '../../src/utils/impersonation-guard';
import { resolveMonthlyPriceId } from '../../src/utils/stripe-price';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret    = process.env.JWT_SECRET!;
const stripeSecret = process.env.STRIPE_SECRET_KEY!;
const stripe       = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

function parseSession(event: any): number | null {
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number };
        return decoded.userId;
    } catch { return null; }
}

export default withLambda(async (event) => {
    if (!['GET', 'POST', 'DELETE'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    // US-ADM-1.2.1: Block Stripe billing changes during impersonation
    if (event.httpMethod !== 'GET') {
        const block = checkImpersonationBlock(event);
        if (block) return block;
    }

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    const [user] = await db
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, userId))
        .limit(1);
    if (!user?.organisationId) return { statusCode: 404, body: JSON.stringify({ error: 'No organisation found.' }) };

    const [currentPlan] = await db
        .select({
            id: plans.id,
            masterPlanId: plans.masterPlanId,
            stripeSubscriptionId: plans.stripeSubscriptionId,
            status: plans.status,
        })
        .from(plans)
        .where(and(
            eq(plans.organisationId, user.organisationId),
            eq(plans.status, 'active'),
        ))
        .limit(1);

    // Also check for 'downgrading' status for SC6
    const [downgradinPlan] = await db
        .select({ id: plans.id, masterPlanId: plans.masterPlanId, stripeSubscriptionId: plans.stripeSubscriptionId })
        .from(plans)
        .where(and(eq(plans.organisationId, user.organisationId), eq(plans.status, 'downgrading')))
        .limit(1);

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE: SC6 — cancel a scheduled downgrade
    // ─────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
        const planToCancel = downgradinPlan || currentPlan;
        if (!planToCancel?.stripeSubscriptionId) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No scheduled downgrade found.' }) };
        }

        try {
            const sub = await stripe.subscriptions.retrieve(planToCancel.stripeSubscriptionId);

            // New-style scheduled downgrades attach a Stripe subscription schedule (see POST).
            // Releasing it leaves the subscription running unchanged at its current price.
            if (typeof sub.schedule === 'string') {
                await stripe.subscriptionSchedules.release(sub.schedule)
                    .catch(err => console.warn('[billing-downgrade] schedule release failed (non-blocking):', err?.message));
            }

            // Clear the pending-downgrade markers, and undo any legacy cancel_at_period_end
            // downgrade that predates the schedule-based flow.
            const cleanedMetadata = { ...(sub.metadata || {}) };
            delete cleanedMetadata.pendingDowngradeTierKey;
            delete cleanedMetadata.pendingDowngradeMasterPlanId;
            await stripe.subscriptions.update(planToCancel.stripeSubscriptionId, {
                cancel_at_period_end: false,
                metadata: cleanedMetadata,
            });

            // Restore plan status to active
            await db.update(plans)
                .set({ status: 'active', updatedAt: new Date() })
                .where(eq(plans.id, planToCancel.id));

            await createNotification(db, 'downgrade_cancelled', { userId, isRead: false });

            return { statusCode: 200, body: JSON.stringify({ success: true, action: 'downgrade_cancelled' }) };
        } catch (err: any) {
            return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
        }
    }

    const activePlan = currentPlan || downgradinPlan;
    if (!activePlan) return { statusCode: 404, body: JSON.stringify({ error: 'No active plan found.' }) };

    const [currentMp] = activePlan.masterPlanId
        ? await db.select().from(masterPlans).where(eq(masterPlans.id, activePlan.masterPlanId)).limit(1)
        : [null];

    const targetTierKey = (
        event.queryStringParameters?.targetTierKey ||
        JSON.parse(event.body || '{}').targetTierKey ||
        ''
    ).toLowerCase();

    if (!targetTierKey) return { statusCode: 400, body: JSON.stringify({ error: 'targetTierKey is required.' }) };

    const [targetMp] = await db
        .select()
        .from(masterPlans)
        .where(and(eq(masterPlans.tierKey, targetTierKey), eq(masterPlans.isActive, true)))
        .limit(1);

    if (!targetMp) return { statusCode: 404, body: JSON.stringify({ error: `Plan '${targetTierKey}' not found.` }) };

    const currentPrice = currentMp ? parseFloat(String(currentMp.monthlyPriceGbp)) : 0;
    const targetPrice  = parseFloat(String(targetMp.monthlyPriceGbp));

    if (targetPrice >= currentPrice) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Target tier must be lower than current tier. For upgrades use billing-upgrade.' }) };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET: SC2/SC3 — impact preview
    // ─────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        // SC2: which assistants will be paused?
        const activeAssistants = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)))
            .orderBy(desc(aiAssistants.createdAt)); // newest first

        const newAssistantLimit = targetMp.assistantLimit;
        const assistantsToPause = newAssistantLimit !== null && newAssistantLimit !== undefined
            ? activeAssistants.slice(newAssistantLimit) // oldest will be paused
            : [];

        // Get next billing period end from Stripe if available
        let periodEnd: string | null = null;
        if (activePlan.stripeSubscriptionId) {
            try {
                const sub = await stripe.subscriptions.retrieve(activePlan.stripeSubscriptionId);
                periodEnd = new Date((sub.items.data[0]?.current_period_end ?? 0) * 1000).toISOString();
            } catch { /* non-critical */ }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                impact: {
                    targetTierKey,
                    targetPlanName: targetMp.name,
                    targetMonthlyPrice: targetMp.monthlyPriceGbp,
                    // SC2: assistants that will be paused at period end
                    assistantsToPause: assistantsToPause.map(a => ({ id: a.id, name: a.name })),
                    currentAssistantLimit: currentMp?.assistantLimit ?? null,
                    newAssistantLimit: targetMp.assistantLimit ?? null,
                    // SC3: task limit comparison
                    currentTaskLimit: currentMp?.monthlyTaskLimit ?? null,
                    newTaskLimit: targetMp.monthlyTaskLimit ?? null,
                    // Timing
                    effectiveDate: periodEnd,
                    note: 'Your current plan remains active until the end of your billing period. No immediate charge or refund.',
                },
            }),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST: SC4 — schedule the downgrade at period end
    // ─────────────────────────────────────────────────────────────────────────
    if (!activePlan.stripeSubscriptionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No Stripe subscription on record. Please contact support.' }) };
    }

    // Resolve the target tier's stable monthly price (single source — tracks the Plans tab), then
    // switch to it at period end using a Stripe subscription SCHEDULE. Unlike cancel_at_period_end,
    // a schedule keeps the subscription alive and renews it at the lower price for the next period,
    // so the customer is downgraded — not cancelled. The webhook (customer.subscription.updated)
    // finalises the DB switch when the new phase enters.
    const targetPriceId = await resolveMonthlyPriceId(stripe, targetMp);

    try {
        const sub = await stripe.subscriptions.retrieve(activePlan.stripeSubscriptionId, { expand: ['items'] });
        const currentItem = sub.items.data[0];
        if (!currentItem) throw new Error('No subscription item found');
        const currentPeriodEndUnix = currentItem.current_period_end ?? 0;

        // A subscription owns at most one schedule; release any stale one (e.g. from a prior,
        // still-pending downgrade) so we can build a clean two-phase schedule below.
        if (typeof sub.schedule === 'string') {
            await stripe.subscriptionSchedules.release(sub.schedule).catch(() => { /* already released */ });
        }

        // SC4: build the schedule from the live subscription, then append the target-tier phase.
        //  • Phase 0 = current price, unchanged, until period end.
        //  • Phase 1 = target price from renewal onward. Its metadata (masterPlanId/tier) is copied
        //    onto the subscription when the phase activates — that is what the webhook reads to
        //    complete the tier switch in our DB.
        const schedule = await stripe.subscriptionSchedules.create({ from_subscription: activePlan.stripeSubscriptionId });
        const phase0 = schedule.phases[0];
        await stripe.subscriptionSchedules.update(schedule.id, {
            end_behavior: 'release',
            phases: [
                {
                    items: phase0.items.map(i => ({
                        price: typeof i.price === 'string' ? i.price : i.price.id,
                        quantity: i.quantity ?? 1,
                    })),
                    start_date: phase0.start_date,
                    end_date: phase0.end_date,
                },
                {
                    items: [{ price: targetPriceId, quantity: 1 }],
                    proration_behavior: 'none',
                    metadata: { masterPlanId: String(targetMp.id), tier: targetTierKey },
                },
            ],
            metadata: {
                pendingDowngradeTierKey: targetTierKey,
                pendingDowngradeMasterPlanId: String(targetMp.id),
            },
        });

        // SC4c: set DB status to 'downgrading' (the webhook flips it back to 'active' at renewal)
        await db.update(plans)
            .set({ status: 'downgrading', updatedAt: new Date() })
            .where(eq(plans.id, activePlan.id));

        // Notify user
        const periodEnd = new Date(currentPeriodEndUnix * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        await createNotification(db, 'downgrade_scheduled', {
            userId,
            context: { plan: { name: targetMp.name }, billing: { period_end: periodEnd } },
            isRead: false,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                action: 'downgrade_scheduled',
                effectivePlanName: targetMp.name,
                periodEnd: new Date(currentPeriodEndUnix * 1000).toISOString(),
            }),
        };
    } catch (err: any) {
        console.error('[billing-downgrade] Stripe error:', err);
        return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
    }
});
