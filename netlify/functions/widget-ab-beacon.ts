// netlify/functions/widget-ab-beacon.ts
// Autonomous Content Engine — US 5.2: anonymous A/B engagement beacon from the native widget.
//
// Public, no auth (posted via navigator.sendBeacon from customer sites). Resolves the widget
// public_key → org, the slug → a published blog_posts.id, then UPSERTS aggregate counters in
// blog_ab_stats (no raw rows, no PII, no cookies). resolve-ab-tests later reads these to pick a
// winner. See docs §11.
//
// POST { publicKey, slug, variantId, dwellMs, scrollPct, engaged }  →  204

import { HandlerEvent } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts, blogAbStats } from '../../db/schema';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '' };

    let body: any;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 204, headers: CORS, body: '' }; // beacons are fire-and-forget; never error back
    }

    const { publicKey, slug, variantId } = body;
    const dwellMs = Math.max(0, Math.min(Number(body.dwellMs) || 0, 3_600_000));   // clamp 0..1h
    const scrollPct = Math.max(0, Math.min(Number(body.scrollPct) || 0, 100));
    const engaged = body.engaged === true;
    if (!publicKey || !slug || typeof variantId !== 'string' || !/^[A-Z]$/.test(variantId)) {
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
};
