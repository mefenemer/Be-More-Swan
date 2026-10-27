// src/utils/chat-follow-up-plan.ts
// The Lead Generator's chat: its follow-up plan as it stands, and the follow_up_plan card that changes
// it. docs/lead-outreach-restructure-plan.md, Phase 3.
//
// Same contract as every other chat card. The model proposes the WHOLE new list of follow-ups, naming
// each by its position in today's plan ("from": 2) or as new ("from": null). This module rebuilds the
// card from the stored plan — positions become the real step numbers, the rules are
// src/config/follow-up-plan.ts — so the card can only offer what the save will accept. The click
// (chat-session.js) calls lead-generation.ts `save_follow_up_plan`, the action behind the Outreach
// tab's Follow-up plan panel. Nothing here writes. Never throws.

import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { assistantRecords, leadThreads } from '../../db/schema';
import { FOLLOW_UP_LIMITS, describeFollowUpPlan, validateFollowUpSteps } from '../config/follow-up-plan';
import { loadFollowUpPlan, type FollowUpPlan } from './outreach-sequences';

type Db = ReturnType<typeof getDb>;

export const FOLLOW_UP_PLAN_CARD_TYPE = 'follow_up_plan';

/** The block in the Lead Generator's chat prompt. Pure. */
export function renderFollowUpPlanChatBlock(plan: FollowUpPlan): string {
    const L = FOLLOW_UP_LIMITS;
    const lines = plan.steps.map((s, i) => `  ${i + 1}. wait ${s.delayDays} day${s.delayDays === 1 ? '' : 's'} after ${i === 0 ? 'the first email' : 'follow-up ' + i} — says: ${s.brief}`);
    return `YOUR FOLLOW-UP PLAN — what you send after a first email when the prospect doesn't reply (Outreach tab ▸ "Follow-up plan"). Right now: ${describeFollowUpPlan(plan.enabled, plan.steps)}.${plan.lockedOff ? ' (Switched off by support — nothing can send.)' : ''}
${plan.enabled ? lines.join('\n') : `  (Chasing is off. Its steps are kept for switching back on:)\n${lines.join('\n')}`}
${plan.running ? `${plan.running} lead${plan.running === 1 ? ' is' : 's are'} being followed up right now.` : 'No lead is being followed up right now.'}
Each follow-up is written by you, in the context of that conversation, from what its step says; every one stops the moment they reply, and the last one always says it is the last (that part is added for you).
To change it — only when the user asks — put this in "uiElement" (one per reply), giving the WHOLE new list in order:
{ "type": "follow_up_plan", "summary": "<one sentence>", "enabled": true | false, "steps": [ { "from": <its number in the list above, or null for a new one>, "waitDays": <${L.minDelayDays}-${L.maxDelayDays}>, "says": "<what it should say, or null to keep that step's words>" } ] }
To SHOW the user what a follow-up would say to one lead they have emailed — "what would the next chaser to Acme say?" — put this in "uiElement" instead: { "type": "follow_up_preview", "lead": <its # number from YOUR LEADS RIGHT NOW>, "followUp": <its number in the plan above, or null for that lead's next one> }. The card writes the preview when the user presses it, and sends nothing. Never write the follow-up yourself in your reply — the preview is drafted from the conversation by the same process that sends the real one.
At most ${L.maxSteps} follow-ups. Steps keep their order — you can change, remove or add at the end, never move one. To switch chasing off, send "enabled": false and leave out "steps". Switching off affects leads approved from then on; the card asks separately whether to stop the ones already running. The user confirms on the card and only that click saves it — never say the plan HAS changed.`;
}

/** The block for this assistant, loaded. Null on failure. */
export async function buildFollowUpPlanChatBlock(db: Db, organisationId: number, assistantId: number): Promise<string | null> {
    const plan = await loadFollowUpPlan(db, organisationId, assistantId);
    return plan ? renderFollowUpPlanChatBlock(plan) : null;
}

export interface FollowUpPlanCardStep { stepNumber: number | null; delayDays: number; brief: string }

export interface FollowUpPlanCard {
    type: typeof FOLLOW_UP_PLAN_CARD_TYPE;
    summary: string | null;
    enabled: boolean;
    /** What the click sends to save_follow_up_plan. Absent when switching off (the steps are kept). */
    steps: FollowUpPlanCardStep[] | null;
    current: string;
    proposed: string;
    /** Leads being followed up now — the card offers to stop them when switching off. */
    running: number;
    blocked: string | null;
    settled?: boolean;
}

/** Shape check. Null = not this card. Pure. */
export function isFollowUpPlanProposal(ui: unknown): boolean {
    return !!ui && typeof ui === 'object' && (ui as { type?: unknown }).type === FOLLOW_UP_PLAN_CARD_TYPE;
}

/**
 * Rebuild the card against the stored plan. Pure given the plan — exported for tests.
 *
 * "from" is a POSITION in today's plan (what the model was shown); it becomes the step NUMBER here.
 * A missing "says" or "waitDays" keeps that step's own.
 */
export function buildFollowUpPlanCard(ui: unknown, plan: FollowUpPlan): FollowUpPlanCard {
    const u = (ui ?? {}) as { summary?: unknown; enabled?: unknown; steps?: unknown };
    const summary = typeof u.summary === 'string' ? u.summary.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
    const enabled = u.enabled !== false;
    const card: FollowUpPlanCard = {
        type: FOLLOW_UP_PLAN_CARD_TYPE, summary, enabled, steps: null,
        current: describeFollowUpPlan(plan.enabled, plan.steps), proposed: '',
        running: plan.running, blocked: null,
    };
    if (plan.lockedOff) {
        card.proposed = card.current;
        card.blocked = 'Follow-ups are switched off for this assistant by support, so the plan can’t be changed from here.';
        return card;
    }
    if (!enabled) {
        card.proposed = describeFollowUpPlan(false, []);
        if (!plan.enabled) card.blocked = 'Chasing is already off.';
        return card;
    }

    const raw = Array.isArray(u.steps) ? u.steps : null;
    let steps: FollowUpPlanCardStep[];
    if (!raw) {
        // Switching on with no list: the plan's own steps.
        steps = plan.steps.map((s) => ({ stepNumber: s.stepNumber, delayDays: s.delayDays, brief: s.brief }));
    } else {
        steps = [];
        for (const item of raw) {
            const it = (item ?? {}) as { from?: unknown; waitDays?: unknown; says?: unknown };
            const pos = it.from == null ? null : Number(it.from);
            const base = pos != null && Number.isInteger(pos) ? plan.steps[pos - 1] : undefined;
            if (pos != null && !base) {
                card.proposed = card.current;
                card.blocked = `There is no follow-up ${String(it.from)} in the plan to change.`;
                return card;
            }
            steps.push({
                stepNumber: base ? base.stepNumber : null,
                delayDays: it.waitDays == null ? (base ? base.delayDays : NaN) : Number(it.waitDays),
                brief: typeof it.says === 'string' && it.says.trim() ? it.says : (base ? base.brief : ''),
            });
        }
    }
    const v = validateFollowUpSteps(steps, plan.usedNumbers);
    if (!v.ok) {
        card.proposed = card.current;
        card.blocked = `That can’t be saved: ${v.error.charAt(0).toLowerCase()}${v.error.slice(1)}`;
        return card;
    }
    card.steps = v.steps;
    card.proposed = describeFollowUpPlan(true, v.steps);
    const same = plan.enabled
        && v.steps.length === plan.steps.length
        && v.steps.every((s, i) => s.stepNumber === plan.steps[i].stepNumber && s.delayDays === plan.steps[i].delayDays && s.brief === plan.steps[i].brief);
    if (same) card.blocked = 'The plan already says exactly that.';
    return card;
}

/** Load the plan and rebuild the card. Null when the plan cannot be read. */
export async function resolveFollowUpPlanProposal(
    db: Db, organisationId: number, assistantId: number, ui: unknown,
): Promise<FollowUpPlanCard | null> {
    try {
        const plan = await loadFollowUpPlan(db, organisationId, assistantId);
        return plan ? buildFollowUpPlanCard(ui, plan) : null;
    } catch (err) {
        console.error('[chat-follow-up-plan] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

// ── Preview (Phase 4) ─────────────────────────────────────────────────────────
// "What would the next follow-up to Acme say?" — a card that, when pressed, drafts it exactly as the
// worker would and sends nothing (lead-generation.ts preview_follow_up). The model names the lead by
// its # (a lead record) and, optionally, which follow-up. The card is resolved here against the lead's
// own conversation, so it can only offer a preview the action will accept.

export const FOLLOW_UP_PREVIEW_CARD_TYPE = 'follow_up_preview';

export interface FollowUpPreviewCard {
    type: typeof FOLLOW_UP_PREVIEW_CARD_TYPE;
    recordId: number | null;
    threadId: number | null;
    leadTitle: string;
    /** Position in the plan, or null for this lead's next follow-up. */
    position: number | null;
    blocked: string | null;
}

export function isFollowUpPreviewProposal(ui: unknown): boolean {
    return !!ui && typeof ui === 'object' && (ui as { type?: unknown }).type === FOLLOW_UP_PREVIEW_CARD_TYPE;
}

/** Find the lead's live conversation and build the card. Null when the reads fail. */
export async function resolveFollowUpPreviewProposal(
    db: Db, organisationId: number, assistantId: number, ui: unknown,
): Promise<FollowUpPreviewCard | null> {
    try {
        const u = (ui ?? {}) as { lead?: unknown; followUp?: unknown };
        const recordId = Number(String(u.lead ?? '').replace(/^#/, ''));
        const rawPos = u.followUp == null ? null : Number(u.followUp);
        const position = rawPos != null && Number.isInteger(rawPos) ? rawPos : null;
        const card: FollowUpPreviewCard = { type: FOLLOW_UP_PREVIEW_CARD_TYPE, recordId: Number.isInteger(recordId) ? recordId : null, threadId: null, leadTitle: '', position, blocked: null };
        if (!card.recordId) { card.blocked = 'I couldn’t tell which lead you meant.'; return card; }

        const [rec] = await db.select({ title: assistantRecords.title }).from(assistantRecords)
            .where(and(eq(assistantRecords.id, card.recordId), eq(assistantRecords.organisationId, organisationId), eq(assistantRecords.aiAssistantId, assistantId)))
            .limit(1);
        if (!rec) { card.blocked = 'That isn’t one of this assistant’s leads.'; return card; }
        card.leadTitle = rec.title;

        // The newest conversation for the lead is the live one (see lead-threads.ts board).
        const [thread] = await db.select({ id: leadThreads.id, state: leadThreads.state }).from(leadThreads)
            .where(and(eq(leadThreads.assistantRecordId, card.recordId), eq(leadThreads.organisationId, organisationId), eq(leadThreads.aiAssistantId, assistantId)))
            .orderBy(desc(leadThreads.updatedAt), desc(leadThreads.id))
            .limit(1);
        if (!thread) { card.blocked = `${rec.title} hasn’t been emailed from here yet, so there is no conversation to write a follow-up into.`; return card; }
        if (thread.state !== 'open') {
            card.blocked = thread.state === 'replied'
                ? `${rec.title} has replied, so no follow-up goes to them.`
                : `The conversation with ${rec.title} is closed, so no follow-up goes to them.`;
            return card;
        }
        card.threadId = thread.id;
        if (position != null) {
            const plan = await loadFollowUpPlan(db, organisationId, assistantId);
            if (plan && (position < 1 || position > plan.steps.length)) card.blocked = `There is no follow-up ${position} in the plan.`;
        }
        return card;
    } catch (err) {
        console.error('[chat-follow-up-plan] could not resolve the preview (non-fatal)', err);
        return null;
    }
}
