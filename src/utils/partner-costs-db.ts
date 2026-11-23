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
import { addMonthsUtc, commissionPence } from './partner-rate-periods';

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

/** Where this customer's costs have already been counted up to: the latest end of their other checked months, if later than `start`. */
export async function costsCountedUntil(db: Db, referralId: number, rowId: number, start: Date): Promise<Date> {
    const [r] = (await db.execute(sql`
        SELECT MAX(service_period_end) AS until FROM partner_commissions
         WHERE partner_referral_id = ${referralId} AND kind = 'invoice' AND id <> ${rowId} AND costs_checked_at IS NOT NULL`)) as unknown as Array<{ until: Date | string | null }>;
    const until = r?.until ? new Date(r.until) : null;
    return until && until.getTime() > start.getTime() ? until : start;
}

export async function trueUpCommissions(db: Db, now: Date = new Date()): Promise<{ checked: number; waiting: number }> {
    // LEFT join: a customer who deleted their account takes their user_referrals / partner_referrals rows with them
    // (partner_referral_id → NULL). Those months are still checked — at the minimum, no costs, no carry — so they are
    // never stuck pending (review of #827).
    const due = await db.select({
        row: partnerCommissions,
        refExists: sql<boolean>`${partnerReferrals.id} IS NOT NULL`,
        subscribedAt: partnerReferrals.subscribedAt, durationMonths: partnerReferrals.durationMonths,
        userId: sql<number | null>`(SELECT referred_user_id FROM user_referrals WHERE id = ${partnerReferrals.referralId})`,
    }).from(partnerCommissions)
        .leftJoin(partnerReferrals, eq(partnerReferrals.id, partnerCommissions.partnerReferralId))
        .where(and(
            eq(partnerCommissions.kind, 'invoice'), eq(partnerCommissions.status, 'pending'),
            isNull(partnerCommissions.costsCheckedAt), lte(partnerCommissions.servicePeriodEnd, now),
        ))
        .orderBy(asc(partnerCommissions.partnerReferralId), asc(partnerCommissions.servicePeriodStart), asc(partnerCommissions.id));

    let checked = 0, waiting = 0;
    const blocked = new Set<number>();   // a customer whose earlier month is waiting: later months wait too (carry order)
    for (const { row, refExists, subscribedAt, durationMonths, userId } of due) {
        const refId = row.partnerReferralId;
        const orphan = !refId || !refExists || !userId;
        if (refId && blocked.has(refId)) { waiting++; continue; }
        let rate: number | null = null;
        let costPence = 0;
        if (!orphan) {
            rate = await usdGbpOn(db, row.servicePeriodEnd!);
            if (!rate) { blocked.add(refId!); waiting++; continue; }
            // Never count the same days twice (overlapping months after a plan change), and never past the end of the
            // customer's commission period — the last month earns pro rata, so only its days inside count (review of #827).
            const countFrom = await costsCountedUntil(db, refId!, row.id, row.servicePeriodStart!);
            const windowEnd = subscribedAt && durationMonths != null ? addMonthsUtc(new Date(subscribedAt), durationMonths) : null;
            const countTo = windowEnd && windowEnd.getTime() < row.servicePeriodEnd!.getTime() ? windowEnd : row.servicePeriodEnd!;
            const usd = countFrom.getTime() < countTo.getTime() ? await customerCostUsd(db, Number(userId), countFrom, countTo) : 0;
            costPence = usdToPence(usd, rate);
        }
        await db.transaction(async (tx) => {
            // Re-read the carry inside the transaction: it is what earlier months of this customer left.
            const carryIn = orphan ? 0 : Math.max(0, (await tx.select({ carry: partnerReferrals.costCarryPence }).from(partnerReferrals)
                .where(eq(partnerReferrals.id, refId!)).limit(1))[0]?.carry ?? 0);
            // A row lowered since it was recorded (a partial refund, a dispute won after one) is worked out on what is
            // left of the payment, in proportion — so costs come off the remaining payment, not the full one (review of #827).
            const net = row.netAmountPence ?? 0;
            const provisional = commissionPence(net, row.rateBps ?? 0, row.costDeductionBps);
            const payment = provisional > 0 && row.commissionPence < provisional ? Math.floor((net * row.commissionPence) / provisional) : net;
            const r = applyCostRule({
                paymentPence: payment, minDeductionBps: row.costDeductionBps, costPence,
                cardFeePence: orphan ? 0 : row.cardFeePence ?? 0, carryInPence: carryIn, rateBps: row.rateBps ?? 0,
            });
            // Never raise a row: it was recorded at the minimum deduction, the most the rule can give.
            const commission = Math.min(row.commissionPence, r.commissionPence);
            const updated = await tx.update(partnerCommissions).set({
                commissionPence: commission, costPence, deductionPence: r.deductionPence, deductionBasis: r.basis,
                carryInPence: carryIn, carryOutPence: orphan ? 0 : r.carryOutPence, usdGbpRate: rate ? String(rate) : null, costsCheckedAt: now,
            }).where(and(eq(partnerCommissions.id, row.id), eq(partnerCommissions.status, 'pending'), isNull(partnerCommissions.costsCheckedAt)))
                .returning({ id: partnerCommissions.id });
            if (updated.length && !orphan) await tx.update(partnerReferrals).set({ costCarryPence: r.carryOutPence }).where(eq(partnerReferrals.id, refId!));
        });
        checked++;
    }
    return { checked, waiting };
}
