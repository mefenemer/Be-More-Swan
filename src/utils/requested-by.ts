// src/utils/requested-by.ts
// "Requested by [assistant]": which colleague asked for a piece of work.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every Review card says who WROTE the work ("Created by Marvin"). Now that assistants brief each
// other, the owner also wants to see who ASKED for it (owner, 2026-10-23) — so a card can carry two
// pills: "Created by Marvin" and "Requested by Lyra".
//
// Two ways one assistant asks another for work today, and both are already recorded:
//   1. A Campaign Assistant ORDER (campaign_orders). The order is the request; the campaign it
//      belongs to names the Campaign Assistant (campaigns.ai_assistant_id). Work traces back to it
//      through content_generation_jobs.campaign_order_id (social posts and blog articles) or its own
//      campaign_order_id column (newsletter_issues, visual_briefs).
//   2. An Orchestrations HAND-OFF (orchestration_runs) — social drafts only, looked up by job id in
//      get-social-drafts.ts, which already did this for its "Hand-off from" pill.
//   3. A Business Mentor POST REQUEST (mentor_outcomes.job_id, db/z-business-mentor-phase-3.sql): the
//      user accepted the Mentor's suggestion to ask a Social Media assistant for a post, and the job that
//      drafted it is linked to that suggestion (generate-post.ts → mentor-outcomes.ts linkOutcomeJob). The
//      pill names the Mentor. A missing table is a missing pill.
// No schema change for the first two: these are lookups over columns that exist.
//
// The name is the assistant's CURRENT name (renames show through). A deleted Campaign Assistant
// leaves no pill rather than a wrong one. Never throws — a failed lookup is a missing pill.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, campaignOrders, campaigns, contentGenerationJobs, mentorOutcomes, mentorProposals, orchestrationRuns } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** campaign_orders.id → the name of the Campaign Assistant that placed it. */
export async function requesterNamesForOrders(db: Db, organisationId: number, orderIds: Array<number | null | undefined>): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const ids = [...new Set(orderIds.filter((n): n is number => Number.isInteger(n) && (n as number) > 0))];
    if (!ids.length) return out;
    try {
        const rows = await db
            .select({ orderId: campaignOrders.id, name: aiAssistants.name })
            .from(campaignOrders)
            .innerJoin(campaigns, eq(campaigns.id, campaignOrders.campaignId))
            .innerJoin(aiAssistants, eq(aiAssistants.id, campaigns.aiAssistantId))
            .where(and(eq(campaignOrders.organisationId, organisationId), inArray(campaignOrders.id, ids)));
        for (const r of rows) if (r.name) out.set(r.orderId, r.name);
    } catch (err) {
        console.warn('[requested-by] order lookup skipped:', err instanceof Error ? err.message : err);
    }
    return out;
}

/**
 * content_generation_jobs.job_id → requester name, for social posts (scheduled_posts.job_id): a
 * Campaign Assistant order on the job, else the assistant whose Orchestrations hand-off queued it.
 */
export async function requesterNamesForJobIds(db: Db, organisationId: number, jobIds: Array<string | null | undefined>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(jobIds.filter((j): j is string => typeof j === 'string' && j.length > 0))];
    if (!ids.length) return out;
    try {
        const jobs = await db
            .select({ jobId: contentGenerationJobs.jobId, orderId: contentGenerationJobs.campaignOrderId })
            .from(contentGenerationJobs)
            .where(and(
                eq(contentGenerationJobs.organisationId, organisationId),
                inArray(contentGenerationJobs.jobId, ids),
                isNotNull(contentGenerationJobs.campaignOrderId),
            ));
        const names = await requesterNamesForOrders(db, organisationId, jobs.map((j) => j.orderId));
        for (const j of jobs) {
            const name = j.orderId != null ? names.get(j.orderId) : undefined;
            if (name) out.set(j.jobId, name);
        }
        const handoffs = await db
            .select({ jobId: orchestrationRuns.targetJobId, name: aiAssistants.name })
            .from(orchestrationRuns)
            .innerJoin(aiAssistants, eq(aiAssistants.id, orchestrationRuns.sourceAssistantId))
            .where(and(eq(orchestrationRuns.organisationId, organisationId), inArray(orchestrationRuns.targetJobId, ids)));
        for (const h of handoffs) if (h.jobId && h.name && !out.has(h.jobId)) out.set(h.jobId, h.name);
    } catch (err) {
        console.warn('[requested-by] job lookup skipped:', err instanceof Error ? err.message : err);
    }
    for (const [jobId, name] of await mentorRequesterNames(db, organisationId, ids)) if (!out.has(jobId)) out.set(jobId, name);
    return out;
}

/** content_generation_jobs.job_id → the Business Mentor's name, for posts it asked for (mentor_outcomes.job_id). */
export async function mentorRequesterNames(db: Db, organisationId: number, jobIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!jobIds.length) return out;
    try {
        const rows = await db
            .select({ jobId: mentorOutcomes.jobId, name: aiAssistants.name })
            .from(mentorOutcomes)
            .innerJoin(mentorProposals, eq(mentorProposals.id, mentorOutcomes.proposalId))
            .innerJoin(aiAssistants, eq(aiAssistants.id, mentorProposals.aiAssistantId))
            .where(and(eq(mentorOutcomes.organisationId, organisationId), inArray(mentorOutcomes.jobId, jobIds)));
        for (const r of rows) if (r.jobId && r.name) out.set(r.jobId, r.name);
    } catch (err) {
        // The table is applied by hand (db/z-business-mentor-phase-3.sql); before that there's no pill.
        const code = (err as any)?.code ?? (err as any)?.cause?.code;
        if (code !== '42P01') console.warn('[requested-by] mentor lookup skipped:', err instanceof Error ? err.message : err);
    }
    return out;
}

/** blog_posts.id → requester name, through the job that drafted the article. */
export async function requesterNamesForBlogPosts(db: Db, organisationId: number, blogPostIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const ids = [...new Set(blogPostIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return out;
    try {
        const jobs = await db
            .select({ postId: contentGenerationJobs.resultBlogPostId, orderId: contentGenerationJobs.campaignOrderId })
            .from(contentGenerationJobs)
            .where(and(
                eq(contentGenerationJobs.organisationId, organisationId),
                inArray(contentGenerationJobs.resultBlogPostId, ids),
                isNotNull(contentGenerationJobs.campaignOrderId),
            ));
        const names = await requesterNamesForOrders(db, organisationId, jobs.map((j) => j.orderId));
        for (const j of jobs) {
            const name = j.orderId != null ? names.get(j.orderId) : undefined;
            if (name && j.postId != null) out.set(j.postId, name);
        }
    } catch (err) {
        console.warn('[requested-by] blog lookup skipped:', err instanceof Error ? err.message : err);
    }
    return out;
}
