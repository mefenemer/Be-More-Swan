// netlify/functions/reconcile-billing.ts
//
// US-ADM-2.3.1: Stripe↔DB Nightly Reconciliation Job
//
// Runs nightly at 02:00 UTC.
// Checks all active Stripe subscriptions against the platform DB plans.
// Flags:
//   (a) DB plan active where Stripe subscription does not exist or is not active
//   (b) Stripe subscription price_id does not match the expected tier in the DB
//
// Results are written to billing_reconciliation_log.
// Mismatches trigger a superadmin in-app notification.

import type { Handler } from '@netlify/functions';
import { eq, and, inArray, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '../../db/client';
import {
    plans, organisations, masterPlans, users,
    billingReconciliationLog, usageCounters, taskRuns,
} from '../../db/schema';
import { createNotifications } from '../../src/utils/notify';
import { getPeriodStart } from '../../src/utils/atomic-cap-check';
import { withLambda } from '@netlify/aws-lambda-compat';

// A Stripe subscription's tier is resolved from its price PRODUCT (master_plans.stripe_product_id),
// built at request time below — not a hardcoded price-id map. The product is stable across price
// changes, so this covers legacy prices, the current live prices, and any new lookup_key-minted
// prices alike (all sit on the same per-plan product).

export interface ReconciliationMismatch {
    type: 'missing_stripe_sub' | 'tier_mismatch' | 'stripe_cancelled_but_db_active';
    workspaceId: number | null;
    workspaceName: string | null;
    dbPlanId: number;
    dbTierKey: string | null;
    stripeSubscriptionId: string | null;
    stripePriceId: string | null;
    stripeTierKey: string | null;
    stripeStatus: string | null;
    lastWebhookDate: string | null;
}

// US-DB-1.4.1: usage counter drift has a different shape from plan mismatches,
// but is recorded in the same reconciliation results array.
export interface UsageCounterDriftMismatch {
    type: 'usage_counter_drift';
    organisationId: number | null;
    counterValue: number;
    liveValue: number;
    delta: number;
    driftPct: number;
    period: string;
}

async function runReconciliation(): Promise<void> {
    const db = getDb();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-05-27.dahlia' });

    let totalChecked = 0;
    const mismatches: (ReconciliationMismatch | UsageCounterDriftMismatch)[] = [];
    let runStatus: 'success' | 'failed' = 'success';
    let errorMessage: string | null = null;

    try {
        // ── 1. Load all active DB plans that have a Stripe subscription ──────────
        const dbActivePlans = await db
            .select({
                planId: plans.id,
                stripeSubscriptionId: plans.stripeSubscriptionId,
                stripeCustomerId: plans.stripeCustomerId,
                organisationId: plans.organisationId,
                masterPlanId: plans.masterPlanId,
                updatedAt: plans.updatedAt,
            })
            .from(plans)
            .where(eq(plans.status, 'active'));

        totalChecked = dbActivePlans.length;

        // Load org names and master plan tiers before building the mismatch map
        const orgIds = [...new Set(dbActivePlans.map(p => p.organisationId).filter(Boolean))] as number[];
        const orgRows = orgIds.length
            ? await db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, orgIds))
            : [];
        const orgNameMap = new Map(orgRows.map(o => [o.id, o.name]));

        const masterPlanIds = [...new Set(dbActivePlans.map(p => p.masterPlanId).filter(Boolean))] as number[];
        const masterPlanRows = masterPlanIds.length
            ? await db.select({ id: masterPlans.id, tierKey: masterPlans.tierKey }).from(masterPlans).where(inArray(masterPlans.id, masterPlanIds))
            : [];
        const masterPlanTierMap = new Map(masterPlanRows.map(mp => [mp.id, mp.tierKey]));

        // Stripe price PRODUCT → tier, from master_plans.stripe_product_id (the single, stable link).
        const productPlanRows = await db
            .select({ tierKey: masterPlans.tierKey, stripeProductId: masterPlans.stripeProductId })
            .from(masterPlans);
        const productToTier = new Map(
            productPlanRows
                .filter(p => p.stripeProductId)
                .map(p => [p.stripeProductId as string, p.tierKey]),
        );
        const tierFromSub = (sub: { items: { data: Array<{ price?: { product?: string | { id: string } } }> } }): string | null => {
            const prod = sub.items.data[0]?.price?.product;
            const productId = typeof prod === 'string' ? prod : prod?.id ?? null;
            return productId ? (productToTier.get(productId) || null) : null;
        };

        // Map subscriptionId → DB plan for fast lookup
        const subIdToDbPlan = new Map<string, typeof dbActivePlans[0]>();
        for (const p of dbActivePlans) {
            if (p.stripeSubscriptionId) {
                subIdToDbPlan.set(p.stripeSubscriptionId, p);
            } else {
                // Fix (US-ADM-2.3.1): Active DB plan with no stripeSubscriptionId —
                // flag as missing_stripe_sub so admins can investigate.
                const dbTierKey = p.masterPlanId ? (masterPlanTierMap.get(p.masterPlanId) || null) : null;
                mismatches.push({
                    type: 'missing_stripe_sub',
                    workspaceId:          p.organisationId,
                    workspaceName:        p.organisationId ? (orgNameMap.get(p.organisationId) || null) : null,
                    dbPlanId:             p.planId,
                    dbTierKey,
                    stripeSubscriptionId: null,
                    stripePriceId:        null,
                    stripeTierKey:        null,
                    stripeStatus:         'no_subscription_id',
                    lastWebhookDate:      p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
                });
            }
        }

        // ── 2. Paginate all active Stripe subscriptions ───────────────────────────
        const stripeSubIds = new Set<string>();
        for await (const stripeSub of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
            stripeSubIds.add(stripeSub.id);
            const priceId = stripeSub.items.data[0]?.price?.id ?? null;
            const stripeTierKey = tierFromSub(stripeSub);

            const dbPlan = subIdToDbPlan.get(stripeSub.id);
            if (!dbPlan) {
                // Stripe has an active subscription that isn't in our DB — this could be
                // a brand-new subscription not yet processed; not flagged as a critical mismatch
                // but logged as informational. Skip to avoid noise.
                continue;
            }

            const dbTierKey = dbPlan.masterPlanId ? (masterPlanTierMap.get(dbPlan.masterPlanId) || null) : null;

            // (b) Tier mismatch: Stripe price doesn't match DB tier
            if (stripeTierKey && dbTierKey && stripeTierKey !== dbTierKey) {
                mismatches.push({
                    type: 'tier_mismatch',
                    workspaceId:          dbPlan.organisationId,
                    workspaceName:        dbPlan.organisationId ? (orgNameMap.get(dbPlan.organisationId) || null) : null,
                    dbPlanId:             dbPlan.planId,
                    dbTierKey,
                    stripeSubscriptionId: stripeSub.id,
                    stripePriceId:        priceId,
                    stripeTierKey,
                    stripeStatus:         stripeSub.status,
                    lastWebhookDate:      new Date((stripeSub.items.data[0]?.current_period_start ?? stripeSub.created) * 1000).toISOString(),
                });
            }
        }

        // ── 3. Check DB plans whose Stripe sub is cancelled/missing ──────────────
        for await (const stripeSub of stripe.subscriptions.list({ status: 'canceled', limit: 100 })) {
            if (!subIdToDbPlan.has(stripeSub.id)) continue;
            const dbPlan = subIdToDbPlan.get(stripeSub.id)!;
            const dbTierKey = dbPlan.masterPlanId ? (masterPlanTierMap.get(dbPlan.masterPlanId) || null) : null;
            const priceId = stripeSub.items.data[0]?.price?.id ?? null;
            mismatches.push({
                type: 'stripe_cancelled_but_db_active',
                workspaceId:          dbPlan.organisationId,
                workspaceName:        dbPlan.organisationId ? (orgNameMap.get(dbPlan.organisationId) || null) : null,
                dbPlanId:             dbPlan.planId,
                dbTierKey,
                stripeSubscriptionId: stripeSub.id,
                stripePriceId:        priceId,
                stripeTierKey:        tierFromSub(stripeSub),
                stripeStatus:         stripeSub.status,
                lastWebhookDate:      new Date(stripeSub.canceled_at! * 1000).toISOString(),
            });
        }

        // ── 3b. Flag DB plans whose stripeSubscriptionId was not found in Stripe's
        //        active OR cancelled lists — e.g. past_due, incomplete, deleted ────
        for (const [subId, dbPlan] of subIdToDbPlan) {
            if (!stripeSubIds.has(subId)) {
                const dbTierKey = dbPlan.masterPlanId ? (masterPlanTierMap.get(dbPlan.masterPlanId) || null) : null;
                mismatches.push({
                    type: 'missing_stripe_sub',
                    workspaceId:          dbPlan.organisationId,
                    workspaceName:        dbPlan.organisationId ? (orgNameMap.get(dbPlan.organisationId) || null) : null,
                    dbPlanId:             dbPlan.planId,
                    dbTierKey,
                    stripeSubscriptionId: subId,
                    stripePriceId:        null,
                    stripeTierKey:        null,
                    stripeStatus:         'not_found_in_stripe',
                    lastWebhookDate:      dbPlan.updatedAt ? new Date(dbPlan.updatedAt).toISOString() : null,
                });
            }
        }

        // ── 4a. US-DB-1.4.1: Cross-check usageCounters.taskCount vs live task_runs count ──
        const periodStart  = getPeriodStart();
        const ucRows = await db
            .select({ organisationId: usageCounters.organisationId, taskCount: usageCounters.taskCount })
            .from(usageCounters)
            .where(eq(usageCounters.periodStart, periodStart));

        // See the warning in src/utils/atomic-cap-check.ts: a raw Date interpolated into a
        // db.execute(sql`...`) template throws inside postgres-js's Bind step before the statement
        // is ever sent, and drizzle rethrows it looking like a database fault. The query builder
        // above is safe because the column maps the value; this hand-written template is not.
        const periodStartParam = periodStart.toISOString();
        for (const uc of ucRows) {
            const [live] = await db.execute(sql`
                SELECT COUNT(*) AS live_count
                FROM task_runs
                WHERE organisation_id = ${uc.organisationId}
                  AND created_at >= ${periodStartParam}
            `);
            const liveCount = Number((live as any).live_count ?? 0);
            const counterCount = uc.taskCount ?? 0;
            const drift = Math.abs(liveCount - counterCount);
            const driftPct = liveCount > 0 ? drift / liveCount : 0;

            if (driftPct > 0.01) {
                // >1% drift — flag it
                mismatches.push({
                    type:           'usage_counter_drift',
                    organisationId: uc.organisationId,
                    counterValue:   counterCount,
                    liveValue:      liveCount,
                    delta:          counterCount - liveCount,
                    driftPct:       Math.round(driftPct * 10000) / 100,
                    period:         periodStart.toISOString(),
                });
                console.warn(`[reconcile-billing] Usage counter drift >1% for org ${uc.organisationId}: counter=${counterCount}, live=${liveCount}`);
            }
        }

        // ── 4. Write reconciliation log ────────────────────────────────────────────
        await db.insert(billingReconciliationLog).values({
            totalChecked,
            mismatchCount: mismatches.length,
            results: mismatches as any,
            status: 'success',
        });

        // ── 5. Notify superadmins if mismatches found ──────────────────────────────
        if (mismatches.length > 0) {
            const superAdmins = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.role, 'super_admin'));

            const mismatchPhrase = `${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}`;
            await createNotifications(db, 'billing_reconciliation_mismatch', superAdmins.map(a => a.id), {
                context: { reconciliation: { mismatch_phrase: mismatchPhrase } },
                metadata: { mismatchCount: mismatches.length, runAt: new Date().toISOString() },
            });

            console.warn(`[reconcile-billing] ⚠️ ${mismatches.length} mismatch(es) found and flagged.`);
        } else {
            console.log(`[reconcile-billing] ✅ ${totalChecked} plans checked — no mismatches.`);
        }

    } catch (err: any) {
        runStatus = 'failed';
        errorMessage = String(err?.message || err);
        console.error('[reconcile-billing] Fatal error:', err);

        // Still write a failed-run record
        try {
            const db2 = getDb();
            await db2.insert(billingReconciliationLog).values({
                totalChecked,
                mismatchCount: mismatches.length,
                results: mismatches as any,
                status: 'failed',
                errorMessage,
            });

            // Alert superadmins about the failure
            const superAdmins = await db2
                .select({ id: users.id })
                .from(users)
                .where(eq(users.role, 'super_admin'));

            await createNotifications(db2, 'billing_reconciliation_failed', superAdmins.map(a => a.id), {
                context: { job: { error: errorMessage } },
                metadata: { error: errorMessage, runAt: new Date().toISOString() },
            });
        } catch (innerErr) {
            console.error('[reconcile-billing] Also failed to write failure log:', innerErr);
        }
    }
}

export default withLambda(async () => {
    await runReconciliation();
    return { statusCode: 200 };
});
