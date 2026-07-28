// pexels-search.ts — interactive Pexels image sourcing for the post-creation UI (US1/US2/US3).
//
// POST { topic?, postId?, page? }                  → top-5 unique candidates for the picker.
// POST { action:'select', postId, candidate }      → attach the chosen image to the post draft,
//                                                     appending a Pexels credit line iff the org opts in.
//
// Dedup (posted_assets) is NOT written here — that happens only when a post is scheduled or
// published (see approve-post.ts / publish-*.ts), per US2 AC2.5.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, organisations, scheduledPosts } from '../../db/schema';
import {
    searchUniqueImages, searchUniqueVideos, attachPexelsImageToPost, creditLine,
    PexelsRateLimitError, PEXELS_RATE_LIMIT_MESSAGE, type PexelsCandidate, type PexelsVideoCandidate,
} from '../../src/utils/pexels';
import { mediaTargetPostIds } from '../../src/utils/crosspost-media';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

function auth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try {
        return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return null;
    }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const userId = auth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // Resolve user + org (+ attribution preference).
    const [user] = await db
        .select({ id: users.id, organisationId: userOrganisations.organisationId })
        .from(users)
        .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
        .where(eq(users.id, userId));
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };
    const orgId = user.organisationId;

    let body: { action?: string; topic?: string; postId?: number; candidate?: PexelsCandidate | PexelsVideoCandidate; mediaType?: string; dedup?: boolean; applyToGroup?: boolean };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const mediaType: 'image' | 'video' = body.mediaType === 'video' ? 'video' : 'image';
    // Dedup against posted_assets is on by default (social-feed never-reuse rule). Non-feed callers
    // (blog hero images) pass dedup:false to draw from the full stock pool.
    const dedup = body.dedup !== false;

    try {
        // ── SELECT: attach a chosen candidate to the post draft ───────────────
        if (body.action === 'select') {
            const { postId, candidate } = body;
            if (!postId || !candidate?.providerAssetId || !candidate?.url) {
                return { statusCode: 400, body: JSON.stringify({ error: 'postId and a valid candidate are required.' }) };
            }

            // Ownership check.
            const [post] = await db
                .select({ id: scheduledPosts.id, caption: scheduledPosts.caption })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
                .limit(1);
            if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

            // A stock photo picked for a cross-post goes on every platform of it, not just the tab
            // that was open. orgId gates the fan-out because it is what scopes the sibling lookup —
            // without it we could not prove the siblings are this tenant's.
            const targetIds = orgId
                ? await mediaTargetPostIds(db, { postId, orgId, applyToGroup: body.applyToGroup })
                : [postId];

            const assetId = await attachPexelsImageToPost(db, { postId, postIds: targetIds, userId, orgId, candidate, assetType: mediaType });

            // US3 AC3.3: append the credit line to the draft only when the org opts in.
            // Every post carrying the photo needs the credit — attributing it on one platform while
            // three others publish the same picture uncredited is the licence breach this prevents.
            let attributionAppended = false;
            if (orgId) {
                const [org] = await db
                    .select({ enabled: organisations.pexelsAttributionEnabled })
                    .from(organisations).where(eq(organisations.id, orgId)).limit(1);
                const line = creditLine(candidate.photographer);
                if (org?.enabled) {
                    // Per post: siblings can already differ (a rewritten caption on one platform),
                    // so appending the anchor's caption to all of them would overwrite that work.
                    const rows = await db
                        .select({ id: scheduledPosts.id, caption: scheduledPosts.caption })
                        .from(scheduledPosts).where(inArray(scheduledPosts.id, targetIds));
                    for (const row of rows) {
                        if ((row.caption || '').includes(line.trim())) continue;
                        await db.update(scheduledPosts)
                            .set({ caption: `${row.caption || ''}${line}`, updatedAt: new Date() })
                            .where(eq(scheduledPosts.id, row.id));
                        if (row.id === postId) attributionAppended = true;
                    }
                }
            }

            return { statusCode: 200, body: JSON.stringify({ assetId, attributionAppended, postIds: targetIds }) };
        }

        // ── SEARCH: return unique candidates for the picker ───────────────────
        if (!orgId) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation for user.' }) };

        let context = (body.topic || '').trim();
        if (!context && body.postId) {
            const [post] = await db
                .select({ desc: scheduledPosts.suggestedMediaDescription, caption: scheduledPosts.caption })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, body.postId), eq(scheduledPosts.userId, userId)))
                .limit(1);
            context = (post?.desc || post?.caption || '').trim();
        }
        if (!context) return { statusCode: 400, body: JSON.stringify({ error: 'A topic or postId with content is required.' }) };

        const { keywords, candidates } = mediaType === 'video'
            ? await searchUniqueVideos(db, orgId, context, { dedup })
            : await searchUniqueImages(db, orgId, context, { dedup });
        return { statusCode: 200, body: JSON.stringify({ keywords, candidates, mediaType }) };

    } catch (err) {
        if (err instanceof PexelsRateLimitError) {
            return { statusCode: 429, body: JSON.stringify({ error: PEXELS_RATE_LIMIT_MESSAGE }) }; // US3 AC3.4
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('PEXELS_API_KEY')) {
            return { statusCode: 503, body: JSON.stringify({ error: 'Image search is not configured.' }) };
        }
        console.error('[pexels-search] error:', msg);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
});
