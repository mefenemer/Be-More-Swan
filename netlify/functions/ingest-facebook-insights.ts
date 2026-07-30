// netlify/functions/ingest-facebook-insights.ts
// Scheduled ingester that pulls Facebook PAGE POST insights for recently-published posts and upserts
// them into post_insights — the Facebook counterpart of ingest-instagram-insights.ts.
//
// WHY THIS EXISTS: post_insights was designed multi-platform from the start (its `platform` column
// is documented `instagram | facebook | linkedin | x`, and it carries columns for shares, saves,
// video views and linkClicks), but ingest-instagram-insights.ts was its ONLY writer. Every metric
// derived from that table — engagement rate, reach — could therefore only ever be an Instagram one,
// which is the whole reason the goal catalog looked Instagram-biased. It wasn't a decision; it was
// the absence of this file.
//
// ── The metric that made this worth building ────────────────────────────────────────────────
// `linkClicks`. Instagram cannot supply it — ingest-instagram-insights.ts hardcodes `linkClicks:
// null` with the note "IG organic feed exposes no per-post link clicks" — which is why a Social
// Media Manager had NO metric for the 'action' funnel objective at all, while the Goal Builder went
// on advertising "Drive Traffic (Action)". Facebook Page posts do expose it, so this ingester is
// what makes `facebook_link_clicks` real.
//
// Schedule: every 6 hours (netlify.toml), same cadence and rolling 30-day re-fetch window as the
// Instagram ingester — engagement keeps accruing for days after publish.
//
// Reuses the publisher's token/vault conventions (publish-facebook.ts) and the same Graph host
// Instagram uses, on the same Page access token.

import { Handler } from '@netlify/functions';
import { and, eq, gte, isNotNull, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, systemConnections, postInsights } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { withLambda } from '@netlify/aws-lambda-compat';

const GRAPH_VERSION = 'v19.0';
const WINDOW_DAYS = 30;
const BATCH = 200;

// Page-post insight metrics.
//   post_impressions_unique  → reach (people, not views)
//   post_impressions         → impressions (Facebook DOES expose this; Instagram no longer does)
//   post_clicks_by_type      → a breakdown object; we want its "link clicks" entry
//   post_video_views         → only present on video posts, absent (not an error) otherwise
//
// ⚠️ Requesting a metric a given post type doesn't support makes Graph reject the WHOLE call
// (error 100) rather than omitting that one — the same trap ingest-instagram-insights.ts documents
// for `impressions`. These four are page-post-wide, and post_video_views degrades to an absent row
// rather than an error, so they are safe to request together for both image and video posts.
const POST_METRICS = [
    'post_impressions_unique',
    'post_impressions',
    'post_clicks_by_type',
    'post_video_views',
];

// Reactions/comments/shares are NOT insight metrics on Facebook — they are edges on the post object,
// read with summary counts. That is the one structural difference from the Instagram ingester, which
// gets everything from a single /insights call.
const POST_FIELDS = 'shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)';

type InsightRow = { name: string; values?: { value: unknown }[] };

/** A numeric insight value, or null when the metric was absent or non-numeric. */
function numericMetric(map: Record<string, unknown>, name: string): number | null {
    const v = map[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Link clicks out of `post_clicks_by_type`.
 *
 * The value is an object keyed by click type — `{ "other clicks": n, "link clicks": n, "photo view":
 * n }` — and we want only the link ones. Falling back to a total `post_clicks` would be WRONG for a
 * goal metric: "other clicks" counts expanding the caption or clicking the page name, which is not
 * traffic to the business by any honest reading. Absent breakdown ⇒ null, not 0, so an unmeasured
 * post never looks like a post that earned no clicks.
 */
export function linkClicksFrom(byType: unknown): number | null {
    if (!byType || typeof byType !== 'object') return null;
    const entry = Object.entries(byType as Record<string, unknown>)
        .find(([k]) => k.toLowerCase().replace(/[_\s]+/g, ' ').trim() === 'link clicks');
    const v = entry?.[1];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export type IngestResult = { processed: number; updated: number; failed: number; durationMs: number };

/** The ingest tick itself. Exported so run-insights-ingest.ts can drive the SAME logic over HTTP on
 *  staging, where Netlify's scheduler never fires (branch deploys get no crons). */
export async function ingestFacebookInsights(): Promise<IngestResult> {
    const db = getDb();
    const tickStart = Date.now();
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

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
            eq(scheduledPosts.platform, 'facebook'),
            eq(scheduledPosts.status, 'published'),
            isNotNull(scheduledPosts.platformPostId),
            or(gte(scheduledPosts.publishedAt, windowStart), isNull(scheduledPosts.publishedAt)),
        ))
        .limit(BATCH);

    if (!posts.length) {
        return { processed: 0, updated: 0, failed: 0, durationMs: Date.now() - tickStart };
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

            const auth = encodeURIComponent(token);
            // Two calls, because reactions/comments/shares live on the post object and the rest on
            // its insights edge. Issued together; either failing is treated as a failure for the
            // post rather than half-writing a row that would understate engagement.
            const [insightsRes, fieldsRes] = await Promise.all([
                fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${post.platformPostId}/insights?metric=${POST_METRICS.join(',')}&access_token=${auth}`),
                fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${post.platformPostId}?fields=${encodeURIComponent(POST_FIELDS)}&access_token=${auth}`),
            ]);

            const insightsData: { data?: InsightRow[]; error?: { code: number; message: string } } = await insightsRes.json();
            const fieldsData: {
                shares?: { count?: number };
                reactions?: { summary?: { total_count?: number } };
                comments?: { summary?: { total_count?: number } };
                error?: { code: number; message: string };
            } = await fieldsRes.json();

            const err = insightsData.error ?? fieldsData.error;
            if (err) {
                // 190 = token expired/invalid — mark the connection so the UI prompts a reconnect.
                if (err.code === 190) expiredConnections.add(post.connectionId);
                failed++;
                return;
            }

            const map: Record<string, unknown> = {};
            for (const m of insightsData.data ?? []) map[m.name] = m.values?.[0]?.value ?? null;

            const likes    = fieldsData.reactions?.summary?.total_count ?? null;
            const comments = fieldsData.comments?.summary?.total_count ?? null;
            const shares   = fieldsData.shares?.count ?? null;
            const reach    = numericMetric(map, 'post_impressions_unique');

            const row = {
                organisationId: post.organisationId!,
                assistantId: post.assistantId ?? null,
                connectionId: post.connectionId,
                platform: 'facebook',
                platformPostId: post.platformPostId,
                publishedAt: post.publishedAt ?? null,
                reach,
                impressions: numericMetric(map, 'post_impressions'),
                likes,
                comments,
                shares,
                // Facebook has no "saves" equivalent for Page posts. Null, not 0 — a zero here would
                // drag any cross-platform average down as though nobody ever saved a post.
                saves: null,
                totalInteractions: [likes, comments, shares].reduce<number>((s, v) => s + (v ?? 0), 0),
                videoViews: numericMetric(map, 'post_video_views'),
                // The column Instagram can never fill. See linkClicksFrom.
                linkClicks: linkClicksFrom(map['post_clicks_by_type']),
                raw: { insights: insightsData.data ?? null, fields: fieldsData },
                fetchedAt: new Date(),
                updatedAt: new Date(),
            };

            await db.insert(postInsights)
                .values({ scheduledPostId: post.id, ...row })
                .onConflictDoUpdate({ target: postInsights.scheduledPostId, set: row });
            updated++;
        } catch (err) {
            console.error(`[ingest-facebook-insights] post ${post.id} error:`, err instanceof Error ? err.message : err);
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
    console.log(`[ingest-facebook-insights] processed=${posts.length} updated=${updated} failed=${failed} ${durationMs}ms`);
    return { processed: posts.length, updated, failed, durationMs };
}

// The scheduled entry point (netlify.toml → every 6 hours). PRODUCTION ONLY — Netlify never runs
// scheduled functions on a branch deploy, so staging is driven by run-insights-ingest.ts instead.
export default withLambda(async () => {
    const result = await ingestFacebookInsights();
    return { statusCode: 200, body: JSON.stringify(result) };
});
