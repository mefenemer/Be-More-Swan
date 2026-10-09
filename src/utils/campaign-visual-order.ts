// src/utils/campaign-visual-order.ts
// A campaign commissions pictures from the Brand Designer — the `commission_visuals` order.
// Brand Designer plan, Phase 3; campaign plan §10.
//
//   placed     → the executor creates ONE brief, linked to the campaign and the order
//                (origin 'campaign'). If every source it allows is free (stock, branded cards) the
//                first round starts at once; a brief with AI images waits for the user's click on
//                the Briefs tab, because that click is where an AI credit is shown and spent.
//   approved   → the picture joins the campaign's own pictures (campaign_assets, §9.3) — which the
//                posts it commissions use first — and the order is DELIVERED, releasing anything
//                that was waiting for it ("hold the posts until the pictures are ready").
//   cancelled  → rejected (the designer did the work, the user did not want it), or failed and
//                refunded if not one option was ever made.
//
// Settled the moment the user decides (visual-briefs.ts → settleVisualOrder), and again by the
// hourly reconciler as the backstop (judgeVisualOrder), through the ONE settlement path.
//
// ⚠️ Imports neither campaign-reconciler nor visual-briefs: the reconciler imports THIS module, and
// visual-briefs reaches the reconciler lazily. The settle function is passed in, as campaign-tickets
// does, so no cycle can form.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, campaignAssets, campaigns, visualBriefOptions, visualBriefs } from '../../db/schema';
import { MAX_CAMPAIGN_ASSETS } from '../config/campaign-creative';
import { BRIEF_ASPECT_RATIOS, BRIEF_PURPOSES, normaliseBrief, sourcesAreFree } from '../config/visual-brief-vocab';

type Db = ReturnType<typeof getDb>;

export type VisualVerdict =
    | { kind: 'pending' }
    | { kind: 'in_review' | 'delivered' | 'rejected' | 'failed'; summary: string };

/** The setup answer that picks a new brief's default sources — the same rule the Briefs tab uses. */
function defaultSources(onboardingContext: unknown): string[] {
    const v = onboardingContext && typeof onboardingContext === 'object' ? (onboardingContext as Record<string, unknown>).defaultSources : null;
    return v === 'free_only' ? ['stock', 'brand_card'] : ['stock', 'ai_image', 'brand_card'];
}

/**
 * Build the brief the order asks for. Its words come from the order (`show`, `headline`), and
 * otherwise from the campaign: the objective is what the picture is for, and the campaign's tone
 * is its mood. Sources come from the order, else from the Brand Designer's own setup.
 */
export async function createBriefForOrder(db: Db, ctx: {
    organisationId: number; campaignId: number; targetAssistantId: number; brief: Record<string, unknown>;
}, orderId: number): Promise<{ ok: true; briefId: number; allFree: boolean } | { ok: false; message: string }> {
    const [[campaign], [designer]] = await Promise.all([
        db.select({ objective: campaigns.objective, tone: campaigns.tone }).from(campaigns)
            .where(and(eq(campaigns.id, ctx.campaignId), eq(campaigns.organisationId, ctx.organisationId))).limit(1),
        db.select({ onboardingContext: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, ctx.targetAssistantId), eq(aiAssistants.organisationId, ctx.organisationId))).limit(1),
    ]);
    if (!campaign) return { ok: false, message: 'The campaign could not be found.' };

    const b = ctx.brief;
    const show = typeof b.show === 'string' ? b.show : null;
    const n = normaliseBrief({
        title: `For the campaign: ${campaign.objective}`.slice(0, 120),
        message: show || (typeof b.angle === 'string' ? b.angle : null) || campaign.objective,
        headline: b.headline,
        mood: campaign.tone,
        mustAvoid: b.mustAvoid,
        purpose: b.purpose,
        aspectRatio: b.aspectRatio,
        sources: Array.isArray(b.sources) && b.sources.length ? b.sources : defaultSources(designer?.onboardingContext),
        dueDate: b.dueDate,
    });
    if (!n.ok) return { ok: false, message: `The Brand Designer could not be briefed: ${n.error}` };

    const [row] = await db.insert(visualBriefs).values({
        organisationId: ctx.organisationId, aiAssistantId: ctx.targetAssistantId, createdBy: null,
        ...n.brief, origin: 'campaign', campaignId: ctx.campaignId, campaignOrderId: orderId,
    }).returning({ id: visualBriefs.id });
    return { ok: true, briefId: row.id, allFree: sourcesAreFree(n.brief.sources) };
}

/**
 * Put every approved picture of this brief into the campaign's own pictures. Idempotent (the pair is
 * unique) and capped at MAX_CAMPAIGN_ASSETS, like the Pictures panel's own attach. Returns how many
 * of the brief's approved pictures the campaign now holds.
 */
export async function attachApprovedToCampaign(db: Db, args: { organisationId: number; campaignId: number; briefId: number }): Promise<number> {
    const approved = await db.select({ assetId: visualBriefOptions.contentAssetId }).from(visualBriefOptions)
        .where(and(
            eq(visualBriefOptions.briefId, args.briefId),
            eq(visualBriefOptions.organisationId, args.organisationId),
            eq(visualBriefOptions.status, 'approved'),
            isNotNull(visualBriefOptions.contentAssetId),
        ));
    const ids = approved.map((r) => r.assetId!).filter(Boolean);
    if (!ids.length) return 0;
    const already = await db.select({ assetId: campaignAssets.contentAssetId }).from(campaignAssets)
        .where(and(eq(campaignAssets.campaignId, args.campaignId), inArray(campaignAssets.contentAssetId, ids)));
    const have = new Set(already.map((r) => r.assetId));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) {
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(campaignAssets).where(eq(campaignAssets.campaignId, args.campaignId));
        const take = missing.slice(0, Math.max(0, MAX_CAMPAIGN_ASSETS - Number(n)));
        if (take.length) {
            await db.insert(campaignAssets)
                .values(take.map((contentAssetId) => ({ organisationId: args.organisationId, campaignId: args.campaignId, contentAssetId, createdBy: null })))
                .onConflictDoNothing();
        }
        return have.size + take.length;
    }
    return have.size;
}

/**
 * Judge one picture order from its brief. Also attaches approved pictures to the campaign, so the
 * hourly run repairs a settle that happened while the attach failed.
 */
export async function judgeVisualOrder(db: Db, order: { id: number; organisationId: number; campaignId: number; artefactId: number | null }): Promise<VisualVerdict> {
    if (!order.artefactId) return { kind: 'pending' };
    const [brief] = await db.select({ id: visualBriefs.id, status: visualBriefs.status, rounds: visualBriefs.rounds })
        .from(visualBriefs).where(and(eq(visualBriefs.id, order.artefactId), eq(visualBriefs.organisationId, order.organisationId))).limit(1);
    if (!brief) return { kind: 'rejected', summary: 'The brief no longer exists' };
    const counts = await db.select({ status: visualBriefOptions.status, n: sql<number>`count(*)::int` })
        .from(visualBriefOptions).where(eq(visualBriefOptions.briefId, brief.id)).groupBy(visualBriefOptions.status);
    const count = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);

    if (count('approved') > 0) {
        const n = await attachApprovedToCampaign(db, { organisationId: order.organisationId, campaignId: order.campaignId, briefId: brief.id });
        return { kind: 'delivered', summary: `${n} picture${n === 1 ? '' : 's'} approved — added to this campaign's pictures` };
    }
    if (brief.status === 'cancelled') {
        // Nothing was ever made: the commission produced nothing, so it is refunded. Otherwise the
        // designer did the work and the user turned it down — real capacity, not refunded.
        return brief.rounds === 0
            ? { kind: 'failed', summary: 'Brief cancelled before any options were made' }
            : { kind: 'rejected', summary: 'Brief cancelled on the Brand Designer\'s Briefs tab' };
    }
    const waiting = count('proposed');
    if (waiting > 0) return { kind: 'in_review', summary: `${waiting} option${waiting === 1 ? '' : 's'} waiting on the Brand Designer's Briefs tab` };
    if (brief.status === 'open' && brief.rounds === 0) return { kind: 'in_review', summary: 'Waiting for you to press "Make options" on the Brand Designer\'s Briefs tab' };
    return { kind: 'pending' };
}

/**
 * Settle a picture order NOW, after the user decided on its brief. Only a FINAL verdict settles
 * (delivered / rejected / failed); anything else is left for the next decision or the hourly run.
 * `settle` is the reconciler's settleOrderNow, passed in to keep this module free of a cycle.
 */
export async function settleVisualOrder(
    db: Db, briefId: number,
    settle: (db: Db, orderId: number, verdict: { kind: 'delivered' | 'rejected' | 'failed'; summary: string }) => Promise<boolean>,
): Promise<void> {
    const [brief] = await db.select({ orderId: visualBriefs.campaignOrderId, campaignId: visualBriefs.campaignId, organisationId: visualBriefs.organisationId })
        .from(visualBriefs).where(eq(visualBriefs.id, briefId)).limit(1);
    if (!brief?.orderId || !brief.campaignId) return;
    const verdict = await judgeVisualOrder(db, { id: brief.orderId, organisationId: brief.organisationId, campaignId: brief.campaignId, artefactId: briefId });
    if (verdict.kind === 'delivered' || verdict.kind === 'rejected' || verdict.kind === 'failed') {
        await settle(db, brief.orderId, { kind: verdict.kind, summary: verdict.summary });
    }
}

/** Brief fields a plan may carry for this order (campaign-plan.ts reads these). */
export const VISUAL_BRIEF_ENUMS = { purpose: BRIEF_PURPOSES, aspectRatio: BRIEF_ASPECT_RATIOS } as const;
