// src/utils/campaign-outcomes.ts
// How far ONE campaign has got towards its own target, in its own unit. Plan §9.6.
//
// ── The hole this fills ─────────────────────────────────────────────────────────────────────────
// Every campaign has carried `outcome_metric` and `target_value` since Phase 1 — "aiming for 500
// new leads" — and nothing ever counted progress against them. The KPI cards add posts, articles
// and leads across ALL campaigns regardless of what each was for, `replies` was counted nowhere,
// and the directive's pace stayed 'unknown' for want of a number. A target with no counter is the
// SMART Goals failure again: a progress bar wired to nothing.
//
// ── Rules ───────────────────────────────────────────────────────────────────────────────────────
// 1. Every figure is a COUNT or SUM over rows that trace back to THIS campaign — through its
//    orders (posts, articles, searches) or its tracked links (clicks, signups). Nothing is
//    attributed by date overlap: a lead found by a hand-built search during the flight is not this
//    campaign's lead, and counting it would make every campaign look like it worked.
// 2. `null` means NOT KNOWABLE, never zero (campaign-funnel.ts's rule). An unavailable metric
//    returns null and the row says so; it never reads "0 of 500".
// 3. Lifetime of the campaign, not a rolling window (roi-hero-defaults-all-time).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { UNAVAILABLE_OUTCOME_METRICS, type CampaignOutcomeMetric } from '../config/campaign-vocab';

type Db = ReturnType<typeof getDb>;

/** The saved searches this campaign's orders created or tightened, de-duplicated. */
const campaignSearches = (campaignId: number, orgId: number) => sql`
    SELECT DISTINCT o.artefact_id FROM campaign_orders o
     WHERE o.campaign_id = ${campaignId} AND o.organisation_id = ${orgId}
       AND o.artefact_kind = 'discovery_campaign' AND o.artefact_id IS NOT NULL`;

/** The posts this campaign's orders produced. */
const campaignPosts = (campaignId: number, orgId: number) => sql`
    SELECT DISTINCT j.result_post_id FROM content_generation_jobs j
      JOIN campaign_orders o ON o.id = j.campaign_order_id
     WHERE o.campaign_id = ${campaignId} AND o.organisation_id = ${orgId}
       AND j.result_post_id IS NOT NULL`;

/**
 * The query for each countable metric. Every one is scoped by organisation as well as campaign —
 * the campaign id is caller-supplied in some paths and the org match is the IDOR guard.
 */
function outcomeQuery(metric: CampaignOutcomeMetric, campaignId: number, orgId: number) {
    switch (metric) {
        case 'leads':
            // DISTINCT because one search can be the artefact of two orders (run, then narrowed).
            return sql`SELECT count(DISTINCT l.id)::int AS n FROM discovered_leads l
                        WHERE l.organisation_id = ${orgId}
                          AND l.campaign_id IN (${campaignSearches(campaignId, orgId)})`;
        case 'replies':
            // A thread with ANY inbound message is a reply. Counted per thread, not per message:
            // one prospect writing three times is one reply to the campaign.
            return sql`SELECT count(DISTINCT t.id)::int AS n FROM lead_threads t
                         JOIN discovered_leads l ON l.id = t.discovered_lead_id
                        WHERE t.organisation_id = ${orgId}
                          AND t.last_inbound_at IS NOT NULL
                          AND l.campaign_id IN (${campaignSearches(campaignId, orgId)})`;
        case 'signups':
            return sql`SELECT count(DISTINCT a.subject_id)::int AS n FROM campaign_attributions a
                        WHERE a.campaign_id = ${campaignId} AND a.organisation_id = ${orgId}
                          AND a.subject_type = 'audience_contact'`;
        case 'published_content':
            return sql`SELECT (
                         (SELECT count(*) FROM scheduled_posts p
                           WHERE p.organisation_id = ${orgId} AND p.status = 'published'
                             AND p.id IN (${campaignPosts(campaignId, orgId)}))
                       + (SELECT count(DISTINCT b.id) FROM content_generation_jobs j
                            JOIN campaign_orders o ON o.id = j.campaign_order_id
                            JOIN blog_posts b ON b.id = j.result_blog_post_id
                           WHERE o.campaign_id = ${campaignId} AND o.organisation_id = ${orgId}
                             AND b.status = 'published')
                       )::int AS n`;
        case 'engagement':
            // total_interactions, not reach: reach is null on several platforms (post_insights
            // documents it), so a reach sum would silently undercount and read as a weak campaign.
            return sql`SELECT coalesce(sum(pi.total_interactions), 0)::int AS n FROM post_insights pi
                        WHERE pi.organisation_id = ${orgId}
                          AND pi.scheduled_post_id IN (${campaignPosts(campaignId, orgId)})`;
        case 'email_engagement':
            // DISTINCT PEOPLE who opened or clicked any email this campaign's orders drafted —
            // one-off draft emails (newsletter_sends) and form follow-ups (newsletter_sequence_sends).
            // People, not opens: one reader opening four emails is one engaged person.
            // ⚠️ Only positive signals are counted. Opens cannot be seen at all from a tenant's own
            // mailbox (engagement_tracked = false), so this undercounts there; it can never
            // overcount, and "unopened" is never inferred from a missing open.
            return sql`SELECT count(DISTINCT lower(x.email))::int AS n FROM (
                         SELECT s.email FROM newsletter_sends s
                           JOIN newsletter_issues i ON i.id = s.issue_id
                           JOIN campaign_orders o ON o.id = i.campaign_order_id
                          WHERE o.campaign_id = ${campaignId} AND o.organisation_id = ${orgId}
                            AND s.organisation_id = ${orgId}
                            AND (s.opened_at IS NOT NULL OR s.clicked_at IS NOT NULL)
                         UNION ALL
                         SELECT ss.email FROM newsletter_sequence_sends ss
                           JOIN newsletter_sequences q ON q.id = ss.sequence_id
                           JOIN campaign_orders o ON o.id = q.campaign_order_id
                          WHERE o.campaign_id = ${campaignId} AND o.organisation_id = ${orgId}
                            AND ss.organisation_id = ${orgId}
                            AND (ss.opened_at IS NOT NULL OR ss.clicked_at IS NOT NULL)
                       ) x WHERE x.email IS NOT NULL`;
        case 'clicks':
            return sql`SELECT count(*)::int AS n FROM campaign_click_events e
                        WHERE e.campaign_id = ${campaignId} AND e.organisation_id = ${orgId}
                          AND NOT e.is_probable_bot`;
        default:
            return null;
    }
}

/** Progress for one campaign in its own unit, or null when the metric cannot be counted. */
export async function countCampaignOutcome(
    db: Db, campaign: { id: number; organisationId: number }, metric: string,
): Promise<number | null> {
    if (UNAVAILABLE_OUTCOME_METRICS.includes(metric as CampaignOutcomeMetric)) return null;
    const q = outcomeQuery(metric as CampaignOutcomeMetric, campaign.id, campaign.organisationId);
    if (!q) return null;
    try {
        const [first] = await db.execute<{ n: number }>(q);
        return Number(first?.n ?? 0);
    } catch (err) {
        // A failed count is unknown, not zero. "0 of 500" from a broken query would tell the user
        // their campaign is failing when we simply could not look.
        console.error('[campaign-outcomes] count failed', { campaignId: campaign.id, metric, err });
        return null;
    }
}
