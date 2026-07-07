// netlify/functions/ingest-gsc-metrics.ts
// Autonomous Content Engine — US 5.1: content-decay detection via Google Search Console.
//
// Daily cron (see netlify.toml). For every org with an active Search Console connection, pulls
// search impressions for each published blog post that has a canonical_url, tracks the peak in
// blog_posts.traffic_baseline, and — when impressions fall below a threshold of that peak —
// raises a persistent "Update Ticket" notification for the author.
//
// Surfacing choice: a notification (persistent, user-facing, no auto-expiry) rather than
// pending_actions, which auto-cancels after 24h and is coupled to the agent-action approval flow.

import { Handler } from '@netlify/functions';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts, notifications, workspaceIntegrations } from '../../db/schema';
import { getFreshAccessToken, IntegrationError } from '../../src/utils/workspace-integrations';
import { evaluateDecay, gscDateRange, matchProperty } from '../../src/utils/gsc-decay';

const DECAY_RATIO = Number(process.env.GSC_DECAY_RATIO || 0.6);   // flag at a 40% drop from peak
const MIN_BASELINE = Number(process.env.GSC_MIN_BASELINE || 50);  // ignore posts with tiny peaks
const LOOKBACK_DAYS = Number(process.env.GSC_LOOKBACK_DAYS || 28);
const LAG_DAYS = Number(process.env.GSC_LAG_DAYS || 3);           // GSC data trails ~2-3 days
const RENOTIFY_DAYS = Number(process.env.GSC_RENOTIFY_DAYS || 30);

async function listProperties(token: string): Promise<string[]> {
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
    return (data.siteEntry ?? [])
        .filter((s) => s.siteUrl && s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser')
        .map((s) => s.siteUrl!);
}

async function queryImpressions(token: string, property: string, pageUrl: string, range: { startDate: string; endDate: string }): Promise<number | null> {
    const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            startDate: range.startDate,
            endDate: range.endDate,
            dimensions: ['page'],
            dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }],
            rowLimit: 1,
        }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { rows?: { impressions?: number }[] };
    return Math.round(data.rows?.[0]?.impressions ?? 0);
}

export const handler: Handler = async () => {
    const db = getDb();
    const range = gscDateRange(LOOKBACK_DAYS, LAG_DAYS);

    const integrations = await db
        .select({ organisationId: workspaceIntegrations.organisationId })
        .from(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.provider, 'searchconsole'), eq(workspaceIntegrations.status, 'active')));

    let checked = 0;
    let flagged = 0;

    for (const { organisationId } of integrations) {
        if (organisationId == null) continue;
        try {
            const fresh = await getFreshAccessToken(db, organisationId, 'searchconsole');
            const properties = await listProperties(fresh.accessToken);
            if (!properties.length) continue;

            const posts = await db
                .select({
                    id: blogPosts.id,
                    userId: blogPosts.userId,
                    title: blogPosts.title,
                    canonicalUrl: blogPosts.canonicalUrl,
                    trafficBaseline: blogPosts.trafficBaseline,
                })
                .from(blogPosts)
                .where(and(
                    eq(blogPosts.organisationId, organisationId),
                    eq(blogPosts.status, 'published'),
                    isNotNull(blogPosts.canonicalUrl),
                ));

            for (const post of posts) {
                const url = post.canonicalUrl as string;
                const property = matchProperty(url, properties);
                if (!property) continue;

                const current = await queryImpressions(fresh.accessToken, property, url, range);
                if (current == null) continue;
                checked++;

                const peak = post.trafficBaseline; // the pre-update peak, for the notification copy
                const { newBaseline, decayed } = evaluateDecay({ baseline: peak, current, minBaseline: MIN_BASELINE, decayRatio: DECAY_RATIO });
                await db.update(blogPosts)
                    .set({ trafficBaseline: newBaseline, lastMetricsAt: new Date(), updatedAt: new Date() })
                    .where(eq(blogPosts.id, post.id));

                if (!decayed || post.userId == null) continue;

                // Don't re-notify while a post stays decayed — one ticket per RENOTIFY_DAYS window.
                const since = new Date(Date.now() - RENOTIFY_DAYS * 86400000);
                const recent = await db
                    .select({ metadata: notifications.metadata })
                    .from(notifications)
                    .where(and(
                        eq(notifications.userId, post.userId),
                        eq(notifications.type, 'blog_content_decay'),
                        gte(notifications.createdAt, since),
                    ));
                const already = recent.some((r) => r.metadata && (r.metadata as { blogPostId?: number }).blogPostId === post.id);
                if (already) continue;

                await db.insert(notifications).values({
                    userId: post.userId,
                    type: 'blog_content_decay',
                    title: `Traffic dropping: “${post.title}”`,
                    message: `Search impressions for “${post.title}” have fallen to ${current} from a peak of ${peak}. Consider refreshing the post to recover its ranking.`,
                    metadata: { blogPostId: post.id, canonicalUrl: url, current, baseline: peak, property },
                });
                flagged++;
            }
        } catch (err) {
            // IntegrationError = not connected / needs reconnect → skip this org quietly.
            if (!(err instanceof IntegrationError)) console.error('[ingest-gsc-metrics] org', organisationId, err);
        }
    }

    return { statusCode: 200, body: JSON.stringify({ orgs: integrations.length, checked, flagged }) };
};
