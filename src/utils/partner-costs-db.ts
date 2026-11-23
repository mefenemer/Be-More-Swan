// src/utils/partner-costs-db.ts
// The database side of partner commission after ACTUAL costs (docs/partner-actual-costs-plan.md; rule in partner-costs.ts):
//
//   saveTodaysFxRate      the ECB's daily USD→GBP rate into fx_rates (nightly; the sweep calls it first)
//   customerCostUsd       what one customer's workspaces cost us in a period (ai_usage_log.cost_usd: AI model usage and
//                         the media / voice / bot / email providers that log there)
//   trueUpCommissions     each provisional commission row whose month has ended: apply the rule with that month's costs
//                         and the customer's carried shortfall, adjust the row, carry the shortfall on. Rows are only
//                         ever PENDING here — nothing paid or in a run is changed. Then releaseDueCommissions may release them.
//
// Ordered per customer by month, so the carried shortfall flows month to month. A row whose rate for the day isn't
// known yet waits for the next night.

import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { fxRates, partnerCommissions, partnerReferrals } from '../../db/schema';
import { applyCostRule, fetchEcbUsdGbp, usdToPence } from './partner-costs';

type Db = ReturnType<typeof getDb>;

export async function saveTodaysFxRate(db: Db, fetchFn: typeof fetch = fetch): Promise<{ day: string; usdGbp: number } | null> {
    try {
        const r = await fetchEcbUsdGbp(fetchFn);
        if (!r) return null;
        await db.insert(fxRates).values({ day: r.day, usdGbp: String(r.usdGbp), source: 'ECB' })
            .onConflictDoUpdate({ target: fxRates.day, set: { usdGbp: String(r.usdGbp), fetchedAt: new Date() } });
        return r;
    } catch (err) {
        console.error('[partner-costs] ECB rate fetch failed (rows wait for the next night):', err);
        return null;
    }
}

/** The latest saved pounds-per-dollar rate on or before `at` (the ECB publishes working days only). */
export async function usdGbpOn(db: Db, at: Date): Promise<number | null> {
    const day = at.toISOString().slice(0, 10);
    const [row] = await db.select({ usdGbp: fxRates.usdGbp }).from(fxRates).where(lte(fxRates.day, day)).orderBy(desc(fxRates.day)).limit(1);
    const n = Number(row?.usdGbp);
    return n > 0 ? n : null;
}

/** USD logged against the workspaces this person owns, created in [from, to). */
export async function customerCostUsd(db: Db, userId: number, from: Date, to: Date): Promise<number> {
    const [r] = (await db.execute(sql`
        SELECT COALESCE(SUM(l.cost_usd), 0)::float AS usd
          FROM ai_usage_log l
         WHERE l.created_at >= ${from.toISOString()}::timestamp AND l.created_at < ${to.toISOString()}::timestamp
           AND l.workspace_id IN (SELECT organisation_id FROM user_organisations WHERE user_id = ${userId} AND role = 'owner')`)) as unknown as Array<{ usd: number }>;
    return Number(r?.usd) || 0;
}

export async function trueUpCommissions(db: Db, now: Date = new Date()): Promise<{ checked: number; waiting: number }> {
    const due = await db.select({
        row: partnerCommissions, carry: partnerReferrals.costCarryPence,
        userId: sql<number>`(SELECT referred_user_id FROM user_referrals WHERE id = ${partnerReferrals.referralId})`,
    }).from(partnerCommissions)
        .innerJoin(partnerReferrals, eq(partnerReferrals.id, partnerCommissions.partnerReferralId))
        .where(and(
            eq(partnerCommissions.kind, 'invoice'), eq(partnerCommissions.status, 'pending'),
            isNull(partnerCommissions.costsCheckedAt), lte(partnerCommissions.servicePeriodEnd, now),
        ))
        .orderBy(asc(partnerCommissions.partnerReferralId), asc(partnerCommissions.servicePeriodStart), asc(partnerCommissions.id));

    let checked = 0, waiting = 0;
    const blocked = new Set<number>();   // a customer whose earlier month is waiting: later months wait too (carry order)
    for (const { row, userId } of due) {
        const refId = row.partnerReferralId!;
        if (blocked.has(refId)) { waiting++; continue; }
        const rate = await usdGbpOn(db, row.servicePeriodEnd!);
        if (!rate || !userId) { blocked.add(refId); waiting++; continue; }
        const usd = await customerCostUsd(db, Number(userId), row.servicePeriodStart!, row.servicePeriodEnd!);
        const costPence = usdToPence(usd, rate);
        await db.transaction(async (tx) => {
            // Re-read the carry inside the transaction: it is what earlier months of this customer left.
            const [ref] = await tx.select({ carry: partnerReferrals.costCarryPence }).from(partnerReferrals).where(eq(partnerReferrals.id, refId)).limit(1);
            const carryIn = Math.max(0, ref?.carry ?? 0);
            const r = applyCostRule({
                paymentPence: row.netAmountPence ?? 0, minDeductionBps: row.costDeductionBps, costPence,
                cardFeePence: row.cardFeePence ?? 0, carryInPence: carryIn, rateBps: row.rateBps ?? 0,
            });
            // A refund that already lowered this row while it waited stays applied: take the lower of the two.
            const commission = row.note?.startsWith('Adjusted:') ? Math.min(row.commissionPence, r.commissionPence) : r.commissionPence;
            const updated = await tx.update(partnerCommissions).set({
                commissionPence: commission, costPence, deductionPence: r.deductionPence, deductionBasis: r.basis,
                carryInPence: carryIn, carryOutPence: r.carryOutPence, usdGbpRate: String(rate), costsCheckedAt: now,
            }).where(and(eq(partnerCommissions.id, row.id), eq(partnerCommissions.status, 'pending'), isNull(partnerCommissions.costsCheckedAt)))
                .returning({ id: partnerCommissions.id });
            if (updated.length) await tx.update(partnerReferrals).set({ costCarryPence: r.carryOutPence }).where(eq(partnerReferrals.id, refId));
        });
        checked++;
    }
    return { checked, waiting };
}
