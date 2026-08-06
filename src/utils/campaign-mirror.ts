// src/utils/campaign-mirror.ts
// Mirror campaign orders and decisions into assistant_records.
//
// ── Why mirror at all ────────────────────────────────────────────────────────
// The Data Hub and the Review Queue both read assistant_records. Mirroring means the Campaign
// Assistant gets the whole existing surface — table, columns, approve/reject gate, tab badge, CSV
// export, Calendar overlay — without one line of new client rendering. Exactly the trade
// discovered_leads made.
//
// The substantive tables stay the source of truth. A mirror row is a VIEW: it is written after the
// real row, it is never read back to make a decision, and losing one costs a table row on a
// screen, not correctness.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// The order has already been placed and the decision has already been recorded by the time
// anything here runs. Failing the caller because a display row could not be written would turn
// real work into a user-visible error over presentation.
//
// ⚠️ The two record types are CHECK-constrained. db/campaign-records.sql must be applied BEFORE
// this code deploys, or every mirror write raises a check violation that is logged here and
// nowhere else — the Orders tab would simply stay empty while orders were being placed fine.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { assistantRecords, campaignDecisions, campaignOrders } from '../../db/schema';
import {
    CAMPAIGN_DECISION_LABELS, CAMPAIGN_ORDER_STATUS_LABELS, ORDER_ACTION_SPECS,
    type CampaignDecisionKind, type CampaignOrderAction, type CampaignOrderStatus,
} from '../config/campaign-vocab';

type Db = ReturnType<typeof getDb>;

export interface MirrorOrderInput {
    organisationId: number;
    /** The ORCHESTRATOR's assistant id — the mirror belongs to the campaign assistant's Data Hub,
     *  not to the assistant that received the order. Getting this backwards would file the row in
     *  the Social Media Assistant's workspace, where nothing lists it. */
    aiAssistantId: number;
    orderId: number;
    campaignObjective: string;
    action: CampaignOrderAction;
    status: CampaignOrderStatus;
    targetRoleLabel: string;
    workItems: number;
    resultSummary?: string | null;
}

/**
 * Write (or refresh) the Data Hub row for one order.
 *
 * Orders are created `approved`, not `pending_approval`. They are not awaiting a human — the
 * decision that authorised them already was the gate, and putting them in the Review Queue too
 * would ask the user to approve the same thing twice.
 */
export async function mirrorOrder(db: Db, input: MirrorOrderInput): Promise<number | null> {
    try {
        const spec = ORDER_ACTION_SPECS[input.action];
        const data = {
            kind: 'campaign_order',
            orderId: input.orderId,
            campaign: input.campaignObjective,
            assignedTo: input.targetRoleLabel,
            action: spec?.label ?? input.action,
            cost: `${input.workItems} ${input.workItems === 1 ? 'item' : 'items'}`,
            workItems: input.workItems,
            result: input.resultSummary ?? null,
        };

        const [existing] = await db
            .select({ id: campaignOrders.assistantRecordId })
            .from(campaignOrders)
            .where(eq(campaignOrders.id, input.orderId))
            .limit(1);

        if (existing?.id) {
            await db.update(assistantRecords)
                .set({ status: CAMPAIGN_ORDER_STATUS_LABELS[input.status], data, updatedAt: new Date() })
                .where(eq(assistantRecords.id, existing.id));
            return existing.id;
        }

        const [row] = await db.insert(assistantRecords).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            recordType: 'campaign_order',
            title: spec?.label ?? input.action,
            status: CAMPAIGN_ORDER_STATUS_LABELS[input.status],
            // 'approved', not 'pending_approval' — see the doc comment.
            approvalStatus: 'approved',
            source: 'agent',
            data,
        }).returning({ id: assistantRecords.id });

        if (row) {
            await db.update(campaignOrders)
                .set({ assistantRecordId: row.id })
                .where(eq(campaignOrders.id, input.orderId));
        }
        return row?.id ?? null;
    } catch (err) {
        console.error('[campaign-mirror] order mirror failed', { orderId: input.orderId, err });
        return null;
    }
}

export interface MirrorDecisionInput {
    organisationId: number;
    aiAssistantId: number;
    decisionId: number;
    kind: CampaignDecisionKind;
    title: string;
    campaignObjective: string;
    evidence: unknown[];
    costOfInaction?: string | null;
    workItems: number;
    expiresAt: Date;
}

/**
 * Write the Review Queue row for one decision.
 *
 * `pending_approval` is the whole point: this is what makes the decision appear in the Review
 * Queue and count towards its badge. The record's `data` carries everything the card needs so the
 * queue does not have to join back to campaign_decisions to render a row.
 */
export async function mirrorDecision(db: Db, input: MirrorDecisionInput): Promise<number | null> {
    try {
        const [row] = await db.insert(assistantRecords).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            recordType: 'campaign_decision',
            title: input.title,
            status: CAMPAIGN_DECISION_LABELS[input.kind],
            approvalStatus: 'pending_approval',
            source: 'agent',
            data: {
                kind: 'campaign_decision',
                decisionId: input.decisionId,
                decisionKind: input.kind,
                campaign: input.campaignObjective,
                evidence: input.evidence,
                costOfInaction: input.costOfInaction ?? null,
                workItems: input.workItems,
                // Rendered as "Expires in N days". A decision card without an expiry invites
                // approving eight-week-old evidence by scrolling far enough down.
                expiresAt: input.expiresAt.toISOString(),
            },
        }).returning({ id: assistantRecords.id });

        if (row) {
            await db.update(campaignDecisions)
                .set({ assistantRecordId: row.id })
                .where(eq(campaignDecisions.id, input.decisionId));
        }
        return row?.id ?? null;
    } catch (err) {
        console.error('[campaign-mirror] decision mirror failed', { decisionId: input.decisionId, err });
        return null;
    }
}

/**
 * Keep the mirror in step when a decision is settled.
 *
 * The Review Queue's own approve/reject already moves `assistant_records.approval_status`; this
 * exists for the paths that settle a decision from the CAMPAIGN side (expiry, superseding), where
 * nothing else would clear it and the row would sit in the queue for ever.
 */
export async function settleDecisionMirror(db: Db, decisionId: number, approvalStatus: 'approved' | 'rejected'): Promise<void> {
    try {
        const [d] = await db
            .select({ recordId: campaignDecisions.assistantRecordId })
            .from(campaignDecisions)
            .where(eq(campaignDecisions.id, decisionId))
            .limit(1);
        if (!d?.recordId) return;
        await db.update(assistantRecords)
            .set({ approvalStatus, updatedAt: new Date() })
            .where(eq(assistantRecords.id, d.recordId));
    } catch (err) {
        console.error('[campaign-mirror] settle failed', { decisionId, err });
    }
}
