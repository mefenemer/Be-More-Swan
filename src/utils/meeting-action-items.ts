// Meeting Note Taker: the pure parts of the action-item ledger (docs/meeting-note-taker-finish-plan.md
// step 2). assistant-records.ts writes the rows and attaches the sync state; sync-action.ts files the
// tickets. Both call these so tests/meeting-note-taker.test.ts can pin the behaviour without a database.

import type { TicketRef } from './pm-tickets';

export type ActionItemSyncStatus = 'pending' | 'synced' | 'failed' | 'skipped';

export interface ActionItemRow {
    organisationId: number;
    aiAssistantId: number;
    meetingRecordId: number;
    description: string;
    assignee: string | null;
    dueDate: string | null;
}

/**
 * The action_items rows one approved meeting record should have: one per task with a description,
 * trimmed and capped to the column sizes. `data.actionItems` is the older key and still read.
 * Anything that is not a meeting gives none.
 */
export function actionItemRowsFromMeeting(
    orgId: number,
    record: { id: number; recordType: string; aiAssistantId: number; data: unknown },
): ActionItemRow[] {
    if (record.recordType !== 'meeting') return [];
    const data = (record.data && typeof record.data === 'object') ? record.data as Record<string, unknown> : {};
    const rawTasks = Array.isArray(data.tasks) ? data.tasks
        : Array.isArray(data.actionItems) ? data.actionItems : [];
    const seen = new Set<string>();
    const rows: ActionItemRow[] = [];
    for (const t of rawTasks as unknown[]) {
        if (!t || typeof t !== 'object') continue;
        const task = t as Record<string, unknown>;
        if (typeof task.description !== 'string' || !task.description.trim()) continue;
        const description = task.description.trim().slice(0, 2000);
        // The ledger is unique on (meeting, description): a repeated task would make the second
        // upsert overwrite the first's owner and date inside one approval.
        if (seen.has(description)) continue;
        seen.add(description);
        rows.push({
            organisationId: orgId,
            aiAssistantId: record.aiAssistantId,
            meetingRecordId: record.id,
            description,
            assignee: typeof task.assignee === 'string' ? task.assignee.slice(0, 200) : null,
            dueDate: typeof task.dueDate === 'string' ? task.dueDate.slice(0, 200) : null,
        });
    }
    return rows;
}

/** The "N of M synced" figures the Inbox card draws, from one meeting's ledger rows. */
export function summariseActionItemSync<T extends { syncStatus: string }>(items: readonly T[]) {
    const count = (s: ActionItemSyncStatus) => items.filter((i) => i.syncStatus === s).length;
    return {
        total: items.length,
        synced: count('synced'),
        failed: count('failed'),
        pending: count('pending'),
        skipped: count('skipped'),
        items: [...items],
    };
}


export type TicketOutcome<R> =
    | { row: R; ok: true; ticket: TicketRef }
    | { row: R; ok: false; error: string };

/**
 * File one ticket per row, in order. One bad task never stops the rest: its error is kept and the
 * next row is tried. `stamp` runs after EACH row, before the next ticket is made, so a run cut short
 * leaves at most one filed ticket unrecorded (which the retry would file again).
 */
export async function fileTickets<R>(
    rows: readonly R[],
    create: (row: R) => Promise<TicketRef>,
    stamp: (outcome: TicketOutcome<R>) => Promise<void> = async () => {},
): Promise<{ outcomes: TicketOutcome<R>[]; synced: number; failed: number }> {
    const outcomes: TicketOutcome<R>[] = [];
    for (const row of rows) {
        let outcome: TicketOutcome<R>;
        try {
            outcome = { row, ok: true, ticket: await create(row) };
        } catch (e) {
            outcome = { row, ok: false, error: String((e as Error)?.message ?? 'The task tracker rejected the ticket.').slice(0, 500) };
        }
        outcomes.push(outcome);
        await stamp(outcome);
    }
    const synced = outcomes.filter((o) => o.ok).length;
    return { outcomes, synced, failed: outcomes.length - synced };
}

/** The handler's reply for a batch: 502 only when nothing synced and something failed, so the job retries. */
export function createTasksResult(label: string, synced: number, failed: number, total: number) {
    const message = `${synced} of ${total} action item${total === 1 ? '' : 's'} filed to ${label}${failed ? `, ${failed} failed` : ''}.`;
    return {
        status: synced === 0 && failed > 0 ? 502 : 200,
        body: { success: synced > 0, synced, failed, skipped: 0, total, message },
    };
}

/** The reply when the tracker is not connected at sync time: every waiting row is left skipped. */
export function notConnectedResult(label: string, total: number) {
    return {
        status: 200,
        body: {
            success: true, synced: 0, failed: 0, skipped: total, total,
            message: `${label} isn't connected — ${total} action item${total === 1 ? '' : 's'} left unsynced.`,
        },
    };
}
