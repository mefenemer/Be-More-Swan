// netlify/functions/ingest-instagram-insights.ts
// US-SMM-PERF: Scheduled ingester that pulls Instagram media insights for
// recently-published posts and upserts them into post_insights. Aggregated by
// get-assistant-metrics.ts to power the assistant-detail "Performance Metrics" cards.
//
// Schedule: every 6 hours (see netlify.toml). Insights keep changing for days
// after publish, so we re-fetch posts published within a rolling window each run.
//
// Reuses the publisher's token/vault and Graph-API conventions (publish-instagram.ts).

import { Handler } from '@netlify/functions';
import { and, eq, gte, isNotNull, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, systemConnections, postInsights } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';

const GRAPH_VERSION = 'v19.0';
// Insights stabilise within ~2 weeks; re-fetch a 30-day window to catch late engagement.
const WINDOW_DAYS = 30;
const BATCH = 200;

// Metrics requested for every media type. We avoid `impressions` because it is
// deprecated for media created on newer API versions and errors the whole call.
const BASE_METRICS = ['reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];
const VIDEO_METRICS = [...BASE_METRICS, 'views'];

type InsightValue = { name: string; values: { value: number }[] };

function pickMetric(map: Record<string, number>, ...names: string[]): number | null {
    for (const n of names) if (typeof map[n] === 'number') return map[n];
    return null;
}

export const handler: Handler = async () => {
    const db = getDb();
    const tickStart = Date.now();
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Published IG posts in the rolling window (or never fetched yet) that carry a media id.
    const posts = await db
        .select({
            id: scheduledPosts.id,
            organisationId: scheduledPosts.organisationId,
            assistantId: scheduledPosts.assistantId,
            connectionId: scheduledPosts.connectionId,
            platformPostId: scheduledPosts.platformPostId,
            publishedAt: scheduledPosts.publishedAt,
            postFormat: scheduledPosts.postFormat,
        })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.platform, 'instagram'),
            eq(scheduledPosts.status, 'published'),
            isNotNull(scheduledPosts.platformPostId),
            or(gte(scheduledPosts.publishedAt, windowStart), isNull(scheduledPosts.publishedAt)),
        ))
        .limit(BATCH);

    if (!posts.length) {
        return { statusCode: 200, body: JSON.stringify({ processed: 0, updated: 0, failed: 0 }) };
    }

    // Cache one token per connection so we don't re-read the vault per post.
    const tokenCache = new Map<number, { token: string } | null>();
    async function tokenFor(connectionId: number): Promise<string | null> {
        if (tokenCache.has(connectionId)) return tokenCache.get(connectionId)?.token ?? null;
        const [conn] = await db
            .select({ vaultRefKey: systemConnections.vaultRefKey })
            .from(systemConnections)
            .where(eq(systemConnections.id, connectionId))
            .limit(1);
        if (!conn?.vaultRefKey) { tokenCache.set(connectionId, null); return null; }
        const secret = await getSecret(db, conn.vaultRefKey);
        const token = (secret?.token as string | undefined) ?? null;
        tokenCache.set(connectionId, token ? { token } : null);
        return token;
    }

    let updated = 0, failed = 0;
    const expiredConnections = new Set<number>();

    await Promise.allSettled(posts.map(async (post) => {
        try {
            if (!post.connectionId || !post.platformPostId) return;
            const token = await tokenFor(post.connectionId);
            if (!token) { failed++; return; }

            const isVideo = ['reel', 'video'].includes((post.postFormat || '').toLowerCase());
            const metrics = (isVideo ? VIDEO_METRICS : BASE_METRICS).join(',');

            const res = await fetch(
                `https://graph.facebook.com/${GRAPH_VERSION}/${post.platformPostId}/insights?metric=${metrics}&access_token=${encodeURIComponent(token)}`
            );
            const data: { data?: InsightValue[]; error?: { code: number; message: string } } = await res.json();

            if (data.error) {
                // 190 = token expired/invalid — mark the connection so the UI prompts a reconnect.
                if (data.error.code === 190) expiredConnections.add(post.connectionId);
                failed++;
                return;
            }

            const map: Record<string, number> = {};
            for (const m of data.data ?? []) map[m.name] = m.values?.[0]?.value ?? 0;

            const likes    = pickMetric(map, 'likes');
            const comments = pickMetric(map, 'comments');
            const shares   = pickMetric(map, 'shares');
            const saves    = pickMetric(map, 'saved');
            const reach    = pickMetric(map, 'reach');
            // Prefer the platform's rollup; fall back to summing components.
            const totalInteractions = pickMetric(map, 'total_interactions')
                ?? [likes, comments, shares, saves].reduce<number>((s, v) => s + (v ?? 0), 0);

            const row = {
                organisationId: post.organisationId!,
                assistantId: post.assistantId ?? null,
                connectionId: post.connectionId,
                platform: 'instagram',
                platformPostId: post.platformPostId,
                publishedAt: post.publishedAt ?? null,
                reach,
                impressions: null,
                likes,
                comments,
                shares,
                saves,
                totalInteractions,
                videoViews: pickMetric(map, 'views', 'plays'),
                linkClicks: null, // IG organic feed exposes no per-post link clicks
                raw: data.data ?? null,
                fetchedAt: new Date(),
                updatedAt: new Date(),
            };

            await db.insert(postInsights)
                .values({ scheduledPostId: post.id, ...row })
                .onConflictDoUpdate({ target: postInsights.scheduledPostId, set: row });
            updated++;
        } catch (err) {
            console.error(`[ingest-instagram-insights] post ${post.id} error:`, err instanceof Error ? err.message : err);
            failed++;
        }
    }));

    // Flag connections whose token expired so the connection UI can prompt a reconnect.
    for (const connId of expiredConnections) {
        await db.update(systemConnections)
            .set({ status: 'token_expired', updatedAt: new Date() })
            .where(eq(systemConnections.id, connId))
            .catch(() => {});
    }

    const durationMs = Date.now() - tickStart;
    console.log(`[ingest-instagram-insights] processed=${posts.length} updated=${updated} failed=${failed} ${durationMs}ms`);
    return { statusCode: 200, body: JSON.stringify({ processed: posts.length, updated, failed, durationMs }) };
};
