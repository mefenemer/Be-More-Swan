// netlify/functions/get-help-articles.ts
// US-HELP-1.3.1: Public endpoint — no auth required.
// Returns all published help articles ordered by category + sort_order.

import { Handler } from '@netlify/functions';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { helpArticles } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';
import { planPriceVars, fillPlanPriceTokens } from '../../src/utils/plan-price-tokens';

const HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };
    }

    try {
        const db = getDb();

        const rows = await db
            .select({
                id:        helpArticles.id,
                category:  helpArticles.category,
                sortOrder: helpArticles.sortOrder,
                title:     helpArticles.title,
                contentMd: helpArticles.contentMd,
            })
            .from(helpArticles)
            .where(eq(helpArticles.isPublished, true))
            .orderBy(asc(helpArticles.category), asc(helpArticles.sortOrder));

        // Articles quote plan prices as {{plans.saver_price}} / {{plans.buster_price}}; the live
        // value comes from master data here, so no article carries its own copy of a price.
        const prices = await planPriceVars(db);
        const articles = rows.map((a) => ({ ...a, contentMd: fillPlanPriceTokens(a.contentMd ?? '', prices) }));

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ articles }),
        };
    } catch (err) {
        console.error('[get-help-articles]', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Failed to load help articles.' }),
        };
    }
});
