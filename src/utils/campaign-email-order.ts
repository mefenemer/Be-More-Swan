// src/utils/campaign-email-order.ts
// A campaign briefs the Email Marketing Assistant. docs/campaign-orchestrator-plan.md §9.7.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// "If a lead capture form works, what nurtures that lead?" — the marketing review. The product
// already has the answer (the Email Marketing Assistant writes email campaigns, and a form can
// start one), but a campaign could not ask for one: the five order actions were social, blog and
// lead search only. This is the sixth, and it reuses the Email Studio's own generator
// (newsletter-campaign-generate.ts) so an email a campaign commissions is written, checked and
// stored exactly like one a person asked for in the Studio.
//
// ── Why the drafting is a BACKGROUND job ────────────────────────────────────────────────────────
// The generator makes one model call per email. Approving a plan places every order in one HTTP
// request, which Netlify cuts off at ~26s — a plan with posts, a pillar and four emails would die
// half-placed. So the executor only records the order and wakes
// `draft-campaign-emails-background`; the worker drafts and saves. If the wake-up is lost, the
// hourly reconciler re-sends it (`findStrandedEmailOrders`). The order row IS the job: no queue
// table, and a claim stamp on the brief stops two workers drafting the same campaign twice.
//
// ── What it may never do ────────────────────────────────────────────────────────────────────────
// SEND. A form follow-up is saved as a sequence with is_enabled = false (the column default — and
// never set here); a send-it-yourself campaign is saved as draft emails. Turning either on is a
// human act in Email Studio, owner/admin only, exactly as for a campaign the user wrote themselves.
// The orchestrator commissions work; it never reaches a stranger's inbox on its own.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, campaignOrders, campaigns, newsletterIssues, newsletterSequenceSteps,
    newsletterSequences, organisations,
} from '../../db/schema';
import { draftCampaignEmails } from './newsletter-campaign-generate';
import { CAMPAIGN_TYPES, type CampaignType } from './newsletter-campaign-chat-draft';
import { cadenceFor } from '../config/email-campaign-cadences';
import { NEWSLETTER_DRAFT_REASON, scrubMergeTags } from './newsletter-generate';
import { renderIssueSnapshot } from './newsletter-render';
import { loadCustomFieldKeys } from './audience-custom-fields';
import { resolveBaseUrl } from './base-url';
import { audienceLine } from '../config/campaign-audience';
import { isFunnelStage, ORDER_ACTION_SPECS, type FunnelStage } from '../config/campaign-vocab';
import { mirrorOrder } from './campaign-mirror';

type Db = ReturnType<typeof getDb>;

export const EMAIL_ORDER_ACTION = 'draft_email_campaign';
export const EMAIL_TRIGGERS = ['form', 'custom'] as const;
export type EmailTrigger = typeof EMAIL_TRIGGERS[number];

/** A claim older than this belongs to a worker that died; the next wake-up may take it over. */
export const DRAFT_CLAIM_STALE_MINUTES = 20;
/** An issued email order with no claim this long after issue was never woken; re-send it. */
export const DRAFT_DISPATCH_GRACE_MINUTES = 10;

/**
 * Which kind of email campaign a stage asks for when the brief does not say. The kinds are the
 * Email Studio's own (email-campaign-cadences.ts), so the plan is one a person would recognise.
 */
const KIND_BY_STAGE: Record<FunnelStage, CampaignType> = {
    awareness: 'launch',
    consideration: 'onboarding',
    conversion: 'onboarding',
    retention: 'reengagement',
};

/**
 * Who receives it, when the brief does not say. Consideration and conversion campaigns are
 * capturing people (forms, tracked links), so their emails FOLLOW UP whoever signs up. Awareness
 * and retention speak to a list the business already has, so they are emails it sends itself.
 */
const TRIGGER_BY_STAGE: Record<FunnelStage, EmailTrigger> = {
    awareness: 'custom',
    consideration: 'form',
    conversion: 'form',
    retention: 'custom',
};

export interface EmailPlan {
    campaignType: CampaignType;
    trigger: EmailTrigger;
    steps: { day: number; role: string }[];
}

/**
 * The plan the generator writes against. Pure.
 *
 * Steps come from the kind's own cadence, trimmed to the number of emails ordered (which is what
 * was priced). If more were ordered than the cadence has, the extras follow a week apart with a
 * job the generator can always do honestly — never an invented offer or deadline.
 */
export function resolveEmailPlan(brief: Record<string, unknown>, stage: unknown): EmailPlan {
    const st: FunnelStage = isFunnelStage(stage) ? stage : 'conversion';
    const campaignType = (CAMPAIGN_TYPES as readonly string[]).includes(String(brief.emailKind))
        ? brief.emailKind as CampaignType
        : KIND_BY_STAGE[st];
    const trigger = (EMAIL_TRIGGERS as readonly string[]).includes(String(brief.emailTrigger))
        ? brief.emailTrigger as EmailTrigger
        : TRIGGER_BY_STAGE[st];
    const max = ORDER_ACTION_SPECS.draft_email_campaign.maxQuantity;
    const wanted = Math.max(1, Math.min(max, Math.floor(Number(brief.quantity)) || 1));

    const base = cadenceFor(campaignType).steps.slice(0, wanted).map((s) => ({ day: s.day, role: s.role }));
    while (base.length < wanted) {
        const lastDay = base.length ? base[base.length - 1].day : 0;
        base.push({ day: lastDay + 7, role: 'One more reason to act, with a new example' });
    }
    return { campaignType, trigger, steps: base };
}

/**
 * Take the order for drafting, or return null if it is not ours to take.
 *
 * Atomic: one UPDATE … RETURNING, so two wake-ups for the same order (a retry and the reconciler's
 * re-send) cannot both draft it. A claim older than DRAFT_CLAIM_STALE_MINUTES is a worker that died
 * mid-draft and may be taken over.
 */
async function claimOrder(db: Db, orderId: number) {
    const [row] = await db.update(campaignOrders)
        .set({
            brief: sql`${campaignOrders.brief} || jsonb_build_object('draftingStartedAt', now()::text)`,
            updatedAt: new Date(),
        })
        .where(and(
            eq(campaignOrders.id, orderId),
            eq(campaignOrders.action, EMAIL_ORDER_ACTION),
            eq(campaignOrders.status, 'issued'),
            sql`${campaignOrders.artefactId} IS NULL`,
            sql`(${campaignOrders.brief} ->> 'draftingStartedAt' IS NULL
                 OR (${campaignOrders.brief} ->> 'draftingStartedAt')::timestamptz
                    < now() - (${DRAFT_CLAIM_STALE_MINUTES} || ' minutes')::interval)`,
        ))
        .returning();
    return row ?? null;
}

export type DraftOutcome =
    | { ok: true; orderId: number; emails: number; artefactKind: 'newsletter_sequence' | 'newsletter_issue'; artefactId: number }
    | { ok: false; orderId: number; message: string; settle: boolean };

/**
 * Draft and save the email campaign one order commissioned.
 *
 * `settle: true` on failure means the caller must settle the order as failed (cancel + refund);
 * `settle: false` means there was nothing to do (already taken, or not an email order).
 */
export async function draftEmailCampaignForOrder(db: Db, orderId: number): Promise<DraftOutcome> {
    const order = await claimOrder(db, orderId);
    if (!order) return { ok: false, orderId, message: 'Not claimable — already drafted or being drafted', settle: false };

    const [campaign] = await db.select({
        id: campaigns.id, objective: campaigns.objective, audience: campaigns.audience,
        funnelStage: campaigns.funnelStage, orchestratorId: campaigns.aiAssistantId,
    }).from(campaigns)
        .where(and(eq(campaigns.id, order.campaignId), eq(campaigns.organisationId, order.organisationId)))
        .limit(1);
    if (!campaign) return { ok: false, orderId, message: 'The campaign no longer exists.', settle: true };

    if (!order.targetAssistantId) return { ok: false, orderId, message: 'The Email Marketing Assistant is no longer hired.', settle: true };
    const [target] = await db.select({ id: aiAssistants.id, userId: aiAssistants.userId })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, order.targetAssistantId), eq(aiAssistants.organisationId, order.organisationId)))
        .limit(1);
    if (!target) return { ok: false, orderId, message: 'The Email Marketing Assistant is no longer hired.', settle: true };

    const brief = (order.brief ?? {}) as Record<string, unknown>;
    const plan = resolveEmailPlan(brief, campaign.funnelStage);
    const name = `${campaign.objective.replace(/\s+/g, ' ').trim().slice(0, 64)} — emails`.slice(0, 80);

    let draft;
    try {
        draft = await draftCampaignEmails(db, {
            organisationId: order.organisationId,
            userId: target.userId,
            assistantId: target.id,
            name,
            campaignType: plan.campaignType,
            // What the reader has DONE when it worked. The campaign's angle, if one was set, is the
            // sharper statement of it; otherwise the founder's own objective.
            goal: String(brief.angle || campaign.objective).slice(0, 300),
            audience: (audienceLine(campaign.audience, brief.audience) ?? '').slice(0, 300),
            triggerEvent: plan.trigger,
            // ⚠️ The ONLY source a link may come from (the generator grounds every URL against it).
            // A campaign brief carries no links unless the user typed them, so most campaign emails
            // will have no link — which is right; an invented URL in an email is a wasted send.
            facts: String(brief.facts || '').slice(0, 4000),
            avoid: '',
            steps: plan.steps,
        });
    } catch (err) {
        console.error('[campaign-email-order] drafting failed', { orderId, err });
        return { ok: false, orderId, message: 'The Email Marketing Assistant could not write these emails.', settle: true };
    }
    // A plan the generator could not fill in is not a campaign; saving it would file empty emails.
    if (draft.stage !== 'draft' || !draft.newsletters.length) {
        return { ok: false, orderId, message: 'The emails came back incomplete, so nothing was saved.', settle: true };
    }

    const customKeys = await loadCustomFieldKeys(db, order.organisationId);
    const emails = draft.newsletters.map((e) => ({
        subject: e.subject.trim().slice(0, 200),
        preheader: e.preheader?.trim().slice(0, 200) || null,
        bodyMarkdown: scrubMergeTags(e.bodyMarkdown, customKeys).text,
        delayDays: Math.max(0, Math.min(90, e.delayDaysAfterPrevious)),
    }));

    let artefactKind: 'newsletter_sequence' | 'newsletter_issue';
    let artefactId: number;
    if (plan.trigger === 'form') {
        // A sequence a form starts. ⚠️ is_enabled is left at its default (false) — switching it on is
        // the user's, in Email Studio. Snapshotted at save exactly as importCampaign does: the send
        // worker never renders from the body.
        const [org] = await db.select({ name: organisations.name }).from(organisations)
            .where(eq(organisations.id, order.organisationId)).limit(1);
        const baseUrl = resolveBaseUrl();
        const rendered = await Promise.all(emails.map((e) => renderIssueSnapshot({
            bodyMarkdown: e.bodyMarkdown, design: null, preheader: e.preheader,
            senderName: org?.name || 'Your business', baseUrl: baseUrl ?? undefined,
        })));
        const seq = await db.transaction(async (tx) => {
            const [s] = await tx.insert(newsletterSequences).values({
                organisationId: order.organisationId,
                assistantId: target.id,
                triggerEvent: 'form',
                name,
                createdBy: target.userId,
                campaignOrderId: order.id,
            }).returning({ id: newsletterSequences.id });
            await tx.insert(newsletterSequenceSteps).values(emails.map((e, i) => ({
                organisationId: order.organisationId,
                sequenceId: s.id,
                stepNumber: i + 1,
                delayDays: e.delayDays,
                subject: e.subject,
                preheader: e.preheader,
                bodyMarkdown: e.bodyMarkdown,
                design: null,
                renderedPayload: rendered[i],
            })));
            return s;
        });
        artefactKind = 'newsletter_sequence';
        artefactId = seq.id;
    } else {
        // Emails the business sends itself, to whichever group it chooses, on the plan's days.
        // Saved as drafts with the assistant-written provenance stamp, as createCampaign does.
        const ids = await db.transaction(async (tx) => {
            const out: number[] = [];
            for (const e of emails) {
                const [row] = await tx.insert(newsletterIssues).values({
                    organisationId: order.organisationId,
                    userId: target.userId,
                    assistantId: target.id,
                    subject: e.subject,
                    preheader: e.preheader,
                    bodyMarkdown: e.bodyMarkdown,
                    generationReason: NEWSLETTER_DRAFT_REASON,
                    campaignOrderId: order.id,
                }).returning({ id: newsletterIssues.id });
                out.push(row.id);
            }
            return out;
        });
        artefactKind = 'newsletter_issue';
        artefactId = ids[0];
    }

    const summary = plan.trigger === 'form'
        ? `${emails.length} emails written as a form follow-up — switched off in Email Studio until you review them`
        : `${emails.length} draft emails in Email Studio — send each to the right group on its day`;
    await db.update(campaignOrders).set({
        status: 'in_review',
        artefactKind,
        artefactId,
        resultSummary: summary,
        updatedAt: new Date(),
    }).where(eq(campaignOrders.id, order.id));

    await mirrorOrder(db, {
        organisationId: order.organisationId,
        aiAssistantId: campaign.orchestratorId,
        orderId: order.id,
        campaignObjective: campaign.objective,
        action: 'draft_email_campaign',
        status: 'in_review',
        targetRoleLabel: ORDER_ACTION_SPECS.draft_email_campaign.roleKey,
        workItems: order.costWorkItems,
        resultSummary: summary,
    });

    return { ok: true, orderId, emails: emails.length, artefactKind, artefactId };
}

/**
 * Email orders that were issued but never picked up — the wake-up was lost (a cold platform, a
 * dispatch that timed out). The reconciler re-sends these. Only orders past the grace period, so a
 * worker that is simply still starting is not woken twice.
 */
export async function findStrandedEmailOrders(db: Db, limit = 20): Promise<number[]> {
    const rows = await db.select({ id: campaignOrders.id })
        .from(campaignOrders)
        .where(and(
            eq(campaignOrders.action, EMAIL_ORDER_ACTION),
            eq(campaignOrders.status, 'issued'),
            sql`${campaignOrders.artefactId} IS NULL`,
            sql`${campaignOrders.issuedAt} < now() - (${DRAFT_DISPATCH_GRACE_MINUTES} || ' minutes')::interval`,
            sql`(${campaignOrders.brief} ->> 'draftingStartedAt' IS NULL
                 OR (${campaignOrders.brief} ->> 'draftingStartedAt')::timestamptz
                    < now() - (${DRAFT_CLAIM_STALE_MINUTES} || ' minutes')::interval)`,
        ))
        .limit(limit);
    return rows.map((r) => r.id);
}
