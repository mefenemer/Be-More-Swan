// netlify/functions/activate-scheduled-prices.ts
// Single-source price management — activate scheduled subscription price changes.
//
// Runs on a schedule (netlify.toml, every 15 min). Finds plan_price_history rows whose
// effective_from has passed while still 'scheduled', and promotes each to the live price via
// the shared applyPlanPrice() helper (mints the new Stripe price, archives the old, updates
// master_plans + the GBP plan_prices row). Idempotent + self-healing: a Stripe failure reverts
// the claim back to 'scheduled' so the next tick retries. Netlify only runs scheduled functions
// on the production deploy.

import { and, eq, lte } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '../../db/client';
import { masterPlans, planPriceHistory } from '../../db/schema';
import { applyPlanPrice } from '../../src/utils/plan-pricing';
import { withLambda } from '@netlify/aws-lambda-compat';

const BATCH = 50;
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

export default withLambda(async () => {
    const db = getDb();
    const now = new Date();
    let activated = 0, failed = 0;

    const due = await db
        .select({ id: planPriceHistory.id, masterPlanId: planPriceHistory.masterPlanId, currency: planPriceHistory.currency, price: planPriceHistory.monthlyPriceMajorUnit })
        .from(planPriceHistory)
        .where(and(eq(planPriceHistory.status, 'scheduled'), lte(planPriceHistory.effectiveFrom, now)))
        .limit(BATCH);

    for (const row of due) {
        // Status-guarded claim so overlapping ticks can't double-activate the same change.
        const [claimed] = await db
            .update(planPriceHistory)
            .set({ status: 'active', effectiveTo: null })
            .where(and(eq(planPriceHistory.id, row.id), eq(planPriceHistory.status, 'scheduled')))
            .returning();
        if (!claimed) continue; // another tick claimed it first

        const [plan] = await db.select().from(masterPlans).where(eq(masterPlans.id, row.masterPlanId)).limit(1);
        if (!plan) {
            await db.update(planPriceHistory).set({ status: 'superseded', effectiveTo: now }).where(eq(planPriceHistory.id, row.id));
            failed++;
            continue;
        }

        try {
            await applyPlanPrice(db, stripe, {
                plan: { id: plan.id, stripeProductId: plan.stripeProductId },
                currency: row.currency, newPriceGbp: row.price, historyRowId: row.id,
            });
            activated++;
        } catch (err) {
            console.error(`[activate-scheduled-prices] plan ${row.masterPlanId} price ${row.id} failed:`, err);
            // Revert the claim so the next tick retries (applyPlanPrice does Stripe first, so no
            // partial DB write happened).
            await db.update(planPriceHistory).set({ status: 'scheduled', effectiveTo: null }).where(eq(planPriceHistory.id, row.id)).catch(() => {});
            failed++;
        }
    }

    return { statusCode: 200, body: JSON.stringify({ due: due.length, activated, failed }) };
});
