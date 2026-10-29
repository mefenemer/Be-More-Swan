// netlify/functions/get-reviews.ts
// Public: the reviews of Be More Swan an admin has published (Admin → Customers → Reviews), for the
// site build to bake into the home and pricing pages (scripts/build-seo-html.mjs, Job 9).
//
//   GET → { reviews: [{ name, detail, rating, body, incentiveNote, date }], summary: { count, average } }
//
// reviews: published AND the author agreed to be quoted — newest first, never sorted by stars.
// summary: every counted review (published and hidden), so hiding a bad one never lifts the average
// (src/utils/platform-reviews.ts, reviewStats). Nothing that identifies the author beyond the name
// and business they typed in the form is returned.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { platformReviews } from '../../db/schema';
import { isMissingTable, reviewStats } from '../../src/utils/platform-reviews';

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
};
const MAX_QUOTED = 12;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };
    try {
        const db = getDb();
        const counted = await db.select({ rating: platformReviews.rating, status: platformReviews.status, sharedTo: platformReviews.sharedTo })
            .from(platformReviews).where(inArray(platformReviews.status, ['published', 'hidden']));
        const quoted = await db.select().from(platformReviews)
            .where(and(eq(platformReviews.status, 'published'), eq(platformReviews.consentToPublish, true)))
            .orderBy(desc(platformReviews.createdAt)).limit(MAX_QUOTED);
        const stats = reviewStats(counted);
        return {
            statusCode: 200, headers: HEADERS,
            body: JSON.stringify({
                reviews: quoted.map((r) => ({
                    name: r.displayName, detail: r.displayDetail, rating: r.rating, body: r.body,
                    incentiveNote: r.incentiveNote, date: r.createdAt.toISOString().slice(0, 10),
                })),
                summary: { count: counted.length, average: stats.average },
            }),
        };
    } catch (err) {
        if (isMissingTable(err)) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ reviews: [], summary: { count: 0, average: null } }) };
        console.error('[get-reviews]', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Could not load reviews.' }) };
    }
});
