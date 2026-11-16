// Structured assistant output filed into assistant_records (the Inbox / Data Hub tabs). Used by the chat
// (chat-orchestrator.ts) and the Meeting Note Taker's "New meeting" form (netlify/functions/meeting-minutes.ts),
// so both write a meeting the same way: upsert on (assistant, recordType, title), so re-processing the
// same meeting refreshes its record instead of adding a second one. New rows start pending_approval
// (the column default), which is what puts them in the Inbox.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { assistantRecords } from '../../db/schema';

export type HubRecord = { recordType: string; title: string; status: string | null; data: unknown };

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
                .select({ id: assistantRecords.id })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, aiAssistantId),
                    eq(assistantRecords.recordType, rec.recordType),
                    eq(assistantRecords.title, rec.title),
                ))
                .limit(1);
            // source stays 'chat' for the form too: both are written by the assistant's model from the
            // user's own notes (the column's CHECK allows chat, csv_import, integration).
            if (existing) {
                await db.update(assistantRecords)
                    .set({ status: rec.status, data: rec.data, source: 'chat', updatedAt: new Date() })
                    .where(eq(assistantRecords.id, existing.id));
                ids.push(existing.id);
            } else {
                const [made] = await db.insert(assistantRecords).values({
                    organisationId: orgId,
                    aiAssistantId,
                    recordType: rec.recordType,
                    title: rec.title,
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
