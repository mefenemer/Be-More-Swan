// src/utils/chat-lead-action.ts
// The Lead Generation chat's hands on leads that ALREADY exist: approve and send a lead's outreach
// email, move a lead from Enrichment into Outreach, turn one down, or record how a deal ended. The
// lead twin of chat-email-action.ts.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The Lead Generation chat could propose searches and count its leads, but every decision on
// a lead — the ones the Enrichment, Outreach and Conversations tabs exist for — was page-only.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// The model never acts. It proposes a `lead_action_proposal` naming a lead by the "#id" its list
// shows. This module checks the proposal against assistant_records — this assistant's, this
// organisation's, a lead, in a state the action applies to — and rebuilds the card from the row.
// The click calls the tabs' own endpoints (assistant-records PATCH, lead-generation send_outreach /
// set_outcome), so every gate those enforce still applies.
//
// ── Sending is the one that reaches a stranger ───────────────────────────────────────────────────
// Unlike the Social, Blog and Email chats, this one CAN send: the owner asked for it (2026-10-22),
// on the condition that the card shows the email in full, and the follow-ups, before the click. So:
//   • The card carries the stored draft word for word — recipient, subject, body — plus the
//     signature and the legal footer that are added at send time. Never the model's own words.
//   • Only a STORED draft can be sent from chat. send_outreach writes one on the spot when none
//     exists, and that is an email nobody would have read; the card refuses and says why.
//   • `draftHash` fingerprints what the card showed. send_outreach refuses (`draft_changed`) when the
//     stored draft no longer matches, so an edit made after the card was drawn is never sent unseen.
//   • Follow-ups are not written in advance — the sequence worker writes each when it is due, from
//     its step's brief — so the card shows when each would go and what it is briefed to say, and
//     says plainly that the words do not exist yet.
//   • The do-not-contact override stays on the Outreach tab: overruling a compliance verdict needs a
//     typed reason, which is not something to collect through a chat card.
//
// ⚠️ Never throws.

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, organisations } from '../../db/schema';
import { hasOutreachDraft, isInOutreachReview, resolveLeadRecipient } from '../config/lead-recipient';
import { leadOutreachState } from '../config/lead-outreach-state';
import { evaluateDoNotContact } from '../config/do-not-contact';
import { needsPersonalInboxConfirmation } from '../config/lead-email-kind';
import { isUsablePostalAddress } from '../config/outreach-footer';
import {
    LOSS_REASON_LABELS, OUTCOME_LABELS, OUTCOMES_REQUIRING_LOSS_REASON, isLossReason, isOutcome,
    type LossReason, type RevenueOutcome,
} from '../config/revenue-events';
import { signatureFromContext } from './outreach-signature';
import { previewFollowUps } from './outreach-sequences';

type Db = ReturnType<typeof getDb>;

export const LEAD_ACTION_PROPOSAL_TYPE = 'lead_action_proposal';
export const LEAD_ACTIONS = ['send', 'move_to_outreach', 'reject', 'set_outcome'] as const;
export type LeadAction = typeof LEAD_ACTIONS[number];

const TITLE_MAX = 200;

/** Truncation identical to lead-generation.ts `str`, so the fingerprint is taken over the same text. */
function str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * What send_outreach would send for this lead's STORED draft — the same resolution it uses (recipient
 * order from lead-recipient.ts, the same truncation, the same fallback subject). Null without a body.
 */
export function sendableDraft(data: unknown, title: string | null): { to: string | null; subject: string; body: string } | null {
    const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data as Record<string, unknown> : {};
    const draft = (d.outreachDraft && typeof d.outreachDraft === 'object') ? d.outreachDraft as Record<string, unknown> : null;
    const body = str(draft?.body, 4000);
    if (!body) return null;
    const to = str(resolveLeadRecipient(d), 200);
    const subject = str(draft?.subject, 300) || `Quick note for ${title}`;
    return { to, subject, body };
}

/** The fingerprint of a draft as send_outreach would send it. Shared by the card and the send gate. */
export function outreachDraftFingerprint(to: string | null, subject: string, body: string): string {
    return createHash('sha256').update(JSON.stringify([(to ?? '').toLowerCase(), subject, body])).digest('hex').slice(0, 16);
}

export interface LeadActionRequest {
    action: LeadAction;
    recordId: number;
    outcome: RevenueOutcome | null;
    lossReason: LossReason | null;
    valueGbp: number | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function leadActionFromUiElement(uiElement: unknown): LeadActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== LEAD_ACTION_PROPOSAL_TYPE) return null;
    const action = LEAD_ACTIONS.find((a) => a === ui.action);
    const recordId = Number(String(ui.recordId ?? ui.leadId ?? '').replace(/^#/, ''));
    if (!action || !Number.isInteger(recordId) || recordId <= 0) return null;
    if (action !== 'set_outcome') return { action, recordId, outcome: null, lossReason: null, valueGbp: null };
    const outcome = isOutcome(ui.outcome) ? ui.outcome : null;
    if (!outcome) return null;
    const lossReason = outcome !== 'won' && isLossReason(ui.lossReason) ? ui.lossReason : null;
    const v = Number(ui.valueGbp);
    const valueGbp = outcome === 'won' && ui.valueGbp !== null && ui.valueGbp !== undefined && ui.valueGbp !== '' && Number.isFinite(v) && v >= 0 ? v : null;
    return { action, recordId, outcome, lossReason, valueGbp };
}

export interface LeadActionCard {
    type: typeof LEAD_ACTION_PROPOSAL_TYPE;
    action: LeadAction;
    recordId: number;
    /** lead-generation's endpoints take the assistant; the chat may be a resumed session without one. */
    assistantId: number;
    title: string;
    /** hot / warm / cold, as scored. */
    rating: string | null;
    approvalStatus: string | null;
    /** send: the email exactly as send_outreach would send it. */
    to?: string | null;
    subject?: string | null;
    body?: string | null;
    signature?: string | null;
    /** send: the business name and postal address the legal footer carries. */
    footerName?: string | null;
    footerAddress?: string | null;
    /** send: a scraped or bought address belonging to a named person — the click confirms it. */
    personalInbox?: boolean;
    /** send: the lead is still in Review, so the click approves it first (as the tab's button does). */
    approveFirst?: boolean;
    draftHash?: string | null;
    /** send: what follows if they do not reply. null = could not be read. */
    followUps?: { enabled: boolean; steps: Array<{ stepNumber: number; daysAfterOpener: number; brief: string }> } | null;
    /** move_to_outreach: whether it will arrive with an email to read. */
    hasEmail?: boolean;
    /** set_outcome */
    outcome?: RevenueOutcome | null;
    outcomeLabel?: string | null;
    lossReason?: LossReason | null;
    lossReasonLabel?: string | null;
    valueGbp?: number | null;
    /** set_outcome: what it is marked as now, when it is a correction. */
    currentOutcome?: string | null;
    blocked: string | null;
    settled?: boolean;
}

type LeadRow = { id: number; title: string | null; status: string | null; approvalStatus: string | null; data: unknown };

async function loadLead(db: Db, organisationId: number, aiAssistantId: number, recordId: number): Promise<LeadRow | null> {
    const [rec] = await db.select({
        id: assistantRecords.id, title: assistantRecords.title, status: assistantRecords.status,
        approvalStatus: assistantRecords.approvalStatus, data: assistantRecords.data,
    })
        .from(assistantRecords)
        .where(and(
            eq(assistantRecords.id, recordId),
            eq(assistantRecords.organisationId, organisationId),
            eq(assistantRecords.aiAssistantId, aiAssistantId),
            eq(assistantRecords.recordType, 'lead'),
        ))
        .limit(1);
    return rec ?? null;
}

/** Why this action cannot be taken on this lead right now, from the row alone. Null when it can. */
function rowBlock(req: LeadActionRequest, rec: LeadRow): string | null {
    const data = rec.data;
    const sent = leadOutreachState(data) === 'sent';
    const status = rec.approvalStatus ?? '';
    const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    if (req.action === 'send') {
        if (status === 'rejected') return 'This lead was turned down. Move it back to Outreach first if you want to email it.';
        if (sent) return 'Its outreach email has already gone. When you know how it ended, I can record that.';
        if (status === 'pending_approval' && !isInOutreachReview(data)) return 'This lead is still in Enrichment. Move it to Outreach first — I can do that — and its email will be waiting there.';
        if (status !== 'pending_approval' && status !== 'approved') return 'This lead isn’t waiting to be emailed.';
        if (!hasOutreachDraft(data)) return 'No email has been written for this lead yet, so there is nothing to show you. Open it on the Outreach tab: sending from there writes one first.';
        if (!resolveLeadRecipient(data)) return 'There’s no email address on this lead, so it can’t be emailed. Add one on the Enrichment tab.';
        const dnc = evaluateDoNotContact(data);
        if (dnc.blocked) return `This lead is flagged do-not-contact: ${dnc.reason || 'flagged during qualification'}. Only the Outreach tab can overrule that, and it asks you why.`;
        return null;
    }
    if (req.action === 'move_to_outreach') {
        if (status === 'approved' || status === 'scheduled') return sent ? 'Its outreach email has already gone.' : 'It’s already through Outreach — approved and waiting in the "Approved" column.';
        if (status === 'pending_approval' && isInOutreachReview(data)) return 'It’s already in Outreach, waiting in the Review column.';
        return null;
    }
    if (req.action === 'reject') {
        if (status === 'rejected') return 'This lead has already been turned down.';
        if (sent) return 'Its outreach email has already gone, so there is nothing to turn down. I can record how it ended instead.';
        return null;
    }
    // set_outcome
    if (req.outcome && OUTCOMES_REQUIRING_LOSS_REASON.includes(req.outcome) && !req.lossReason) {
        return `Say why it was ${req.outcome} and I’ll record it — one of: ${Object.values(LOSS_REASON_LABELS).join('; ')}.`;
    }
    const prior = (d.dealOutcome && typeof d.dealOutcome === 'object') ? (d.dealOutcome as Record<string, unknown>).outcome : null;
    if (prior && prior === req.outcome && !req.lossReason && req.valueGbp === null) return `It’s already marked ${String(prior)}.`;
    return null;
}

/**
 * Check a proposal against the database and return the card the user confirms — built only from
 * rows. Null when the lead is not this assistant's.
 */
export async function resolveLeadActionProposal(
    db: Db, organisationId: number, aiAssistantId: number, req: LeadActionRequest,
): Promise<LeadActionCard | null> {
    try {
        const rec = await loadLead(db, organisationId, aiAssistantId, req.recordId);
        if (!rec) return null;
        const title = String(rec.title ?? '').replace(/\s+/g, ' ').trim();
        const card: LeadActionCard = {
            type: LEAD_ACTION_PROPOSAL_TYPE,
            action: req.action,
            recordId: rec.id,
            assistantId: aiAssistantId,
            title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
            rating: rec.status ? String(rec.status).toLowerCase() : null,
            approvalStatus: rec.approvalStatus,
            blocked: rowBlock(req, rec),
        };
        const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) ? rec.data as Record<string, unknown> : {};

        if (req.action === 'move_to_outreach') card.hasEmail = hasOutreachDraft(data) && !!resolveLeadRecipient(data);

        if (req.action === 'set_outcome') {
            card.outcome = req.outcome;
            card.outcomeLabel = req.outcome ? OUTCOME_LABELS[req.outcome] : null;
            card.lossReason = req.lossReason;
            card.lossReasonLabel = req.lossReason ? LOSS_REASON_LABELS[req.lossReason] : null;
            card.valueGbp = req.valueGbp;
            const prior = (data.dealOutcome && typeof data.dealOutcome === 'object') ? (data.dealOutcome as Record<string, unknown>).outcome : null;
            card.currentOutcome = typeof prior === 'string' ? prior : null;
        }

        if (req.action === 'send') {
            // The email is shown even when the send is blocked — it is what the user asked about.
            const draft = sendableDraft(data, rec.title);
            if (draft) {
                card.to = draft.to;
                card.subject = draft.subject;
                card.body = draft.body;
                card.draftHash = outreachDraftFingerprint(draft.to, draft.subject, draft.body);
            }
            card.personalInbox = needsPersonalInboxConfirmation(data.emailKind, data.emailSource);
            card.approveFirst = rec.approvalStatus === 'pending_approval';
            if (!card.blocked) {
                const [assistant] = await db.select({ onboardingContext: aiAssistants.onboardingContext })
                    .from(aiAssistants)
                    .where(and(eq(aiAssistants.id, aiAssistantId), eq(aiAssistants.organisationId, organisationId)))
                    .limit(1);
                const ctx = (assistant?.onboardingContext && typeof assistant.onboardingContext === 'object')
                    ? assistant.onboardingContext as Record<string, unknown> : {};
                card.signature = signatureFromContext(ctx) || null;
                const provider = typeof ctx.outreachEmailProvider === 'string' ? ctx.outreachEmailProvider : '';
                if (provider !== 'google' && provider !== 'microsoft') {
                    card.blocked = 'No inbox is set up to send from. Connect Gmail or Outlook from the Outreach tab, or copy the draft there and send it yourself.';
                }
                const [org] = await db.select({ name: organisations.name, postalAddress: organisations.outreachPostalAddress })
                    .from(organisations)
                    .where(eq(organisations.id, organisationId))
                    .limit(1);
                card.footerName = org?.name ?? null;
                card.footerAddress = org?.postalAddress ?? null;
                if (!card.blocked && !isUsablePostalAddress(org?.postalAddress)) {
                    card.blocked = 'Add your business postal address in Business Information first — anti-spam law requires one in every outreach email.';
                }
                card.followUps = await previewFollowUps(db, aiAssistantId);
            }
        }
        return card;
    } catch (err) {
        console.error('[chat-lead-action] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

/**
 * Re-check every stored lead_action_proposal in a transcript, so a card acted on — here, on the
 * page, or by the draft being edited since — says so instead of offering a button the endpoint would
 * refuse. Mutates nothing it is given.
 */
export async function refreshLeadActionCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== LEAD_ACTION_PROPOSAL_TYPE || ui.settled) return m;
        const req = leadActionFromUiElement(ui);
        if (!req) return m;
        try {
            const rec = await loadLead(db, organisationId, aiAssistantId, req.recordId);
            if (!rec) return { ...m, uiElement: { ...ui, settled: true, blocked: 'This lead no longer exists.' } };
            const block = rowBlock(req, rec);
            // A card that was blocked from the start was never acted on — it keeps its own reason.
            if (block) {
                const why = ui.blocked ? block : `Already dealt with — ${block.charAt(0).toLowerCase()}${block.slice(1)}`;
                return { ...m, uiElement: { ...ui, approvalStatus: rec.approvalStatus, settled: true, blocked: why } };
            }
            if (req.action === 'send' && typeof ui.draftHash === 'string') {
                const draft = sendableDraft(rec.data, rec.title);
                const now = draft ? outreachDraftFingerprint(draft.to, draft.subject, draft.body) : null;
                if (now !== ui.draftHash) {
                    return { ...m, uiElement: { ...ui, settled: true, blocked: 'The email has been edited since this card was made. Ask again to see the new version.' } };
                }
            }
            return { ...m, uiElement: { ...ui, approvalStatus: rec.approvalStatus } };
        } catch (err) {
            console.error('[chat-lead-action] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
