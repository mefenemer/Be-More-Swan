// netlify/functions/partner-programme-public.ts
// The partner programme's CURRENT public terms, for partners.html — so the page never states a rate
// the programme no longer pays. Rates are dated periods set by an admin (partner-rate-periods.ts);
// hard-coding "25%" in the page would go stale the first time one is scheduled (memory
// public-copy-claims-vs-system).
//
//   GET → { rateBps, costDeductionBps, durationMonths, minPayoutPence, holdingDays } | { rateBps: null }
//
// Programme-wide rate only — partners' special rates are private.

import { eq, isNull } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { partnerProgrammeSettings, partnerRatePeriods } from '../../db/schema';
import { resolvePeriodAt } from '../../src/utils/partner-rate-periods';

export default withLambda(async (event) => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' };
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
    try {
        const db = getDb();
        const periods = await db.select().from(partnerRatePeriods).where(isNull(partnerRatePeriods.partnerId));
        const current = resolvePeriodAt(periods, -1, new Date());
        const [settings] = await db.select().from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
        return { statusCode: 200, headers, body: JSON.stringify({
            rateBps: current?.rateBps ?? null,
            costDeductionBps: current?.costDeductionBps ?? null,
            durationMonths: current ? current.durationMonths : null,
            minPayoutPence: settings?.minPayoutPence ?? null,
            holdingDays: settings?.holdingDays ?? null,
        }) };
    } catch (err) {
        console.error('[partner-programme-public] failed', err);
        return { statusCode: 200, headers, body: JSON.stringify({ rateBps: null }) };
    }
});
