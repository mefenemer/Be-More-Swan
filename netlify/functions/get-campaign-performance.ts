// netlify/functions/get-campaign-performance.ts
// GET ?id=<assistantId>
// Feeds the four assistant-detail "Performance Metrics" KPI cards for the Campaign Assistant.
// The arithmetic lives in src/utils/campaign-performance.ts; this file is the queries, the tenant
// guard and the attribution joins.
//
// Deliberately SEPARATE from get-assistant-performance.ts rather than a role branch inside it.
// That endpoint answers "how did this assistant's own posts perform" off post_insights, which is a
// question the Campaign Assistant cannot have: it owns no posts. Every figure here comes from a
// different set of tables, so sharing the file would mean two disjoint queries behind one name.
//
// ── Attribution rides the campaign_order_id trace ───────────────────────────────────────────────
// A campaign's published work is reached as
//     campaign_orders → content_generation_jobs.campaign_order_id → result_post_id / result_blog_post_id
// which is the column db/campaign-order-tracing.sql added. Its leads are reached as
//     campaign_orders (artefact_kind='discovery_campaign') → discovered_leads.campaign_id
// Neither join existed before the reconciler work, which is why these cards had no data source.
//
// ── Lifetime, never windowed ────────────────────────────────────────────────────────────────────
// No `days` parameter, on purpose. See the header of src/utils/campaign-performance.ts.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import {
    aiAssistants, campaignDecisions, campaignOrders, campaignSpendEvents, campaigns,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    buildCampaignPerformance, emptyCampaignPerformance, type CampaignPerformanceCounts,
} from '../../src/utils/campaign-performance';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const rawId = event.queryStringParameters?.id;
    if (!rawId || Number.isNaN(parseInt(rawId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
    const aId = parseInt(rawId);

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const json = (body: unknown) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    try {
        // IDOR guard — same shape as get-assistant-performance.ts. The campaign tables carry no RLS
        // policy by design (the app connects as table owner, so a policy would never evaluate — see
        // the foot of db/campaigns.sql), which makes this check and the organisation_id filters
        // below the whole of the isolation story. Both are load-bearing.
        const [assistant] = await withTenant(orgId, (tx) =>
            tx.select({ id: aiAssistants.id })
              .from(aiAssistants)
              .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
              .limit(1)
        );
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        // Every campaign this assistant has ever run. Lifetime — no date filter anywhere in this
        // function.
        const campaignRows = await db
            .select({ id: campaigns.id, status: campaigns.status })
            .from(campaigns)
            .where(and(eq(campaigns.aiAssistantId, aId), eq(campaigns.organisationId, orgId)));

        if (campaignRows.length === 0) return json(emptyCampaignPerformance());

        const campaignIds = campaignRows.map((c) => c.id);

        // One round trip for the published work and the leads. Written as raw SQL because all three
        // are the same shape — count rows reachable from this campaign's orders — and expressing
        // them as three Drizzle joins would be longer and no clearer.
        //
        // ⚠️ An interpolated array inside a raw sql`` fragment binds as a ROW, not an array, and
        // fails with 42809 (drizzle-array-any-42809). Bound as a Postgres array literal via
        // sql.join, which is what the rest of this codebase does.
        const idList = sql.join(campaignIds.map((id) => sql`${id}`), sql`, `);

        const [attributed] = await db.execute<{
            posts_published: number; articles_published: number; leads_found: number;
        }>(sql`
            SELECT
              (SELECT count(*) FROM content_generation_jobs j
                 JOIN campaign_orders o ON o.id = j.campaign_order_id
                 JOIN scheduled_posts p ON p.id = j.result_post_id
                WHERE o.campaign_id IN (${idList})
                  AND o.organisation_id = ${orgId}
                  AND p.status = 'published')::int AS posts_published,
              (SELECT count(*) FROM content_generation_jobs j
                 JOIN campaign_orders o ON o.id = j.campaign_order_id
                 JOIN blog_posts b ON b.id = j.result_blog_post_id
                WHERE o.campaign_id IN (${idList})
                  AND o.organisation_id = ${orgId}
                  AND b.status = 'published')::int AS articles_published,
              (SELECT count(*) FROM discovered_leads l
                 JOIN campaign_orders o ON o.artefact_id = l.campaign_id
                WHERE o.campaign_id IN (${idList})
                  AND o.organisation_id = ${orgId}
                  AND o.artefact_kind = 'discovery_campaign')::int AS leads_found
        `);

        // The work ledger is append-only and SIGNED: a refund for an order that produced nothing is
        // a negative row, so summing gives work actually consumed without any special-casing.
        const [spend] = await db
            .select({ total: sql<string>`coalesce(sum(${campaignSpendEvents.amount}), 0)` })
            .from(campaignSpendEvents)
            .where(and(
                inArray(campaignSpendEvents.campaignId, campaignIds),
                eq(campaignSpendEvents.organisationId, orgId),
                eq(campaignSpendEvents.currency, 'work'),
            ));

        const [decisions] = await db
            .select({
                raised: sql<number>`count(*)::int`,
                approved: sql<number>`count(*) FILTER (WHERE ${campaignDecisions.status} = 'approved')::int`,
                // Expired decisions are not waiting on anybody — the sweep in the autonomous agent
                // has already settled them. Counting them here would make "Needs You" a number the
                // user can never bring down.
                pending: sql<number>`count(*) FILTER (WHERE ${campaignDecisions.status} = 'pending' AND ${campaignDecisions.expiresAt} > now())::int`,
            })
            .from(campaignDecisions)
            .where(and(
                inArray(campaignDecisions.campaignId, campaignIds),
                eq(campaignDecisions.organisationId, orgId),
            ));

        // 'in_review' means the reconciler found drafted work sitting in its assistant's approval
        // queue. Before the reconciler existed this was permanently zero, because nothing ever set
        // the status.
        const [inReview] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(campaignOrders)
            .where(and(
                inArray(campaignOrders.campaignId, campaignIds),
                eq(campaignOrders.organisationId, orgId),
                eq(campaignOrders.status, 'in_review'),
            ));

        const counts: CampaignPerformanceCounts = {
            campaignsTotal: campaignRows.length,
            campaignsLive: campaignRows.filter((c) => c.status === 'active' || c.status === 'throttled').length,
            campaignsFinished: campaignRows.filter((c) => c.status === 'finished').length,
            postsPublished: Number(attributed?.posts_published ?? 0),
            articlesPublished: Number(attributed?.articles_published ?? 0),
            leadsFound: Number(attributed?.leads_found ?? 0),
            // Never let a refund-heavy campaign report negative effort.
            workSpent: Math.max(0, Math.round(Number(spend?.total ?? 0))),
            decisionsRaised: Number(decisions?.raised ?? 0),
            decisionsApproved: Number(decisions?.approved ?? 0),
            decisionsPending: Number(decisions?.pending ?? 0),
            ordersInReview: Number(inReview?.n ?? 0),
        };

        return json(buildCampaignPerformance(counts));
    } catch (err) {
        // Unlike get-assistant-metrics, this does NOT degrade to a 200 "no activity" shape. A
        // silent zero here would tell the user their campaign produced nothing, which is a
        // different and much worse statement than "we could not load this".
        console.error('[get-campaign-performance]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not load campaign performance' }) };
    }
});
