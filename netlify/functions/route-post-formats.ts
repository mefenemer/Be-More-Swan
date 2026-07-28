// netlify/functions/route-post-formats.ts
// GET ?postId=N → the format every platform in this post's cross-post group would publish as.
//
// Each platform is answered from ITS OWN row's media, not from the row in the query string — the
// siblings carry separate contentAssetIds and are allowed to differ, so the answer must not depend
// on which tab the composer happens to have open.
//
// ── Why an endpoint and not a copy of the rules ─────────────────────────────────────────────────
// workspace.html is unbundled and cannot import src/, so every shared rule it has ever needed was
// retyped into the page — and every hand copy eventually drifted, always into a user-visible bug
// (platforms silently dropped from a post, a draft let through that the server would refuse). The
// constants generator fixed that for DATA. This is LOGIC, which a generator cannot mirror, so the
// composer asks the server instead. One implementation, no second copy to fall out of step.
//
// It reads metrics from content_assets rather than accepting them in the request: the whole point
// of persisting width/height/duration was that the answer stops depending on whoever is asking.
// Assets the composer has never measured come back `verified: false`, and the UI says so instead of
// pretending to know.

import jwt from 'jsonwebtoken';
import { eq, and, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, scheduledPosts } from '../../db/schema';
import { assetIdList, loadAssetMetricsById, orderMetrics, routeAsset } from '../../src/utils/format-router';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in.' }) };

    const postId = parseInt(event.queryStringParameters?.postId || '', 10);
    if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };

    try {
        const db = getDb();
        const [me] = await db.select({ organisationId: users.organisationId })
            .from(users).where(eq(users.id, userId)).limit(1);
        if (!me) return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in.' }) };

        // Tenant-scoped: a post id from another organisation must read as "not found", never as a
        // route. Legacy rows with no organisation fall back to the owner check.
        const [post] = await db.select().from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.id, postId),
                me.organisationId
                    ? or(eq(scheduledPosts.organisationId, me.organisationId), isNull(scheduledPosts.organisationId))
                    : eq(scheduledPosts.userId, userId),
            )).limit(1);
        if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

        // ── Each platform is routed against ITS OWN row ─────────────────────────────────────────
        // Siblings share a crosspost group but are separate rows with their own contentAssetIds, and
        // the composer lets a reviewer give one platform a different picture (the "Apply to all
        // platforms" opt-out on the media panel).
        //
        // This used to route every platform in the group against the QUERIED row's media, so the
        // answer depended on which tab happened to be open. Attaching a picture on Instagram and
        // then clicking Facebook re-asked from the Facebook row — which had no media of its own —
        // and every platform came back 'none', so the composer struck Instagram out and relabelled
        // it "no format" a second after it had correctly said "auto-cropped".
        const groupId = post.crosspostGroupId;
        const siblings = groupId
            ? await db.select({
                id: scheduledPosts.id,
                platform: scheduledPosts.platform,
                contentAssetIds: scheduledPosts.contentAssetIds,
            })
                .from(scheduledPosts)
                // Tenant-scoped like the post lookup above: a crosspost_group_id is not a secret, so
                // an unscoped read here would answer for another organisation's rows.
                .where(and(
                    eq(scheduledPosts.crosspostGroupId, groupId),
                    me.organisationId
                        ? or(eq(scheduledPosts.organisationId, me.organisationId), isNull(scheduledPosts.organisationId))
                        : eq(scheduledPosts.userId, userId),
                ))
            : [{ id: post.id, platform: post.platform, contentAssetIds: post.contentAssetIds }];

        // One row per platform. The queried post wins for its own platform, so the tab you are
        // looking at is always described by the row you are looking at.
        const rowFor = new Map<string, { id: number; contentAssetIds: unknown }>();
        for (const s of siblings as any[]) {
            if (!s.platform) continue;
            if (!rowFor.has(s.platform) || s.id === post.id) {
                rowFor.set(s.platform, { id: s.id, contentAssetIds: s.contentAssetIds });
            }
        }
        if (post.platform && !rowFor.has(post.platform)) {
            rowFor.set(post.platform, { id: post.id, contentAssetIds: post.contentAssetIds });
        }

        // Metrics for every asset any sibling carries, in one query rather than one per platform.
        const metrics = await loadAssetMetricsById(
            db,
            [...rowFor.values()].flatMap(r => assetIdList(r.contentAssetIds)),
        );

        // Flattened for the client: it needs to render a tab, not reason about a format object.
        const routes: Record<string, unknown> = {};
        for (const [platform, row] of rowFor) {
            const r = routeAsset(platform, orderMetrics(assetIdList(row.contentAssetIds), metrics));
            routes[platform] = {
                state: r.state,
                formatKey: r.format?.key ?? null,
                formatLabel: r.format?.label ?? null,
                reason: r.reason ?? null,
                verified: r.verified,
                alternatives: r.alternatives.map(f => ({ key: f.key, label: f.label })),
            };
        }

        // What the QUERIED post's routing was derived from, so the composer can say "we haven't
        // measured this yet" rather than showing a confident answer built on nulls.
        const ownAssets = orderMetrics(assetIdList(post.contentAssetIds), metrics);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routes,
                assets: ownAssets.map(a => ({ kind: a.kind, width: a.width ?? null, height: a.height ?? null, durationS: a.durationS ?? null })),
            }),
        };
    } catch (err) {
        console.error('[route-post-formats]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not work out the formats.' }) };
    }
});
