// src/utils/assistant-notes.ts — what an assistant noticed about Be More Swan, sent to our queues unprompted
// (owner, 2026-11-07: "I would expect them to be raising quite a few into the appropriate queues").
//
//   a bug → issue_reports, source 'suspected': Admin ▸ Report an Issue. Never in "Pass all to Developer", so text
//           a model wrote, in a conversation a customer can steer, only reaches the AI developer by a person's hand.
//   a gap → feature_requests, 'pending_review': Admin ▸ Feature Requests. Not on the public board until reviewed.
//
// The assistant adds one line to its reply; extractAssistantNote takes it out BEFORE the reply is parsed, shown or
// stored, so the user never sees it. Because it is taken out, the model can't see on later turns that it already
// told us, and it used to tell us again on every reply (prod 2026-11-26: issues #93, #94, #96 and feature request
// #67 from ONE chat, beside the user's own report #95). So the server keeps track:
//   - ONE note per chat (a bug or a gap) in SAME_CHAT_HOURS. A hidden role 'system' row in that chat
//     ("[platform-note] …") records which ticket it raised; any later note from that chat is dropped.
//   - No note on a reply that carries the user's own report card (the orchestrator checks that).
//   - When the user sends a report from that chat (linkUserReportToNotes), the chat's notes are closed as
//     duplicates of it, and later notes from the chat are dropped as well.
// The marker lives in the customer's own chat, which already holds the conversation; the ticket still names no chat.
//
// ⚠️ Privacy: this is the one report written by the model, from a private chat. It carries the role, a short area
// and one sentence about the product. No session id, no user, no chat text. The prompt forbids customer content and
// cleanNoteText removes what it can recognise anyway: that is a net, not a guarantee.
//
// Merged: one bug row per role + area while it is open, across workspaces and days (occurrences counts them, one per
// chat); the same for a gap. Limited to MAX_NOTES_PER_ORG_PER_DAY new rows per workspace per day; a repeat still counts.
// Never throws: a note must never cost the user their reply.

import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { incidentColumnsReady, scrub, ukDay } from './platform-incident';

type Db = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

export const MAX_NOTES_PER_ORG_PER_DAY = 5;
/** Merge a bug into its open row for this long; after that it counts as new. */
const MERGE_DAYS = 30;

export interface AssistantNote { kind: 'bug' | 'gap'; area: string; text: string }

/** The hidden chat row's prefix. Role 'system' rows never reach the transcript or the model. */
export const NOTE_MARKER = '[platform-note]';
/** One note per chat for this long; after that the same chat may tell us about something else. */
export const SAME_CHAT_HOURS = 24;

/** What a chat has already sent us: a ticket an assistant raised, or the user's own report. */
export interface RaisedTicket { table: 'issue_reports' | 'feature_requests'; id: number; by: 'assistant' | 'user' }

/** Pure: the marker row's text and payload. */
export function noteMarker(r: RaisedTicket): { content: string; payload: RaisedTicket } {
    const what = r.table === 'issue_reports' ? 'issue' : 'feature request';
    return { content: `${NOTE_MARKER} ${r.by === 'user' ? 'the user reported' : 'an assistant noted'} ${what} #${r.id}`, payload: { table: r.table, id: r.id, by: r.by } };
}

function asRaised(v: unknown): RaisedTicket | null {
    const o = (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v) as Partial<RaisedTicket> | null;
    if (!o || (o.table !== 'issue_reports' && o.table !== 'feature_requests') || !Number.isInteger(o.id) || (o.by !== 'assistant' && o.by !== 'user')) return null;
    return { table: o.table, id: Number(o.id), by: o.by };
}

/** What this chat has sent us in the last SAME_CHAT_HOURS, oldest first. */
export async function raisedInChat(db: Db, chatSessionId: number): Promise<RaisedTicket[]> {
    const rows = await db.execute(sql`
        SELECT ui_element_json AS m FROM chat_messages
         WHERE chat_session_id = ${chatSessionId} AND role = 'system' AND left(content, ${NOTE_MARKER.length}) = ${NOTE_MARKER}
           AND created_at >= now() - make_interval(hours => ${SAME_CHAT_HOURS})
         ORDER BY id`) as Array<{ m: unknown }>;
    return rows.map((r) => asRaised(r.m)).filter((r): r is RaisedTicket => !!r);
}

async function markChat(db: Db, chatSessionId: number, r: RaisedTicket): Promise<void> {
    const m = noteMarker(r);
    await db.execute(sql`
        INSERT INTO chat_messages (chat_session_id, role, content, ui_element_json)
        VALUES (${chatSessionId}, 'system', ${m.content}, ${JSON.stringify(m.payload)}::jsonb)`);
}

const NOTE = /<<platform_note\|(bug|gap)\|([^|<>\n]{1,80})\|([^<>\n]{1,600})>>/;
/** Anything that starts like a note, well-formed or not, so a malformed one can't reach the user. Stops at a JSON string's end. */
const ANY_NOTE = /[ \t]*<<platform_note\b[^\n"]*?(?:>>|(?=["\n])|$)/g;

/** Pure: the reply without any note, and the first well-formed note. */
export function extractAssistantNote(raw: string): { text: string; note: AssistantNote | null } {
    const m = NOTE.exec(raw);
    const text = raw.replace(ANY_NOTE, '').replace(/\s+$/, '');
    if (!m) return { text, note: null };
    return { text, note: { kind: m[1] as 'bug' | 'gap', area: m[2].trim(), text: m[3].trim() } };
}

/** Pure: remove what we can recognise as someone's: emails, links, quoted text, phone or long numbers, the given names. */
export function cleanNoteText(text: string, names: Array<string | null | undefined> = [], max = 300): string {
    let out = text;
    for (const n of names) {
        const name = String(n ?? '').trim();
        if (name.length < 3) continue;
        out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[name]');
    }
    return scrub(out.replace(/[£$€]\s?\d[\d,.]*/g, '[amount]').replace(/\+?\d[\d\s()-]{6,}\d/g, '[number]'), max);
}

/** Pure: the merge key's area: lower case, plain words. Empty when nothing is left of it. */
export function normaliseArea(area: string, names: Array<string | null | undefined> = []): string {
    return cleanNoteText(area, names, 60).toLowerCase().replace(/\[[a-z]+\]/g, ' ').replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function noteFingerprint(kind: string, role: string | null | undefined, area: string): string {
    return createHash('sha1').update(`assistant_note|${kind}|${role || '-'}|${area}`).digest('hex').slice(0, 20);
}

/** Pure: "Noticed by assistants 3 times." kept under a gap's description, as that table has no counter. */
export function withNoticedCount(description: string | null, sentence: string): string {
    const m = /\n\nNoticed by assistants (\d+) times\.$/.exec(description ?? '');
    const base = m ? (description as string).slice(0, m.index) : (description || sentence);
    return `${base}\n\nNoticed by assistants ${(m ? Number(m[1]) : 1) + 1} times.`;
}

async function underDailyLimit(db: Db, orgId: number, day: string): Promise<boolean> {
    const [{ n }] = await db.execute(sql`
        SELECT (SELECT count(*) FROM issue_reports WHERE source = 'suspected' AND fingerprint_day = ${day}::date AND organisation_id = ${orgId})::int
             + (SELECT count(*) FROM feature_requests WHERE source = 'manual' AND submitted_by IS NULL AND organisation_id = ${orgId}
                  AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date = ${day}::date)::int AS n`) as Array<{ n: number }>;
    return Number(n) < MAX_NOTES_PER_ORG_PER_DAY;
}

async function recordBug(db: Db, a: { orgId: number; assistantId: number; role: string | null; area: string; sentence: string; day: string }): Promise<number | null> {
    if (!(await incidentColumnsReady(db))) return null;   // db/z-platform-incidents.sql isn't applied here
    const fp = noteFingerprint('bug', a.role, a.area);
    const open = await db.execute(sql`
        SELECT id FROM issue_reports
         WHERE fingerprint = ${fp} AND source = 'suspected' AND status <> 'closed'
           AND created_at >= now() - make_interval(days => ${MERGE_DAYS})
         ORDER BY id DESC LIMIT 1`) as Array<{ id: number }>;
    if (open[0]) {
        await db.execute(sql`UPDATE issue_reports SET occurrences = occurrences + 1, last_seen_at = now() WHERE id = ${open[0].id}`);
        return open[0].id;
    }
    if (!(await underDailyLimit(db, a.orgId, a.day))) return null;
    const context = { kind: 'assistant_note', errorClass: 'Noticed by an assistant', message: a.sentence, role: a.role, assistantId: a.assistantId, view: `Area: ${a.area}`, ids: {} };
    const rows = await db.execute(sql`
        INSERT INTO issue_reports (organisation_id, user_id, source, description, source_location,
                                   fingerprint, fingerprint_day, occurrences, last_seen_at, incident_context)
        VALUES (${a.orgId}, NULL, 'suspected', ${`Assistant noticed${a.role ? ` (${a.role})` : ''}: ${a.sentence}`}, ${`Assistant · ${a.area}`},
                ${fp}, ${a.day}::date, 1, now(), ${JSON.stringify(context)}::jsonb)
        ON CONFLICT (fingerprint, fingerprint_day) WHERE fingerprint IS NOT NULL
        DO UPDATE SET occurrences = issue_reports.occurrences + 1, last_seen_at = now()
        RETURNING id`) as Array<{ id: number }>;
    return rows?.[0]?.id ?? null;
}

async function recordGap(db: Db, a: { orgId: number; role: string | null; area: string; sentence: string; day: string }): Promise<number | null> {
    const open = await db.execute(sql`
        SELECT id, description FROM feature_requests
         WHERE source = 'manual' AND submitted_by IS NULL AND lower(title) = ${a.area}
           AND assistant_ref IS NOT DISTINCT FROM ${a.role} AND status NOT IN ('declined', 'released', 'duplicate')
         ORDER BY id DESC LIMIT 1`) as Array<{ id: number; description: string | null }>;
    if (open[0]) {
        await db.execute(sql`UPDATE feature_requests SET description = ${withNoticedCount(open[0].description, a.sentence)}, updated_at = now() WHERE id = ${open[0].id}`);
        return open[0].id;
    }
    if (!(await underDailyLimit(db, a.orgId, a.day))) return null;
    const title = a.area.charAt(0).toUpperCase() + a.area.slice(1);
    // 'manual': the table's source list has no assistant value; submitted_by NULL is what marks these, and keeps them
    // out of any user's "mine" list and status-change notifications. 'pending_review' keeps them off the public board.
    const rows = await db.execute(sql`
        INSERT INTO feature_requests (organisation_id, title, description, submitter_description, category, assistant_ref, status, source)
        VALUES (${a.orgId}, ${title}, ${`Noticed by an assistant: ${a.sentence}`}, ${a.sentence}, ${a.role ? 'existing_assistant' : 'app_core'}, ${a.role}, 'pending_review', 'manual')
        RETURNING id`) as Array<{ id: number }>;
    return rows?.[0]?.id ?? null;
}

/**
 * Send a note to its queue. Best-effort: never throws. `names` are removed from it (the business, the assistant).
 * With `chatSessionId`, a chat that has already sent us something (a note, or the user's own report) sends nothing more.
 */
export async function recordAssistantNote(db: Db, input: { note: AssistantNote; organisationId: number; assistantId: number; role: string | null; names?: Array<string | null | undefined>; chatSessionId?: number | null }): Promise<void> {
    try {
        const area = normaliseArea(input.note.area, input.names);
        const sentence = cleanNoteText(input.note.text, input.names);
        if (!area || !sentence) return;
        const chat = Number.isInteger(input.chatSessionId) ? Number(input.chatSessionId) : null;
        if (chat !== null && (await raisedInChat(db, chat)).length) return;
        const a = { orgId: input.organisationId, assistantId: input.assistantId, role: input.role, area, sentence, day: ukDay() };
        const id = input.note.kind === 'bug' ? await recordBug(db, a) : await recordGap(db, a);
        if (chat !== null && id) await markChat(db, chat, { table: input.note.kind === 'bug' ? 'issue_reports' : 'feature_requests', id, by: 'assistant' });
    } catch (err) {
        console.warn('[assistant-notes] could not record (non-blocking):', (err as Error)?.message);
    }
}

/**
 * The user sent their own report (issue or feature request) from a chat's report card: that chat's assistant notes are
 * duplicates of it. A note only this chat raised is closed (an issue) or marked 'duplicate' (a gap), pointing at the
 * user's report; one that other chats also raised stays open with an internal line saying so. Then the chat is marked,
 * so no later note from it is sent. Only the user's own chat in their workspace. Best-effort: never throws.
 */
export async function linkUserReportToNotes(db: Db, input: { chatSessionId: unknown; organisationId: number | null; userId: number; report: { table: RaisedTicket['table']; id: number } }): Promise<void> {
    try {
        const chat = Number(input.chatSessionId);
        if (!Number.isInteger(chat) || chat <= 0 || input.organisationId == null) return;
        const own = await db.execute(sql`
            SELECT 1 FROM chat_sessions WHERE id = ${chat} AND organisation_id = ${input.organisationId} AND user_id = ${input.userId}`) as unknown[];
        if (!own.length) return;
        const ref = `${input.report.table === 'issue_reports' ? 'issue' : 'feature request'} #${input.report.id}`;
        for (const n of (await raisedInChat(db, chat)).filter((r) => r.by === 'assistant')) {
            if (n.table === 'issue_reports') {
                const closed = await db.execute(sql`
                    UPDATE issue_reports SET status = 'closed', resolved_at = now(), updated_at = now()
                     WHERE id = ${n.id} AND source = 'suspected' AND status = 'reported' AND occurrences <= 1
                    RETURNING id`) as unknown[];
                await db.execute(sql`
                    INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
                    VALUES (${n.id}, 'admin', NULL, ${closed.length
                        ? `Duplicate of ${ref}: the user reported this themselves, from the chat it was noticed in. Closed automatically.`
                        : `The user reported this themselves as ${ref}, from the chat it was noticed in. Left open: other chats noticed it too, or it is already being worked on.`}, ${closed.length ? 'closed' : null})`);
                await db.execute(sql`UPDATE issue_reports SET updated_at = now() WHERE id = ${n.id}`);
            } else {
                // A gap merged from other chats carries "Noticed by assistants N times." and stays as it is.
                const toIssue = input.report.table === 'issue_reports' ? input.report.id : null;
                const toFeature = input.report.table === 'feature_requests' ? input.report.id : null;
                await db.execute(sql`
                    UPDATE feature_requests
                       SET status = 'duplicate', issue_id = COALESCE(${toIssue}::int, issue_id), merged_into_id = COALESCE(${toFeature}::int, merged_into_id), updated_at = now()
                     WHERE id = ${n.id} AND submitted_by IS NULL AND status = 'pending_review'
                       AND COALESCE(description, '') NOT LIKE '%Noticed by assistants % times.'`);
            }
        }
        await markChat(db, chat, { table: input.report.table, id: input.report.id, by: 'user' });
    } catch (err) {
        console.warn('[assistant-notes] could not link the user report (non-blocking):', (err as Error)?.message);
    }
}
