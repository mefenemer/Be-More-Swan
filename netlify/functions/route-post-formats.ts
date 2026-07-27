// netlify/functions/route-post-formats.ts
// GET ?postId=N → the format every platform in this post's cross-post group would publish as.
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
import { loadAssetMetrics, routeAcross } from '../../src/utils/format-router';
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

        // Every platform this post goes out on. Siblings share a crosspost group; a post that has
        // never been cross-posted is a group of one.
        let platforms: string[] = [post.platform!].filter(Boolean);
        const groupId = post.crosspostGroupId;
        if (groupId) {
            const siblings = await db.select({ platform: scheduledPosts.platform })
                .from(scheduledPosts).where(eq(scheduledPosts.crosspostGroupId, groupId));
            platforms = [...new Set(siblings.map((s: any) => s.platform).filter(Boolean))];
        }

        const assets = await loadAssetMetrics(db, post.contentAssetIds);
        const routed = routeAcross(platforms, assets);

        // Flattened for the client: it needs to render a tab, not reason about a format object.
        const routes: Record<string, unknown> = {};
        for (const [platform, r] of Object.entries(routed)) {
            routes[platform] = {
                state: r.state,
                formatKey: r.format?.key ?? null,
                formatLabel: r.format?.label ?? null,
                reason: r.reason ?? null,
                verified: r.verified,
                alternatives: r.alternatives.map(f => ({ key: f.key, label: f.label })),
            };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routes,
                // What the routing was derived FROM, so the composer can say "we haven't measured
                // this yet" rather than showing a confident answer built on nulls.
                assets: assets.map(a => ({ kind: a.kind, width: a.width ?? null, height: a.height ?? null, durationS: a.durationS ?? null })),
            }),
        };
    } catch (err) {
        console.error('[route-post-formats]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not work out the formats.' }) };
    }
});
