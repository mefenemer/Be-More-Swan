// netlify/functions/resolve-ab-tests.ts
// Autonomous Content Engine — US 5.2 AC3: scheduled A/B winner selection.
//
// Runs on a cron (see netlify.toml). For every blog post in 'testing' whose variants have
// collectively reached the impression threshold, scores each variant and promotes the winner
// (winning_variant + ab_state='decided'), so the widget then serves the winner permanently.
//
// v1 scoring: weighted engaged-rate + normalised dwell + normalised scroll. Proper statistical
// significance (two-proportion z-test) is a documented fast-follow (docs §11).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts, blogAbStats } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const MIN_IMPRESSIONS = Number(process.env.AB_MIN_IMPRESSIONS || 200); // total across variants

function scoreVariant(s: { impressions: number; engagedCount: number; sumDwellMs: number; sumScrollPct: number }) {
    if (s.impressions <= 0) return 0;
    const engagedRate = s.engagedCount / s.impressions;                 // 0..1
    const avgDwell = Math.min(1, (s.sumDwellMs / s.impressions) / 60000); // normalise vs 60s
    const avgScroll = (s.sumScrollPct / s.impressions) / 100;             // 0..1
    return engagedRate * 0.6 + avgDwell * 0.25 + avgScroll * 0.15;
}

export default withLambda(async () => {
    const db = getDb();

    const testing = await db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(eq(blogPosts.abState, 'testing'));
    if (testing.length === 0) return { statusCode: 200, body: JSON.stringify({ resolved: 0 }) };

    const ids = testing.map((r) => r.id);
    const stats = await db
        .select()
        .from(blogAbStats)
        .where(inArray(blogAbStats.blogPostId, ids));

    // Group stats by post.
    const byPost = new Map<number, typeof stats>();
    for (const s of stats) {
        const list = byPost.get(s.blogPostId) || [];
        list.push(s);
        byPost.set(s.blogPostId, list);
    }

    let resolved = 0;
    for (const postId of ids) {
        const rows = byPost.get(postId) || [];
        const total = rows.reduce((n, r) => n + r.impressions, 0);
        if (total < MIN_IMPRESSIONS) continue;

        let winner = rows[0];
        let best = -1;
        for (const r of rows) {
            const sc = scoreVariant(r);
            if (sc > best) { best = sc; winner = r; }
        }
        if (!winner) continue;

        await db
            .update(blogPosts)
            .set({ winningVariant: winner.variantId, abState: 'decided', updatedAt: new Date() })
            .where(and(eq(blogPosts.id, postId), eq(blogPosts.abState, 'testing')));
        resolved++;
    }

    return { statusCode: 200, body: JSON.stringify({ resolved }) };
});
