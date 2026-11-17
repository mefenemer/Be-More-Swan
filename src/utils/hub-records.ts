// Structured assistant output filed into assistant_records (the Inbox / Data Hub tabs). Used by the chat
// (chat-orchestrator.ts) and the Meeting Note Taker's "New meeting" form (netlify/functions/meeting-minutes.ts),
// so both write a record the same way. New rows start pending_approval (the column default), which is what
// puts them in the Inbox.
//
// ── Two rules, by record type ─────────────────────────────────────────────────────────────────────
// LEADS, ENRICHMENT, INVOICES, TICKETS: upsert on (assistant, recordType, title) — the title IS the record's
// identity (the lead's name, the client on an aging invoice). A re-score or a re-chase refreshes the one row.
// Unchanged since before 2026-11-17: #719 briefly put every type under the meeting rule below, which would
// have added a new dated row on every chat run — duplicate leads and invoices, inflated goal counts, and an
// approved lead coming back as a new pending one (a second outreach email). Review of #719, 2026-11-17.
//
// MEETINGS: a title is NOT an identity — the model titles different meetings alike ("Weekly leadership
// meeting — 17 Nov 2026"), and matching on it let a later meeting overwrite an earlier one's summary, decisions
// and tasks, even an APPROVED one whose follow-up had gone out (staging timing test, record #925). So a meeting
// is only ever refreshed by an IDENTICAL re-run: a record of the same title (or that title with a date and
// time added) that is still waiting for approval and carries exactly the same content. Anything else is a new
// record, with the date and time added when the title is already taken. A clock window was tried first (#719)
// and still let two different meetings filed within the hour overwrite each other.
//
// One more refresh: a REVISION in chat. "Make Sam the owner of task 2" sends a new card with different content,
// which by the rule above would be a second waiting meeting — and the first card's Approve button would still
// send the out-of-date follow-up (#722 review). So the chat passes `reviseMeetingId`, the record its last
// meeting card in this conversation filed; a new card with the same title updates that record while it is
// still waiting. The "New meeting" form never passes it: every pasted set of notes is its own meeting.

import { and, desc, eq, like, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { assistantRecords } from '../../db/schema';

export type HubRecord = { recordType: string; title: string; status: string | null; data: unknown };

/** How many same-titled meetings are compared for an identical re-run. */
export const MEETING_MATCH_LOOKBACK = 10;

type MeetingCandidate = { id: number; title: string; approvalStatus: string | null; data: unknown };

/** Stable JSON for comparing a re-run's content: object keys sorted, so key order can't hide a match. Pure. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/**
 * Pure: for a MEETING, refresh an identical waiting re-run, or insert — under its own title when that title is
 * free, else with the date and time added. `candidates` are this assistant's meetings with this title or this
 * title plus a "(date, time)", newest first.
 */
export function meetingWriteDecision(candidates: readonly MeetingCandidate[], rec: HubRecord, now: Date, reviseMeetingId?: number | null):
    { refresh: number } | { insert: string } {
    // A revision in the same chat: the meeting it last filed, same title, still waiting.
    if (reviseMeetingId != null) {
        const revised = candidates.find((c) => c.id === reviseMeetingId && c.approvalStatus === 'pending_approval');
        if (revised) return { refresh: revised.id };
    }
    const content = stableJson(rec.data);
    const same = candidates.find((c) => c.approvalStatus === 'pending_approval' && stableJson(c.data) === content);
    if (same) return { refresh: same.id };
    const taken = candidates.some((c) => c.title === rec.title);
    return { insert: taken ? titleWithTime(rec.title, now) : rec.title };
}

/** Pure: "Weekly team meeting" → "Weekly team meeting (17 Nov 2026, 17:12)". UK time: the product is UK-first. */
export function titleWithTime(title: string, now: Date): string {
    const when = now.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    return `${title} (${when})`.slice(0, 300);
}

/** LIKE pattern for "<title> (…" with the title's own % _ \ taken literally. Pure. */
export function timedTitlePattern(title: string): string {
    return `${title.replace(/[\\%_]/g, (c) => `\\${c}`)} (%`;
}

export type HubWriteOptions = {
    /** Chat only: the meeting record this conversation's last meeting card filed — a same-titled new card revises it. */
    reviseMeetingId?: number | null;
};

/** Saves each record and returns their ids in order. Never throws: a failure is logged and skipped. */
export async function persistHubRecords(
    db: ReturnType<typeof getDb>,
    orgId: number,
    aiAssistantId: number,
    records: HubRecord[],
    opts: HubWriteOptions = {},
): Promise<number[]> {
    return (await persistHubRecordsWithTitles(db, orgId, aiAssistantId, records, opts)).map((r) => r.id);
}

/** As persistHubRecords, with each record's title as SAVED (a meeting may have had the date and time added). */
export async function persistHubRecordsWithTitles(
    db: ReturnType<typeof getDb>,
    orgId: number,
    aiAssistantId: number,
    records: HubRecord[],
    opts: HubWriteOptions = {},
): Promise<Array<{ id: number; title: string }>> {
    const ids: Array<{ id: number; title: string }> = [];
    if (records.length === 0) return ids;
    try {
        for (const rec of records) {
            const scope = and(
                eq(assistantRecords.organisationId, orgId),
                eq(assistantRecords.aiAssistantId, aiAssistantId),
                eq(assistantRecords.recordType, rec.recordType),
            );
            let refreshId: number | null = null;
            let insertTitle = rec.title;
            if (rec.recordType === 'meeting') {
                const candidates = await db
                    .select({ id: assistantRecords.id, title: assistantRecords.title, approvalStatus: assistantRecords.approvalStatus, data: assistantRecords.data })
                    .from(assistantRecords)
                    .where(and(scope, or(eq(assistantRecords.title, rec.title), like(assistantRecords.title, timedTitlePattern(rec.title)))))
                    .orderBy(desc(assistantRecords.createdAt))
                    .limit(MEETING_MATCH_LOOKBACK);
                const decision = meetingWriteDecision(candidates, rec, new Date(), opts.reviseMeetingId);
                if ('refresh' in decision) {
                    refreshId = decision.refresh;
                    insertTitle = candidates.find((c) => c.id === decision.refresh)?.title ?? rec.title;
                } else insertTitle = decision.insert;
            } else {
                const [existing] = await db
                    .select({ id: assistantRecords.id })
                    .from(assistantRecords)
                    .where(and(scope, eq(assistantRecords.title, rec.title)))
                    .limit(1);
                refreshId = existing?.id ?? null;
            }
            // source stays 'chat' for the form too: both are written by the assistant's model from the
            // user's own notes (the column's CHECK allows chat, csv_import, integration).
            if (refreshId != null) {
                await db.update(assistantRecords)
                    .set({ status: rec.status, data: rec.data, source: 'chat', updatedAt: new Date() })
                    .where(eq(assistantRecords.id, refreshId));
                ids.push({ id: refreshId, title: insertTitle });
            } else {
                const [made] = await db.insert(assistantRecords).values({
                    organisationId: orgId,
                    aiAssistantId,
                    recordType: rec.recordType,
                    title: insertTitle,
                    status: rec.status,
                    source: 'chat',
                    data: rec.data,
                }).returning({ id: assistantRecords.id });
                if (made) ids.push({ id: made.id, title: insertTitle });
            }
        }
    } catch (err) {
        console.error('[hub-records] record persistence failed:', err);
    }
    return ids;
}
