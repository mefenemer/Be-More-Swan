// netlify/functions/get-campaign-funnel.ts
// GET ?id=<assistantId>
// Feeds the Campaign Assistant's ROI funnel: spend → clicks → conversions → revenue won.
//
// The arithmetic lives in src/utils/campaign-funnel.ts; this file is the queries, the tenant guard
// and the attribution joins. Same split, and the same reasons, as get-campaign-performance.ts.
//
// ── Lifetime, never windowed ────────────────────────────────────────────────────────────────────
// No `days` parameter, deliberately. A 30-day window across a six-week flight cliff-drops at
// rollover and reports a collapse in performance that is really an artefact of the window
// (roi-hero-defaults-all-time cost us this once already). A campaign's numbers are its own.
//
// ── Where each figure comes from ────────────────────────────────────────────────────────────────
//   spend        campaign_spend_events, currency='money' (always 0 today) and 'work'
//   clicks       campaign_click_events, is_probable_bot split out rather than filtered away
//   conversions  campaign_attributions, grouped by subject_type
//   revenue      revenue_events ⋈ campaign_attributions on discovered_lead_id
//
// ⚠️ THE REVENUE JOIN ONLY EXISTS FOR ONE SUBJECT TYPE. revenue_events keys on
// `discovered_lead_id`, so an audience contact attributed to a campaign has no revenue path at
// all — not a zero, no path. `revenueTrackableSubjects` carries that fact through to the payload
// so the surface can say "not tracked" instead of "£0", which are very different sentences to put
// in front of someone deciding whether to keep spending.

import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import {
    aiAssistants, audienceContacts, campaignAttributions, campaignClickEvents, campaignLinks,
    campaignSpendEvents, campaigns, revenueEvents,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    buildCampaignFunnel, emptyCampaignFunnel, type CampaignFunnelCounts,
} from '../../src/utils/campaign-funnel';
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
        // IDOR guard. The campaign tables carry no RLS policy by design (the app connects as table
        // owner, so a policy would never evaluate — see the foot of db/campaigns.sql), which makes
        // this check and the organisation_id filters below the whole of the isolation story.
        const [assistant] = await withTenant(orgId, (tx) =>
            tx.select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
                .limit(1));
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found' }) };

        const campaignRows = await db
            .select({ id: campaigns.id })
            .from(campaigns)
            .where(and(eq(campaigns.organisationId, orgId), eq(campaigns.aiAssistantId, aId)));
        const ids = campaignRows.map((r) => r.id);

        // ⚠️ Every query below uses inArray(ids). An empty array is not a harmless no-op here —
        // drizzle renders it as an `in ()` that Postgres rejects — so the no-campaigns case returns
        // its own shape before any of them run. That is also the honest answer: an assistant with
        // no campaigns has not measured zero, it has measured nothing.
        if (ids.length === 0) return json(emptyCampaignFunnel());

        // ── Clicks. The bot split is preserved, not filtered away, all the way to the payload.
        // ⚠️ ::int on every count — postgres-js returns a bigint count as a STRING, and a string
        // reaching the client makes "12" + 1 into "121" in any arithmetic the UI does.
        const [clickRow] = await db
            .select({
                clicks: sql<number>`count(*) FILTER (WHERE ${campaignClickEvents.isProbableBot} = false)::int`,
                botClicks: sql<number>`count(*) FILTER (WHERE ${campaignClickEvents.isProbableBot})::int`,
                firstClickAt: sql<Date | null>`min(${campaignClickEvents.occurredAt})`,
            })
            .from(campaignClickEvents)
            .where(inArray(campaignClickEvents.campaignId, ids));

        const [linkRow] = await db
            .select({ active: sql<number>`count(*) FILTER (WHERE ${campaignLinks.archivedAt} IS NULL)::int` })
            .from(campaignLinks)
            .where(inArray(campaignLinks.campaignId, ids));

        // ── Conversions, grouped by what the person became.
        const attributionRows = await db
            .select({
                subjectType: campaignAttributions.subjectType,
                n: sql<number>`count(*)::int`,
            })
            .from(campaignAttributions)
            .where(inArray(campaignAttributions.campaignId, ids))
            .groupBy(campaignAttributions.subjectType);
        const attributedBy = new Map(attributionRows.map((r) => [r.subjectType, r.n]));
        const leadsAttributed = attributedBy.get('discovered_lead') ?? 0;

        // ── Revenue. Only reachable for discovered_lead subjects; see the header.
        const revenueRows = leadsAttributed > 0
            ? await db
                .select({
                    outcome: revenueEvents.outcome,
                    n: sql<number>`count(*)::int`,
                    // ⚠️ numeric comes back from postgres-js as a STRING. Cast so the sum arrives
                    // as a number rather than as something that concatenates.
                    value: sql<number>`coalesce(sum(${revenueEvents.valueGbp}), 0)::float8`,
                })
                .from(revenueEvents)
                .innerJoin(campaignAttributions, and(
                    eq(campaignAttributions.subjectId, revenueEvents.discoveredLeadId),
                    eq(campaignAttributions.subjectType, 'discovered_lead'),
                ))
                .where(and(
                    eq(revenueEvents.organisationId, orgId),
                    inArray(campaignAttributions.campaignId, ids),
                    isNotNull(revenueEvents.outcome),
                ))
                .groupBy(revenueEvents.outcome)
            : [];
        const won = revenueRows.find((r) => r.outcome === 'won');
        const lost = revenueRows.find((r) => r.outcome === 'lost');

        // ── Spend, both currencies. Signed sums: a cancelled order's refund is already netted off.
        const spendRows = await db
            .select({
                currency: campaignSpendEvents.currency,
                total: sql<number>`coalesce(sum(${campaignSpendEvents.amount}), 0)::float8`,
            })
            .from(campaignSpendEvents)
            .where(inArray(campaignSpendEvents.campaignId, ids))
            .groupBy(campaignSpendEvents.currency);
        const spendBy = new Map(spendRows.map((r) => [r.currency, r.total]));

        // ── The blind spot, measured rather than assumed.
        //
        // Definition, stated because any definition here is a choice: sign-ups this workspace
        // received SINCE ITS FIRST TRACKED CLICK that carry no attribution row. Before that first
        // click there was no tracking in place, so counting earlier contacts would report a
        // "failure to attribute" for a period when nothing could have been attributed — and every
        // workspace would open this surface to a large, permanent, meaningless number.
        const firstClickAt = clickRow?.firstClickAt ? new Date(clickRow.firstClickAt) : null;
        const [unattributedRow] = firstClickAt
            ? await db
                .select({ n: sql<number>`count(*)::int` })
                .from(audienceContacts)
                .where(and(
                    eq(audienceContacts.organisationId, orgId),
                    gte(audienceContacts.createdAt, firstClickAt),
                    sql`NOT EXISTS (
                        SELECT 1 FROM campaign_attributions ca
                        WHERE ca.subject_type = 'audience_contact'
                          AND ca.subject_id = ${audienceContacts.id}
                    )`,
                ))
            : [{ n: 0 }];

        const counts: CampaignFunnelCounts = {
            campaignsTotal: ids.length,
            linksActive: linkRow?.active ?? 0,
            clicks: clickRow?.clicks ?? 0,
            botClicks: clickRow?.botClicks ?? 0,
            contactsAttributed: attributedBy.get('audience_contact') ?? 0,
            leadsAttributed,
            recordsAttributed: attributedBy.get('assistant_record') ?? 0,
            unattributedConversions: unattributedRow?.n ?? 0,
            won: won?.n ?? 0,
            lost: lost?.n ?? 0,
            valueWonGbp: won?.value ?? 0,
            // Only discovered_lead subjects have a revenue path at all.
            revenueTrackableSubjects: leadsAttributed,
            workSpent: spendBy.get('work') ?? 0,
            moneySpentGbp: spendBy.get('money') ?? 0,
        };

        return json(buildCampaignFunnel(counts));
    } catch (err) {
        console.error('[get-campaign-funnel] failed', { assistantId: aId }, err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not load the funnel.' }) };
    }
});
