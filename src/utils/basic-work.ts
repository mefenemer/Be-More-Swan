// src/utils/basic-work.ts
// Charging for chat, editing helpers, free design rounds and finished designs (owner, 2026-11-06).
//
// Everything here does nothing until the dated switch is on (basicWorkCharged, task-weights.ts), because
// customers were promised this work costs no tasks (terms 5.4) and a change needs 30 days' notice.
// docs/basic-work-charging.md is the switch-on checklist.
//
// Like the rest of the allowance: asked before the work, charged after it is delivered, and a metering
// fault never stops the work. Uploads, approving and scheduling stay free.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { basicWorkCharged } from '../config/task-weights';
import { getTaskCosts } from './task-costs';
import { getPeriodStart } from './atomic-cap-check';
import { hasTaskCapacity, recordCompletedWork } from './work-metering';

type Db = ReturnType<typeof getDb>;

/** Can this org use an editing helper that is not already asked through meterInteraction? */
export async function helperCapacity(db: Db, organisationId: number): Promise<boolean> {
    return !basicWorkCharged() || hasTaskCapacity(db, organisationId, (await getTaskCosts()).weights.editing_helper);
}

/** One delivered editing-helper action. Call only after it succeeded. Never throws. */
export async function chargeHelper(db: Db, organisationId: number, assistantId: number | null | undefined, ref: string | number): Promise<void> {
    if (!basicWorkCharged()) return;
    await recordCompletedWork(db, organisationId, 'editing_helper', { ref, assistantId: assistantId ?? null });
}

/**
 * One delivered chat reply. Every chatMessagesPerTask-th in the month records a task, counted in one
 * statement so two replies at once cannot both miss the boundary. Never throws: without
 * db/z-chat-task-tally.sql applied, chat carries on uncharged and the log says why.
 */
export async function chargeChatMessage(db: Db, organisationId: number, assistantId: number | null | undefined): Promise<void> {
    if (!basicWorkCharged()) return;
    try {
        const rows = await db.execute<{ messages: number }>(sql`
            INSERT INTO chat_task_tally (organisation_id, period_start, messages)
            VALUES (${organisationId}, ${getPeriodStart().toISOString()}, 1)
            ON CONFLICT (organisation_id, period_start)
            DO UPDATE SET messages = chat_task_tally.messages + 1, updated_at = now()
            RETURNING messages`);
        const messages = Number((rows as unknown as Array<{ messages: number }>)[0]?.messages ?? 0);
        if (messages > 0 && messages % (await getTaskCosts()).chatMessagesPerTask === 0) {
            await recordCompletedWork(db, organisationId, 'chat_messages', { ref: `chat-messages-${messages}`, assistantId: assistantId ?? null });
        }
    } catch (err) {
        console.error('[basic-work] could not count the chat message', { organisationId, message: err instanceof Error ? err.message : String(err) });
    }
}

const finishedRef = (optionId: number) => `design-option-${optionId}`;

/** Has this design already paid its one finished-design task? A failed read counts as no. */
async function designAlreadyCharged(db: Db, organisationId: number, optionId: number): Promise<boolean> {
    try {
        const rows = await db.execute<{ found: number }>(sql`
            SELECT 1 AS found FROM task_ledger
             WHERE organisation_id = ${organisationId} AND kind = 'finished_design' AND ref = ${finishedRef(optionId)} LIMIT 1`);
        return (rows as unknown as unknown[]).length > 0;
    } catch {
        return false;
    }
}

/** May this design be downloaded? A design that has paid is always yours to download again. */
export async function finishedDesignCapacity(db: Db, organisationId: number, optionId: number): Promise<boolean> {
    if (!basicWorkCharged() || await designAlreadyCharged(db, organisationId, optionId)) return true;
    return hasTaskCapacity(db, organisationId, (await getTaskCosts()).weights.finished_design);
}

/** A design's first download: its cost in tasks, once per design, print files included. Call after the file exists. Never throws. */
export async function chargeFinishedDesign(db: Db, organisationId: number, optionId: number): Promise<void> {
    if (!basicWorkCharged() || await designAlreadyCharged(db, organisationId, optionId)) return;
    // A failed lookup must not lose the charge: it is then just unattributed.
    const owner = await db.execute<{ ai_assistant_id: number | null }>(sql`
        SELECT b.ai_assistant_id FROM visual_brief_options o JOIN visual_briefs b ON b.id = o.brief_id
         WHERE o.id = ${optionId} AND o.organisation_id = ${organisationId} LIMIT 1`).catch(() => []);
    const assistantId = (owner as unknown as Array<{ ai_assistant_id: number | null }>)[0]?.ai_assistant_id ?? null;
    await recordCompletedWork(db, organisationId, 'finished_design', { ref: finishedRef(optionId), assistantId });
}
