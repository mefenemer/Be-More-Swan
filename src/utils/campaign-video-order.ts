// src/utils/campaign-video-order.ts
// A campaign commissions a video from the Video Producer — the `commission_video` order
// (docs/video-producer-plan.md Phase 7; the twin of campaign-visual-order.ts).
//
//   placed     → the executor starts ONE video project (origin 'campaign'), linked to the campaign and
//                the order. Planning its storyboard is free and starts at once. Making the video spends
//                AI credits, so it waits for the user's "Make the video" on the Videos tab — the click
//                where the cost is shown. Approving the campaign plan is never that click.
//   in review  → the storyboard waits for that click, or the finished video waits in the Review Queue.
//   delivered  → the finished video was approved (booked or out).
//   rejected   → the user turned the finished video down, or cancelled a storyboard after something
//                was spent on it — real work they did not want.
//   failed     → refunded: the storyboard never came back, or it was cancelled before anything was made.
//
// Settled the moment the user approves or rejects the finished video (approve-post.ts, reject-post.ts →
// settleVideoOrderForPost), and by the hourly reconciler (judgeVideoOrder) as the backstop — both
// through the ONE settlement path. A project that
// stopped part-way ('failed' with a storyboard) stays in review: "Make the video" again re-uses what
// was already made, so it is not a dead order.
//
// ⚠️ Imports neither campaign-reconciler nor campaign-orders (the reconciler imports THIS module), and
// loads video-producer only inside createVideoForOrder: approve-post and reject-post import this file,
// and must not carry the whole video pipeline (fal, speech, Pexels) to approve an ordinary post.

import { and, eq, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, campaigns, scheduledPosts, videoProjects } from '../../db/schema';
import { VIDEO_ORDER_LENGTHS } from '../config/campaign-vocab';

type Db = ReturnType<typeof getDb>;

export type VideoVerdict =
    | { kind: 'pending' }
    | { kind: 'in_review' | 'delivered' | 'rejected' | 'failed'; summary: string };


/**
 * The brief the order asks for. Its words come from the order (`videoMessage`, `angle`, `cta`), and
 * otherwise from the campaign: the objective is what the video is for, its tone how it sounds. What
 * neither says (voice, length, sources) comes from the Video Producer's own setup. Pure.
 */
export function videoBriefForOrder(order: Record<string, unknown>, campaign: { objective: string; tone: string | null }): Record<string, unknown> {
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const say = text(order.videoMessage) || text(order.angle) || campaign.objective;
    const tone = text(campaign.tone);
    return {
        purpose: 'promo',
        message: `${say}${tone ? ` Tone: ${tone}.` : ''}`.slice(0, 1200),
        ...(text(order.cta) ? { cta: text(order.cta) } : {}),
        ...((VIDEO_ORDER_LENGTHS as readonly string[]).includes(String(order.videoLength)) ? { lengthS: Number(order.videoLength) } : {}),
    };
}

/** Start the project the order asks for. Free — it plans; it never makes. */
export async function createVideoForOrder(db: Db, ctx: {
    organisationId: number; campaignId: number; targetAssistantId: number; brief: Record<string, unknown>;
}, orderId: number): Promise<{ ok: true; projectId: number } | { ok: false; message: string }> {
    const [[campaign], [producer]] = await Promise.all([
        db.select({ objective: campaigns.objective, tone: campaigns.tone }).from(campaigns)
            .where(and(eq(campaigns.id, ctx.campaignId), eq(campaigns.organisationId, ctx.organisationId))).limit(1),
        db.select({ onboardingContext: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, ctx.targetAssistantId), eq(aiAssistants.organisationId, ctx.organisationId))).limit(1),
    ]);
    if (!campaign) return { ok: false, message: 'The campaign could not be found.' };
    if (!producer) return { ok: false, message: 'The Video Producer could not be found.' };
    const { startProject } = await import('./video-producer');
    const started = await startProject(db, {
        organisationId: ctx.organisationId, assistantId: ctx.targetAssistantId, createdBy: null,
        brief: videoBriefForOrder(ctx.brief, campaign), onboardingContext: producer.onboardingContext,
        origin: 'campaign', campaignId: ctx.campaignId, campaignOrderId: orderId,
    });
    if (!started.ok) return { ok: false, message: `The Video Producer could not be briefed: ${started.error}` };
    return { ok: true, projectId: started.row.id };
}

/** Post statuses that mean the user approved the finished video. */
const APPROVED = new Set(['approved', 'scheduled', 'publishing', 'published']);
const TURNED_DOWN = new Set(['rejected', 'cancelled']);

/**
 * Judge one video order from its project, and the finished post once there is one. Pure in its
 * decisions: `judgeVideoProject` takes the rows, this reads them.
 */
export function judgeVideoProject(
    project: { status: string; storyboard: unknown; creditsSpent: number; scheduledPostId: number | null; note: string | null } | null,
    postStatuses: string[],
): VideoVerdict {
    if (!project) return { kind: 'rejected', summary: 'The video no longer exists' };
    switch (project.status) {
        case 'draft':
        case 'planning':
            return { kind: 'pending' };
        case 'planned':
            return { kind: 'in_review', summary: 'Storyboard ready — check it and press "Make the video" on the Video Producer\'s Videos tab' };
        case 'building':
            return { kind: 'in_review', summary: 'The Video Producer is making the video' };
        case 'failed':
            return project.storyboard
                ? { kind: 'in_review', summary: `The video stopped part-way${project.note ? ` (${project.note.slice(0, 120)})` : ''} — press "Make the video" again on the Videos tab` }
                : { kind: 'failed', summary: 'The storyboard could not be written' };
        case 'cancelled':
            return project.creditsSpent > 0 || project.scheduledPostId
                ? { kind: 'rejected', summary: 'Video cancelled on the Video Producer\'s Videos tab' }
                : { kind: 'failed', summary: 'Video cancelled before it was made' };
        case 'built': {
            if (postStatuses.some((s) => APPROVED.has(s))) return { kind: 'delivered', summary: 'Video approved and booked with your posts' };
            if (postStatuses.length && postStatuses.every((s) => TURNED_DOWN.has(s))) return { kind: 'rejected', summary: 'The finished video was turned down in the Review Queue' };
            return { kind: 'in_review', summary: 'Video made — waiting for your approval in the Review Queue' };
        }
        default:
            return { kind: 'pending' };
    }
}

export async function judgeVideoOrder(db: Db, order: { id: number; organisationId: number; artefactId: number | null }): Promise<VideoVerdict> {
    if (!order.artefactId) return { kind: 'pending' };
    const [project] = await db.select({
        status: videoProjects.status, storyboard: videoProjects.storyboard, creditsSpent: videoProjects.creditsSpent,
        scheduledPostId: videoProjects.scheduledPostId, crosspostGroupId: videoProjects.crosspostGroupId, note: videoProjects.note,
    }).from(videoProjects)
        .where(and(eq(videoProjects.id, order.artefactId), eq(videoProjects.organisationId, order.organisationId))).limit(1);
    let statuses: string[] = [];
    if (project?.status === 'built' && (project.scheduledPostId || project.crosspostGroupId)) {
        const rows = await db.select({ status: scheduledPosts.status }).from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, order.organisationId),
                project.crosspostGroupId
                    ? or(eq(scheduledPosts.crosspostGroupId, project.crosspostGroupId), eq(scheduledPosts.id, project.scheduledPostId ?? -1))!
                    : eq(scheduledPosts.id, project.scheduledPostId!),
            ));
        statuses = rows.map((r) => r.status);
    }
    return judgeVideoProject(project ?? null, statuses);
}

/**
 * Settle a campaign's video order NOW, after the user approved or rejected one of its finished posts,
 * rather than at the next hourly reconcile — so work waiting on the video is released at once. Only a
 * FINAL verdict settles. Best-effort and never throws: the decision is already saved, and the
 * reconciler settles anything this misses. The reconciler is imported LAZILY (it imports this module).
 */
export async function settleVideoOrderForPost(db: Db, organisationId: number | null | undefined, postId: number): Promise<void> {
    if (!organisationId) return;
    try {
        const [post] = await db.select({ group: scheduledPosts.crosspostGroupId }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, organisationId))).limit(1);
        if (!post) return;
        const [project] = await db.select({ id: videoProjects.id, orderId: videoProjects.campaignOrderId }).from(videoProjects)
            .where(and(
                eq(videoProjects.organisationId, organisationId),
                post.group ? or(eq(videoProjects.scheduledPostId, postId), eq(videoProjects.crosspostGroupId, post.group))! : eq(videoProjects.scheduledPostId, postId),
            )).limit(1);
        if (!project?.orderId) return;
        const verdict = await judgeVideoOrder(db, { id: project.orderId, organisationId, artefactId: project.id });
        if (verdict.kind !== 'delivered' && verdict.kind !== 'rejected' && verdict.kind !== 'failed') return;
        const { settleOrderNow } = await import('./campaign-reconciler');
        await settleOrderNow(db, project.orderId, { kind: verdict.kind, summary: verdict.summary });
    } catch (err) {
        console.error('[campaign-video-order] settle failed — the hourly reconcile will retry:', postId, err instanceof Error ? err.message : err);
    }
}
