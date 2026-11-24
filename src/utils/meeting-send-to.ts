// src/utils/meeting-send-to.ts — "Send to" for one approved meeting (Fix pipeline #73, owner 2026-11-24).
//
// Approving a meeting runs every hand-off switched on for the Note Taker (process-scenario-jobs.ts). Until now that
// was the only way anything left: there was no way to send ONE meeting to Slack, Notion, Jira or Asana later — after
// switching a tool on, or after a send failed — except the follow-up email's own "Send the follow-up now". This is
// that, for every tool, from the Inbox card and from the chat (chat-meeting-action.ts action 'send_to'). Both call
// the same PATCH on assistant-records ({ sendTo }), which queues the one hand-off through the same runner, so:
//   - Slack, Notion and the follow-up email still go at most once per meeting (meeting-handoff-once.ts);
//   - Jira and Asana file only the action items not already in the tool (the action_items ledger).
//
// Kept free of SDK imports so the Inbox, the chat card and tests share one list and one "is it sent?" rule.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { activeScenarios, integrationScenarios } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** The hand-offs a meeting can be sent to on demand, by recipe actionType, in the order they are shown. */
export const MEETING_SEND_TARGETS = {
    email_meeting_followup: { label: 'Follow-up email', what: 'the follow-up email to the attendees' },
    slack_post_summary: { label: 'Slack', what: 'the summary in your Slack channel' },
    notion_create_page: { label: 'Notion', what: 'a Notion page with the summary and action items' },
    jira_create_tasks: { label: 'Jira', what: 'a Jira ticket for each action item' },
    asana_create_tasks: { label: 'Asana', what: 'an Asana task for each action item' },
} as const;

export type MeetingSendTarget = keyof typeof MEETING_SEND_TARGETS;

/** The two that file one ticket per action item (a ledger, not a once-stamp). */
export const MEETING_TASK_TARGETS: ReadonlySet<string> = new Set(['jira_create_tasks', 'asana_create_tasks']);

export function isMeetingSendTarget(v: unknown): v is MeetingSendTarget {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MEETING_SEND_TARGETS, v);
}

export function meetingSendLabel(target: MeetingSendTarget): string {
    return MEETING_SEND_TARGETS[target].label;
}

/**
 * The per-task ledger summary: the records GET attaches it with `items` (assistant-records.ts attachActionItemSync);
 * the chat snapshot passes `syncedBy` (synced count per provider). Synced items count only for the tool they went to,
 * so items filed in Jira never read as "sent to Asana" after the assistant switches tools (review on PR #853).
 */
export interface ActionItemSyncSummary {
    total?: number; synced?: number; failed?: number;
    items?: ReadonlyArray<{ syncStatus?: string | null; provider?: string | null }>;
    syncedBy?: Record<string, number>;
}

/** 'jira' / 'asana' for the two ticket targets (action_items.provider), else null. */
export function taskProvider(target: MeetingSendTarget): string | null {
    return target === 'jira_create_tasks' ? 'jira' : target === 'asana_create_tasks' ? 'asana' : null;
}

/** Just approved, or claimed by a run: the approval's own job is (probably) sending it now. */
export const SENDING_WINDOW_MINUTES = { claimed: 15, approved: 5 } as const;

export type MeetingSendState = {
    sent: boolean; partly: boolean; sentAt: string | null; sending: boolean;
    /**
     * Jira/Asana: every action item not in THIS tool is already in the other one ('Jira' / 'Asana'), so there is
     * nothing left to file here. The ledger keeps one row per action item, not per tool, and a filed item is never
     * filed again, so a send would do nothing (review on PR #853). Null otherwise.
     */
    filedElsewhere: string | null;
    /** Jira/Asana: action items not yet filed in either tool. */
    remaining: number;
};

/**
 * Pure: whether this meeting has gone to this target. Slack/Notion/email: the once-per-meeting stamp
 * (data.handoffs[actionType].sentAt; for the email, also the older data.followupSentAt). Jira/Asana: every action
 * item in the ledger synced (partly = some are).
 */
export function meetingSendState(
    target: MeetingSendTarget, data: unknown, sync?: ActionItemSyncSummary | null,
    opts: { approvedRecently?: boolean; now?: number } = {},
): MeetingSendState {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const now = opts.now ?? Date.now();
    if (MEETING_TASK_TARGETS.has(target)) {
        const total = Number(sync?.total ?? 0);
        const provider = taskProvider(target);
        const items = Array.isArray(sync?.items) ? sync!.items!.filter(Boolean) : null;
        const syncedAll = items ? items.filter((i) => i.syncStatus === 'synced').length : Number(sync?.synced ?? 0);
        const syncedHere = items
            ? items.filter((i) => i.syncStatus === 'synced' && (i.provider ?? provider) === provider).length
            : sync?.syncedBy ? Number(sync.syncedBy[provider ?? ''] ?? 0)
            : syncedAll;
        const elsewhere = Math.max(0, syncedAll - syncedHere);
        const remaining = Math.max(0, total - syncedAll);
        const sent = total > 0 && syncedHere >= total;
        const other = provider === 'jira' ? 'Asana' : 'Jira';
        return {
            sent,
            partly: syncedAll > 0 && remaining > 0,
            sentAt: null,
            // Approved a moment ago and nothing filed yet: the approval's job is filing them.
            sending: !sent && syncedAll === 0 && !!opts.approvedRecently,
            filedElsewhere: !sent && remaining === 0 && elsewhere > 0 ? other : null,
            remaining,
        };
    }
    const h = d.handoffs && typeof d.handoffs === 'object' ? (d.handoffs as Record<string, unknown>)[target] : null;
    const stamped = h && typeof h === 'object' && typeof (h as { sentAt?: unknown }).sentAt === 'string' ? (h as { sentAt: string }).sentAt : null;
    const legacy = target === 'email_meeting_followup' && typeof d.followupSentAt === 'string' ? d.followupSentAt : null;
    const sentAt = stamped ?? legacy;
    const claimedAt = h && typeof h === 'object' && typeof (h as { claimedAt?: unknown }).claimedAt === 'string' ? Date.parse((h as { claimedAt: string }).claimedAt) : NaN;
    const claimedRecently = Number.isFinite(claimedAt) && now - claimedAt < SENDING_WINDOW_MINUTES.claimed * 60_000;
    const notSentForGood = target === 'email_meeting_followup' && !!d.followupNotSent;
    return { sent: !!sentAt, partly: false, sentAt, sending: !sentAt && !notSentForGood && (claimedRecently || (!!opts.approvedRecently && !h)), filedElsewhere: null, remaining: 0 };
}

/** Pure: approved (and last changed) within the last few minutes — its hand-offs are probably still running. */
export function approvedRecently(approvalStatus: unknown, updatedAt: unknown, now = Date.now()): boolean {
    if (approvalStatus !== 'approved' && approvalStatus !== 'scheduled') return false;
    const t = updatedAt instanceof Date ? updatedAt.getTime() : typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    return Number.isFinite(t) && now - t < SENDING_WINDOW_MINUTES.approved * 60_000;
}

/** Pure: how many action items a meeting carries (data.tasks). */
export function meetingTaskCount(data: unknown): number {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
    return Array.isArray(d.tasks) ? d.tasks.length : 0;
}

/** The targets switched on for this assistant, in display order. [] on a read failure (never throws). */
export async function loadMeetingSendTargets(db: Db, organisationId: number, aiAssistantId: number): Promise<MeetingSendTarget[]> {
    try {
        const rows = await db.select({ actionType: integrationScenarios.actionType })
            .from(activeScenarios)
            .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
            .where(and(
                eq(activeScenarios.organisationId, organisationId),
                eq(activeScenarios.assistantId, aiAssistantId),
                eq(activeScenarios.isEnabled, true),
                inArray(integrationScenarios.actionType, Object.keys(MEETING_SEND_TARGETS)),
            ));
        const on = new Set(rows.map((r) => r.actionType));
        return (Object.keys(MEETING_SEND_TARGETS) as MeetingSendTarget[]).filter((t) => on.has(t));
    } catch (err) {
        console.error('[meeting-send-to] could not read the switched-on tools (non-fatal)', err);
        return [];
    }
}
