// src/utils/campaign-work-state.ts
// What each piece of a campaign's work is doing right now, and the ONE thing the user should do
// next. docs/campaign-orchestrator-flow.md §2.
//
// Found approving prod campaign 1 (2026-10-14): six briefs went out and the Campaigns tab said
// nothing more. Two were waiting on the user (a picture to pick, emails to review), three were
// waiting on the picture, and nothing anywhere said so, so it read as "nothing happened".
//
// Pure, and derived only from the order rows and their drafting jobs. Nothing here is written by a
// model: a "working on it" that is not true is worse than silence.

import { ORDER_ACTION_SPECS, isOrderAction } from '../config/campaign-vocab';

/** The drafting queues drain on a ten-minute cron (netlify.toml); campaign work is also poked at once. */
export const DRAIN_MINUTES = 10;

export type WorkState = 'done' | 'waiting_you' | 'waiting_item' | 'queued' | 'working' | 'cancelled';

export interface WorkOrderRow {
    id: number;
    action: string;
    status: string;
    blockedOnOrderId: number | null;
    resultSummary: string | null;
    artefactKind: string | null;
    targetAssistantId: number | null;
    brief: Record<string, unknown>;
    /** Drafting jobs this order enqueued, by status. Absent for orders that enqueue none. */
    jobs?: { queued: number; processing: number; completed: number; failed: number };
}

export interface WorkItem {
    orderId: number;
    /** 1-based, in the order the work was placed — what "waits for item 2" refers to. */
    position: number;
    action: string;
    label: string;
    state: WorkState;
    /** One sentence, already phrased for display. */
    text: string;
    /** Where the user acts on it: an assistant page and tab. */
    link: { assistantId: number; tab: string; label: string } | null;
    /** Waiting on an earlier item: offer "Start now without waiting". */
    canStartNow: boolean;
    /** Items held behind this one. */
    holding: number;
}

/** Where each kind of finished work is reviewed, on the receiving assistant's page. */
const REVIEW_TAB: Record<string, { tab: string; label: string }> = {
    visual_brief: { tab: 'briefs', label: 'Open the brief' },
    video_project: { tab: 'videos', label: 'Open the video' },
    newsletter_sequence: { tab: 'email-campaigns', label: 'Review the emails' },
    newsletter_issue: { tab: 'email-campaigns', label: 'Review the emails' },
    scheduled_post: { tab: 'review-queue', label: 'Review the posts' },
    blog_post: { tab: 'review-queue', label: 'Review the article' },
    discovery_campaign: { tab: 'signals', label: 'Open the search' },
};

function labelOf(action: string): string {
    return isOrderAction(action) ? ORDER_ACTION_SPECS[action].label : action;
}

export function describeWork(orders: WorkOrderRow[]): WorkItem[] {
    const position = new Map<number, number>();
    orders.forEach((o, i) => position.set(o.id, i + 1));
    const holding = new Map<number, number>();
    for (const o of orders) {
        if (o.status === 'blocked' && o.blockedOnOrderId) holding.set(o.blockedOnOrderId, (holding.get(o.blockedOnOrderId) ?? 0) + 1);
    }

    return orders.map((o, i): WorkItem => {
        const base = {
            orderId: o.id, position: i + 1, action: o.action, label: labelOf(o.action),
            link: null as WorkItem['link'], canStartNow: false, holding: holding.get(o.id) ?? 0,
        };
        const review = o.artefactKind && o.targetAssistantId && REVIEW_TAB[o.artefactKind]
            ? { assistantId: o.targetAssistantId, ...REVIEW_TAB[o.artefactKind] } : null;

        switch (o.status) {
            case 'delivered':
                return { ...base, state: 'done', text: o.resultSummary || 'Done.', link: review };
            case 'cancelled':
            case 'rejected':
                return { ...base, state: 'cancelled', text: o.resultSummary || 'Cancelled.' };
            case 'blocked': {
                const p = o.blockedOnOrderId ? position.get(o.blockedOnOrderId) : undefined;
                const on = p ? `item ${p}, ${labelOf(orders[p - 1].action).toLowerCase()}` : 'earlier work';
                return { ...base, state: 'waiting_item', text: `Waiting for ${on}.`, canStartNow: true };
            }
            case 'in_review':
                return { ...base, state: 'waiting_you', text: o.resultSummary || 'Ready for you to review.', link: review };
            case 'queued':
                return { ...base, state: 'queued', text: `Queued. It starts within about ${DRAIN_MINUTES} minutes.` };
            default: break; // 'issued'
        }

        if (o.action === 'request_human_task') {
            const who = typeof o.brief.assignee === 'string' && o.brief.assignee ? o.brief.assignee : 'a person on your team';
            return { ...base, state: 'waiting_you', text: `Waiting on ${who}. Mark it done on this campaign when it is.` };
        }
        const j = o.jobs;
        if (j && j.queued + j.processing + j.completed + j.failed > 0) {
            const total = j.queued + j.processing + j.completed + j.failed;
            if (j.processing === 0 && j.completed === 0 && j.failed === 0) {
                return { ...base, state: 'queued', text: `Queued with the assistant. Drafting starts within about ${DRAIN_MINUTES} minutes.` };
            }
            if (j.queued + j.processing > 0) {
                return { ...base, state: 'working', text: `Drafting: ${j.completed} of ${total} done.` };
            }
            // Every job finished; the reconciler (hourly) has not yet moved the order to review.
            return { ...base, state: 'waiting_you', text: 'Drafted. It is in the assistant’s review queue.', link: review };
        }
        return { ...base, state: 'working', text: o.resultSummary || 'With the assistant.' };
    });
}

export interface NextStep {
    kind: 'plan' | 'start' | 'resume' | 'act' | 'wait' | 'done' | 'idle';
    text: string;
    /** The work item to act on, when there is one. */
    orderId?: number;
    link?: WorkItem['link'];
}

/**
 * The ONE next step for a campaign, in priority order. Derived, never generated.
 */
export function nextStep(campaign: { status: string }, hasPendingPlan: boolean, items: WorkItem[]): NextStep {
    if (hasPendingPlan) {
        return { kind: 'plan', text: campaign.status === 'draft' ? 'Review the plan, then approve it to start the campaign.' : 'A new plan is waiting for you to review.' };
    }
    if (campaign.status === 'draft') return { kind: 'start', text: 'Ask your Campaign Assistant for a plan, or start the campaign and use "Add work".' };
    if (campaign.status === 'paused') return { kind: 'resume', text: 'Paused. Nothing new is briefed until you resume it.' };
    if (campaign.status === 'finished' || campaign.status === 'archived') return { kind: 'done', text: 'This campaign has finished. See its summary for how it went.' };

    // What is waiting on the user — the one holding up the most other work first.
    const yours = items.filter((w) => w.state === 'waiting_you').sort((a, b) => b.holding - a.holding);
    if (yours.length) {
        const w = yours[0];
        const held = w.holding ? ` ${w.holding} ${w.holding === 1 ? 'item is' : 'items are'} waiting on it.` : '';
        const more = yours.length > 1 ? ` (${yours.length - 1} more ${yours.length - 1 === 1 ? 'thing needs' : 'things need'} you after this.)` : '';
        // Stored summaries arrive with or without a full stop; the sentences after it need one.
        const said = w.text.replace(/[.\s]*$/, '.');
        return { kind: 'act', text: `Item ${w.position}, ${w.label.toLowerCase()}: ${said}${held}${more}`, orderId: w.orderId, link: w.link };
    }

    const active = items.filter((w) => w.state === 'working' || w.state === 'queued');
    const waiting = items.filter((w) => w.state === 'waiting_item');
    if (active.length) {
        const queuedOnly = active.every((w) => w.state === 'queued');
        return {
            kind: 'wait',
            text: queuedOnly
                ? `Nothing needed from you. ${active.length} ${active.length === 1 ? 'item is' : 'items are'} queued and start within about ${DRAIN_MINUTES} minutes.`
                : `Nothing needed from you. Your assistants are working on ${active.length} ${active.length === 1 ? 'item' : 'items'}.`,
        };
    }
    if (waiting.length) {
        return { kind: 'wait', text: `Nothing needed from you yet. ${waiting.length} ${waiting.length === 1 ? 'item is' : 'items are'} waiting for earlier work. Use "Start now" on an item to skip the wait.` };
    }
    if (items.length && items.every((w) => w.state === 'done' || w.state === 'cancelled')) {
        return { kind: 'done', text: 'All the work this campaign asked for has been delivered. Add more work, or see the summary.' };
    }
    return { kind: 'idle', text: 'Running, but nothing is commissioned yet. Use "Add work", or ask your Campaign Assistant for a plan.' };
}
