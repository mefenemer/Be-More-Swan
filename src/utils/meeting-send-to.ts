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

/** The per-task ledger summary the records GET attaches (assistant-records.ts attachActionItemSync). */
export interface ActionItemSyncSummary { total?: number; synced?: number; failed?: number }

export type MeetingSendState = { sent: boolean; partly: boolean; sentAt: string | null };

/**
 * Pure: whether this meeting has gone to this target. Slack/Notion/email: the once-per-meeting stamp
 * (data.handoffs[actionType].sentAt; for the email, also the older data.followupSentAt). Jira/Asana: every action
 * item in the ledger synced (partly = some are).
 */
export function meetingSendState(target: MeetingSendTarget, data: unknown, sync?: ActionItemSyncSummary | null): MeetingSendState {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (MEETING_TASK_TARGETS.has(target)) {
        const total = Number(sync?.total ?? 0);
        const synced = Number(sync?.synced ?? 0);
        return { sent: total > 0 && synced >= total, partly: synced > 0 && synced < total, sentAt: null };
    }
    const h = d.handoffs && typeof d.handoffs === 'object' ? (d.handoffs as Record<string, unknown>)[target] : null;
    const stamped = h && typeof h === 'object' && typeof (h as { sentAt?: unknown }).sentAt === 'string' ? (h as { sentAt: string }).sentAt : null;
    const legacy = target === 'email_meeting_followup' && typeof d.followupSentAt === 'string' ? d.followupSentAt : null;
    const sentAt = stamped ?? legacy;
    return { sent: !!sentAt, partly: false, sentAt };
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
