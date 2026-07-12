// netlify/functions/get-plans.ts
// US-ONB-2.1.1 AC9: Public endpoint — returns active, purchasable master plans ordered by price.
// Used by the plan gate modal so pricing is always live from the DB. The 'trial' tier is
// auto-assigned at registration and is NOT user-selectable, so it is excluded here (otherwise
// the picker would render a bogus "Free Trial — £0/mo" card that fires a £0 checkout).

import { Handler } from '@netlify/functions';
import { and, eq, ne, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { masterPlans } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60',
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };
    }

    try {
        const db = getDb();
        const plans = await db
            .select({
                id: masterPlans.id,
                tierKey: masterPlans.tierKey,
                name: masterPlans.name,
                monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                assistantLimit: masterPlans.assistantLimit,
                monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                appConnectionLimit: masterPlans.appConnectionLimit,
                seatLimit: masterPlans.seatLimit,
                features: masterPlans.features, // AC2.1.2: dynamic feature checklist source
            })
            .from(masterPlans)
            .where(and(eq(masterPlans.isActive, true), ne(masterPlans.tierKey, 'trial')))
            .orderBy(asc(masterPlans.monthlyPriceGbp));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ plans }) };
    } catch (err) {
        console.error('[get-plans]', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Failed to load plans.' }) };
    }
});
