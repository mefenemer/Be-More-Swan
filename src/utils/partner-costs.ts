// src/utils/partner-costs.ts
// Partner commission after ACTUAL costs (docs/partner-actual-costs-plan.md; owner decisions 2026-11-23):
//
//   deduction   = max( minimum% × payment , cost of service that month )      cost = AI + media + bot + email + card fee
//   available   = payment − deduction − shortfall carried in from this customer's earlier months
//   commission  = rate × max(0, available)        (never below 0 — the partner never owes us because of costs)
//   carried out = max(0, −available)              → taken off this customer's next months; lapses when their window ends
//
// An annual payment is 12 equal monthly slices, each worked out once that month's costs are known (D5). Costs logged in
// US dollars are converted at the European Central Bank's daily reference rate (D6).
//
// Pure, except fetchEcbUsdGbp (one HTTP GET). The ledger and the nightly sweep use these.

import { addMonthsUtc } from './partner-rate-periods';

export interface CostRuleInput {
    /** What the customer paid for this month of service, excluding VAT, in pence. */
    paymentPence: number;
    /** The minimum deduction in basis points (2000 = 20%), locked on the customer. */
    minDeductionBps: number;
    /** Measured cost of service for that customer that month (AI, media, voice, bot, email), in pence. */
    costPence: number;
    /** The card / payment processing fee on this payment, in pence (0 if unknown). */
    cardFeePence: number;
    /** Shortfall carried in from this customer's earlier months, in pence. */
    carryInPence: number;
    /** The partner's rate in basis points (5000 = 50%). */
    rateBps: number;
}
export interface CostRuleResult {
    deductionPence: number;
    basis: 'minimum' | 'actual';
    availablePence: number;
    commissionPence: number;
    carryOutPence: number;
}

const BPS = 10_000;
const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

export function applyCostRule(i: CostRuleInput): CostRuleResult {
    const payment = nonNeg(i.paymentPence);
    const minimum = Math.round((payment * Math.min(BPS, nonNeg(i.minDeductionBps))) / BPS);
    const actual = nonNeg(i.costPence) + nonNeg(i.cardFeePence);
    // Ties go to 'minimum': the measured costs didn't change anything.
    const basis: CostRuleResult['basis'] = actual > minimum ? 'actual' : 'minimum';
    const deductionPence = Math.max(minimum, actual);
    const availablePence = payment - deductionPence - nonNeg(i.carryInPence);
    // One rounding, DOWN to the penny (as commissionPence in partner-rate-periods.ts).
    const commissionPence = availablePence > 0 ? Math.floor((availablePence * Math.min(BPS, nonNeg(i.rateBps))) / BPS) : 0;
    return { deductionPence, basis, availablePence, commissionPence, carryOutPence: availablePence < 0 ? -availablePence : 0 };
}

export interface ServiceSlice { periodStart: Date; periodEnd: Date; netPence: number; index: number }

/**
 * A payment's months of service. A monthly payment is one slice. A payment covering about a year (or any span over
 * ~45 days) is split into whole months with the net shared equally (the remainder on the last), so each month's
 * commission can be worked out against that month's costs (D5). Missing dates → one month from `paidAt`.
 */
export function serviceSlices(netPence: number, periodStart: Date | null, periodEnd: Date | null, paidAt: Date): ServiceSlice[] {
    const start = periodStart ?? paidAt;
    const end = periodEnd ?? addMonthsUtc(start, 1);
    const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
    if (!(spanDays > 45)) return [{ periodStart: start, periodEnd: end, netPence: nonNeg(netPence), index: 0 }];
    let months = 0;
    while (months < 36 && addMonthsUtc(start, months + 1).getTime() <= end.getTime() + 86_400_000) months++;
    months = Math.max(1, months);
    const net = nonNeg(netPence);
    const each = Math.floor(net / months);
    return Array.from({ length: months }, (_, m) => ({
        periodStart: addMonthsUtc(start, m),
        periodEnd: m === months - 1 ? end : addMonthsUtc(start, m + 1),
        netPence: m === months - 1 ? net - each * (months - 1) : each,
        index: m,
    }));
}

/** The ledger reference for a slice: the payment's own for a single month; `<ref>#m<n>` for each month of a longer one. */
export function sliceRef(paymentRef: string, slice: ServiceSlice, sliceCount: number): string {
    return sliceCount <= 1 ? paymentRef : `${paymentRef}#m${slice.index + 1}`;
}

/** US dollars → pence at a pounds-per-dollar rate. Rounded to the nearest penny. */
export function usdToPence(usd: number, usdGbp: number): number {
    if (!(usd > 0) || !(usdGbp > 0)) return 0;
    return Math.round(usd * usdGbp * 100);
}

/**
 * The ECB's daily reference rates are quoted against the euro (1 EUR = x USD, 1 EUR = y GBP), so pounds per dollar =
 * y / x. Reads the ECB's eurofxref-daily.xml. Null when a rate is missing.
 */
export function parseEcbUsdGbp(xml: string): { day: string; usdGbp: number } | null {
    const day = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
    const rate = (cur: string) => Number(xml.match(new RegExp(`currency=['"]${cur}['"]\\s+rate=['"]([0-9.]+)['"]`))?.[1]);
    const usd = rate('USD'), gbp = rate('GBP');
    if (!day || !(usd > 0) || !(gbp > 0)) return null;
    return { day, usdGbp: Math.round((gbp / usd) * 1e6) / 1e6 };
}

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export async function fetchEcbUsdGbp(fetchFn: typeof fetch = fetch): Promise<{ day: string; usdGbp: number } | null> {
    const res = await fetchFn(ECB_DAILY_URL, { headers: { accept: 'application/xml' } });
    if (!res.ok) return null;
    return parseEcbUsdGbp(await res.text());
}
