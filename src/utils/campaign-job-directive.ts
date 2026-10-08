// src/utils/campaign-job-directive.ts
// Section 13 for ONE drafting job, built from the campaign and order that commissioned it. §9.8.
//
// ── The two holes this closes ───────────────────────────────────────────────────────────────────
// The blueprint holds ONE section 13 per assistant: the most recently started live campaign that
// briefs it, and that campaign's newest order with an angle. Every job the assistant drafts reads
// that one section. So:
//   1. A Social Media Assistant serving two campaigns drafted the OLDER campaign's posts with the
//      NEWER campaign's objective, audience, stage and tone — work commissioned for one campaign
//      written for another.
//   2. An A/B test is two angles for the same assistant at once. With one section 13 both halves
//      were drafted with the same angle, and the "test" compared a thing to itself.
// A job that knows its order (content_generation_jobs.campaign_order_id) now gets a section 13
// rebuilt from ITS campaign and ITS brief — and, for a test job, ITS variant's angle.
//
// ── Rules ───────────────────────────────────────────────────────────────────────────────────────
// • Built by the SAME directiveInputFrom the blueprint uses, so the two can never disagree about
//   what a campaign says.
// • Only for a LIVE campaign. A paused or finished campaign stops steering, exactly as the
//   blueprint drops it; the job then keeps the blueprint's section (usually none).
// • Never throws. A failed lookup leaves the blueprint's section in place — the job still drafts.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    campaignExperimentJobs, campaignExperiments, campaignOrders, campaigns, contentGenerationJobs,
} from '../../db/schema';
import { buildCampaignDirective, directiveInputFrom, type CampaignDirective } from './campaign-directive';

type Db = ReturnType<typeof getDb>;

export interface JobDirective {
    directive: CampaignDirective;
    /** Set for an A/B test job — which half it is. */
    variant: 'A' | 'B' | null;
}

export async function campaignDirectiveForJob(db: Db, jobId: number): Promise<JobDirective | null> {
    try {
        const [row] = await db.select({
            orderId: campaignOrders.id, brief: campaignOrders.brief,
            id: campaigns.id, objective: campaigns.objective, outcomeMetric: campaigns.outcomeMetric,
            endsAt: campaigns.endsAt, constraints: campaigns.constraints, audience: campaigns.audience,
            funnelStage: campaigns.funnelStage, tone: campaigns.tone, status: campaigns.status,
        }).from(contentGenerationJobs)
            .innerJoin(campaignOrders, eq(campaignOrders.id, contentGenerationJobs.campaignOrderId))
            .innerJoin(campaigns, and(
                eq(campaigns.id, campaignOrders.campaignId),
                eq(campaigns.organisationId, contentGenerationJobs.organisationId),
            ))
            .where(eq(contentGenerationJobs.id, jobId))
            .limit(1);
        if (!row) return null;
        if (row.status !== 'active' && row.status !== 'throttled') return null;

        const brief = (row.brief ?? {}) as Record<string, unknown>;

        // A test job's angle is its variant's, from the experiment — nothing else may override it.
        const [tag] = await db.select({
            variant: campaignExperimentJobs.variant, angleA: campaignExperiments.angleA, angleB: campaignExperiments.angleB,
        }).from(campaignExperimentJobs)
            .innerJoin(campaignExperiments, eq(campaignExperiments.id, campaignExperimentJobs.experimentId))
            .where(eq(campaignExperimentJobs.jobId, jobId))
            .limit(1);

        let angle: string | null = null;
        let variant: 'A' | 'B' | null = null;
        if (tag && (tag.variant === 'A' || tag.variant === 'B')) {
            variant = tag.variant;
            angle = variant === 'A' ? tag.angleA : tag.angleB;
        } else if (typeof brief.angle === 'string' && brief.angle.trim()) {
            angle = brief.angle;
        } else {
            // No angle on this order: the campaign's newest angle, which is what an "Adjust the
            // messaging" order exists to set — the same fallback the blueprint's pick gave.
            const [latest] = await db.select({ brief: campaignOrders.brief }).from(campaignOrders)
                .where(and(
                    eq(campaignOrders.campaignId, row.id),
                    inArray(campaignOrders.status, ['issued', 'in_review', 'delivered']),
                    sql`(${campaignOrders.brief} ->> 'angle') IS NOT NULL`,
                ))
                .orderBy(desc(campaignOrders.id))
                .limit(1);
            const a = (latest?.brief as Record<string, unknown> | undefined)?.angle;
            angle = typeof a === 'string' ? a : null;
        }

        const directive = buildCampaignDirective(directiveInputFrom(row, brief, angle));
        return directive ? { directive, variant } : null;
    } catch (err) {
        console.error('[campaign-job-directive] lookup failed — the blueprint section stands', { jobId, err });
        return null;
    }
}
