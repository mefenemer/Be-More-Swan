// netlify/functions/platform-review.ts
// The signed-in person's own review OF Be More Swan (src/utils/platform-reviews.ts).
//
//   GET                                          → { setUp, ask, review, destinations, isBeta, incentiveNote }
//   POST { action: 'shown' | 'later' | 'never' }  → { ok }       the in-app ask appeared / maybe later / don't ask again
//   POST { action: 'submit', rating, body, displayName?, displayDetail?, consentToPublish?, source? } → { review, destinations }
//        source 'email' when they came from an admin's emailed request (workspace.html?review=1)
//   POST { action: 'shared', to: 'trustpilot' | 'g2' }  → { ok }  they clicked through to post it there too
//
// One review per person; sending it again replaces it and puts it back to pending, so an admin
// re-reads anything that is quoted. destinations is the same list for everyone, whatever their stars.
// Under impersonation: GET answers ask:false, and every POST is refused by requireTenant.

import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { platformReviews } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { CONFIG_KEYS, getPlatformConfig } from '../../src/utils/platform-config';
import {
    askInputFor, BETA_INCENTIVE_NOTE, cleanDestinations, cleanPlatformReview, DESTINATION_KEYS, destinationList,
    isMissingTable, recordAsk, shouldAsk, wasOnBeta, type DestinationKey,
} from '../../src/utils/platform-reviews';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function destinations() {
    const d = cleanDestinations(await getPlatformConfig(CONFIG_KEYS.REVIEW_DESTINATIONS).catch(() => null));
    return d.ok ? destinationList(d.value) : [];
}

const publicReview = (r: typeof platformReviews.$inferSelect) => ({
    rating: r.rating, body: r.body, displayName: r.displayName, displayDetail: r.displayDetail,
    consentToPublish: r.consentToPublish, status: r.status, sharedTo: r.sharedTo, createdAt: r.createdAt,
});

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    try {
        if (method === 'GET') {
            const [input, [review], isBeta, dest] = await Promise.all([
                askInputFor(db, userId, organisationId, !!ctx.impersonation),
                db.select().from(platformReviews).where(eq(platformReviews.userId, userId)).limit(1),
                wasOnBeta(db, organisationId),
                destinations(),
            ]);
            return json(200, {
                setUp: true, ask: shouldAsk(input).ask, review: review ? publicReview(review) : null,
                destinations: dest, isBeta, incentiveNote: isBeta ? BETA_INCENTIVE_NOTE : null,
            });
        }

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const action = String(body.action || '');

        if (action === 'shown' || action === 'later' || action === 'never') {
            await recordAsk(db, userId, action);
            return json(200, { ok: true });
        }

        if (action === 'shared') {
            const to = String(body.to || '') as DestinationKey;
            if (!DESTINATION_KEYS.includes(to)) return json(400, { error: 'Unknown site.' });
            const [r] = await db.select({ id: platformReviews.id, sharedTo: platformReviews.sharedTo }).from(platformReviews)
                .where(eq(platformReviews.userId, userId)).limit(1);
            if (!r) return json(404, { error: 'Send your review first.' });
            if (!r.sharedTo.includes(to)) {
                await db.update(platformReviews).set({ sharedTo: [...r.sharedTo, to], updatedAt: new Date() }).where(eq(platformReviews.id, r.id));
            }
            return json(200, { ok: true });
        }

        if (action !== 'submit') return json(400, { error: 'Unknown action.' });
        const c = cleanPlatformReview(body);
        if (!c.ok) return json(400, { error: c.error });
        const now = new Date();
        const incentiveNote = (await wasOnBeta(db, organisationId)) ? BETA_INCENTIVE_NOTE : null;
        const values = { ...c.value, organisationId, incentiveNote, status: 'pending', decidedBy: null, decidedAt: null, updatedAt: now };
        const [row] = await db.insert(platformReviews).values({ userId, source: body.source === 'email' ? 'email' : 'in_app', ...values })
            .onConflictDoUpdate({ target: platformReviews.userId, set: values }).returning();
        return json(200, { review: publicReview(row), destinations: await destinations() });
    } catch (err) {
        // Until db/z-platform-reviews.sql runs on this database, nobody is asked and nothing breaks.
        if (isMissingTable(err)) return method === 'GET' ? json(200, { setUp: false, ask: false, review: null, destinations: [] }) : json(503, { error: 'Reviews are not set up yet.' });
        console.error('[platform-review]', err);
        return json(500, { error: 'Something went wrong. Please try again.' });
    }
});
