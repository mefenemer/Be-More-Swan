// Structured assistant output filed into assistant_records (the Inbox / Data Hub tabs). Used by the chat
// (chat-orchestrator.ts) and the Meeting Note Taker's "New meeting" form (netlify/functions/meeting-minutes.ts),
// so both write a record the same way.
//
// Re-processing the SAME notes refreshes the record instead of adding a second one — but only a record that is
// still waiting for approval and was written in the last hour (REFRESH_WINDOW_MS). Before 2026-11-17 the match
// was on the title alone, forever: three different 60-minute meetings the model titled alike ("Weekly
// leadership meeting — 17 Nov 2026") all landed in one record, and a later meeting could silently rewrite an
// APPROVED one whose follow-up and tasks had already gone out. Anything else is a new record; when its title is
// already taken, the date and time are added so the two can be told apart in the Inbox.
// New rows start pending_approval (the column default), which is what puts them in the Inbox.

import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { assistantRecords } from '../../db/schema';

export type HubRecord = { recordType: string; title: string; status: string | null; data: unknown };

/** How long after it was written a waiting record may still be refreshed by the same notes. */
export const REFRESH_WINDOW_MS = 60 * 60 * 1000;

type Existing = { id: number; approvalStatus: string | null; createdAt: Date | string };

/**
 * Pure: refresh the record with this title, or write a new one (with the date and time added when the title
 * is taken). `existing` is the newest record with the same title, or null.
 */
export function hubWriteDecision(existing: Existing | null, title: string, now: Date):
    { refresh: number } | { insert: string } {
    if (!existing) return { insert: title };
    const age = now.getTime() - new Date(existing.createdAt).getTime();
    if (existing.approvalStatus === 'pending_approval' && age >= 0 && age <= REFRESH_WINDOW_MS) return { refresh: existing.id };
    return { insert: titleWithTime(title, now) };
}

/** Pure: "Weekly team meeting" → "Weekly team meeting (17 Nov 2026, 17:12)". UK time: the product is UK-first. */
export function titleWithTime(title: string, now: Date): string {
    const when = now.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    return `${title} (${when})`.slice(0, 300);
}

/** Saves each record and returns their ids in order. Never throws: a failure is logged and skipped. */
export async function persistHubRecords(
    db: ReturnType<typeof getDb>,
    orgId: number,
    aiAssistantId: number,
    records: HubRecord[],
): Promise<number[]> {
    const ids: number[] = [];
    if (records.length === 0) return ids;
    try {
        for (const rec of records) {
            const [existing] = await db
                .select({ id: assistantRecords.id, approvalStatus: assistantRecords.approvalStatus, createdAt: assistantRecords.createdAt })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, aiAssistantId),
                    eq(assistantRecords.recordType, rec.recordType),
                    eq(assistantRecords.title, rec.title),
                ))
                .orderBy(desc(assistantRecords.createdAt))
                .limit(1);
            const decision = hubWriteDecision(existing ?? null, rec.title, new Date());
            // source stays 'chat' for the form too: both are written by the assistant's model from the
            // user's own notes (the column's CHECK allows chat, csv_import, integration).
            if ('refresh' in decision) {
                await db.update(assistantRecords)
                    .set({ status: rec.status, data: rec.data, source: 'chat', updatedAt: new Date() })
                    .where(eq(assistantRecords.id, decision.refresh));
                ids.push(decision.refresh);
            } else {
                const [made] = await db.insert(assistantRecords).values({
                    organisationId: orgId,
                    aiAssistantId,
                    recordType: rec.recordType,
                    title: decision.insert,
                    status: rec.status,
                    source: 'chat',
                    data: rec.data,
                }).returning({ id: assistantRecords.id });
                if (made) ids.push(made.id);
            }
        }
    } catch (err) {
        console.error('[hub-records] record persistence failed:', err);
    }
    return ids;
}
