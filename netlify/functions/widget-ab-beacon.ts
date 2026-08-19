// netlify/functions/widget-ab-beacon.ts
// Autonomous Content Engine — US 5.2: anonymous engagement beacon from the native widget.
//
// Public, no auth (posted via navigator.sendBeacon from customer sites). Resolves the widget
// public_key → org, the slug → a published blog_posts.id, then UPSERTS aggregate counters
// (no raw rows, no PII, no cookies).
//
// It writes to TWO tables, answering two different questions:
//   · blog_engagement_stats — ALWAYS. Per POST: did anyone read this, and for how long. Feeds the
//     Blog Writer's "Average Engagement Time" KPI card.
//   · blog_ab_stats — only when `variantId` is present. Per VARIANT: which headline held people
//     longer. Consumed by resolve-ab-tests to pick a winner.
// Keeping them apart is load-bearing — see the warning in db/blog-engagement-stats.sql.
//
// POST { publicKey, slug, variantId?, dwellMs, scrollPct, engaged }  →  204

import { HandlerEvent } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts, blogAbStats, blogEngagementStats } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '' };

    let body: any;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 204, headers: CORS, body: '' }; // beacons are fire-and-forget; never error back
    }

    const { publicKey, slug } = body;
    const dwellMs = Math.max(0, Math.min(Number(body.dwellMs) || 0, 3_600_000));   // clamp 0..1h
    const scrollPct = Math.max(0, Math.min(Number(body.scrollPct) || 0, 100));
    const engaged = body.engaged === true;
    // A missing variant is now NORMAL, not malformed: most posts are not running a headline test.
    // An unparseable one is still dropped rather than coerced — a bad variant must never create a
    // phantom row that resolve-ab-tests would score as a real headline.
    const rawVariant = body.variantId;
    const variantId = (typeof rawVariant === 'string' && /^[A-Z]$/.test(rawVariant)) ? rawVariant : null;
    if (!publicKey || !slug) {
        return { statusCode: 204, headers: CORS, body: '' };
    }

    try {
        const db = getDb();
        const [cfg] = await db
            .select({ organisationId: widgetConfigs.organisationId, status: widgetConfigs.status })
            .from(widgetConfigs)
            .where(eq(widgetConfigs.publicKey, publicKey))
            .limit(1);
        if (!cfg || cfg.status !== 'active') return { statusCode: 204, headers: CORS, body: '' };

        const [post] = await db
            .select({ id: blogPosts.id })
            .from(blogPosts)
            .where(and(
                eq(blogPosts.organisationId, cfg.organisationId),
                eq(blogPosts.slug, slug),
                eq(blogPosts.status, 'published'),
            ))
            .limit(1);
        if (!post) return { statusCode: 204, headers: CORS, body: '' };

        // Whole-post engagement — every read, test or no test.
        await db
            .insert(blogEngagementStats)
            .values({
                blogPostId: post.id,
                views: 1,
                sumDwellMs: dwellMs,
                sumScrollPct: scrollPct,
                engagedCount: engaged ? 1 : 0,
            })
            .onConflictDoUpdate({
                target: blogEngagementStats.blogPostId,
                set: {
                    views: sql`${blogEngagementStats.views} + 1`,
                    sumDwellMs: sql`${blogEngagementStats.sumDwellMs} + ${dwellMs}`,
                    sumScrollPct: sql`${blogEngagementStats.sumScrollPct} + ${scrollPct}`,
                    engagedCount: sql`${blogEngagementStats.engagedCount} + ${engaged ? 1 : 0}`,
                    updatedAt: new Date(),
                },
            });

        // Per-variant scoring — only for a post actually running a headline test.
        if (!variantId) return { statusCode: 204, headers: CORS, body: '' };

        await db
            .insert(blogAbStats)
            .values({
                blogPostId: post.id,
                variantId,
                impressions: 1,
                engagedCount: engaged ? 1 : 0,
                sumDwellMs: dwellMs,
                sumScrollPct: scrollPct,
            })
            .onConflictDoUpdate({
                target: [blogAbStats.blogPostId, blogAbStats.variantId],
                set: {
                    impressions: sql`${blogAbStats.impressions} + 1`,
                    engagedCount: sql`${blogAbStats.engagedCount} + ${engaged ? 1 : 0}`,
                    sumDwellMs: sql`${blogAbStats.sumDwellMs} + ${dwellMs}`,
                    sumScrollPct: sql`${blogAbStats.sumScrollPct} + ${scrollPct}`,
                    updatedAt: new Date(),
                },
            });
    } catch (err) {
        console.error('[widget-ab-beacon] error:', err);
    }
    return { statusCode: 204, headers: CORS, body: '' };
});
