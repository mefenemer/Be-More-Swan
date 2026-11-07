// src/utils/assistant-notes.ts — what an assistant noticed about Be More Swan, sent to our queues unprompted
// (owner, 2026-11-07: "I would expect them to be raising quite a few into the appropriate queues").
//
//   a bug → issue_reports, source 'suspected': Admin ▸ Report an Issue. Never in "Pass all to Developer", so text
//           a model wrote, in a conversation a customer can steer, only reaches the AI developer by a person's hand.
//   a gap → feature_requests, 'pending_review': Admin ▸ Feature Requests. Not on the public board until reviewed.
//
// The assistant adds one line to its reply; extractAssistantNote takes it out BEFORE the reply is parsed, shown or
// stored, so the user never sees it and later turns don't repeat it.
//
// ⚠️ Privacy: this is the one report written by the model, from a private chat. It carries the role, a short area
// and one sentence about the product. No session id, no user, no chat text. The prompt forbids customer content and
// cleanNoteText removes what it can recognise anyway: that is a net, not a guarantee.
//
// Merged: one bug row per role + area while it is open, across workspaces and days (occurrences counts them); the
// same for a gap. Limited to MAX_NOTES_PER_ORG_PER_DAY new rows per workspace per day; a repeat still counts.
// Never throws: a note must never cost the user their reply.

import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { incidentColumnsReady, scrub, ukDay } from './platform-incident';

type Db = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

export const MAX_NOTES_PER_ORG_PER_DAY = 5;
/** Merge a bug into its open row for this long; after that it counts as new. */
const MERGE_DAYS = 30;

export interface AssistantNote { kind: 'bug' | 'gap'; area: string; text: string }

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

async function recordBug(db: Db, a: { orgId: number; assistantId: number; role: string | null; area: string; sentence: string; day: string }): Promise<void> {
    if (!(await incidentColumnsReady(db))) return;   // db/z-platform-incidents.sql isn't applied here
    const fp = noteFingerprint('bug', a.role, a.area);
    const open = await db.execute(sql`
        SELECT id FROM issue_reports
         WHERE fingerprint = ${fp} AND source = 'suspected' AND status <> 'closed'
           AND created_at >= now() - make_interval(days => ${MERGE_DAYS})
         ORDER BY id DESC LIMIT 1`) as Array<{ id: number }>;
    if (open[0]) {
        await db.execute(sql`UPDATE issue_reports SET occurrences = occurrences + 1, last_seen_at = now() WHERE id = ${open[0].id}`);
        return;
    }
    if (!(await underDailyLimit(db, a.orgId, a.day))) return;
    const context = { kind: 'assistant_note', errorClass: 'Noticed by an assistant', message: a.sentence, role: a.role, assistantId: a.assistantId, view: `Area: ${a.area}`, ids: {} };
    await db.execute(sql`
        INSERT INTO issue_reports (organisation_id, user_id, source, description, source_location,
                                   fingerprint, fingerprint_day, occurrences, last_seen_at, incident_context)
        VALUES (${a.orgId}, NULL, 'suspected', ${`Assistant noticed${a.role ? ` (${a.role})` : ''}: ${a.sentence}`}, ${`Assistant · ${a.area}`},
                ${fp}, ${a.day}::date, 1, now(), ${JSON.stringify(context)}::jsonb)
        ON CONFLICT (fingerprint, fingerprint_day) WHERE fingerprint IS NOT NULL
        DO UPDATE SET occurrences = issue_reports.occurrences + 1, last_seen_at = now()`);
}

async function recordGap(db: Db, a: { orgId: number; role: string | null; area: string; sentence: string; day: string }): Promise<void> {
    const open = await db.execute(sql`
        SELECT id, description FROM feature_requests
         WHERE source = 'manual' AND submitted_by IS NULL AND lower(title) = ${a.area}
           AND assistant_ref IS NOT DISTINCT FROM ${a.role} AND status NOT IN ('declined', 'released', 'duplicate')
         ORDER BY id DESC LIMIT 1`) as Array<{ id: number; description: string | null }>;
    if (open[0]) {
        await db.execute(sql`UPDATE feature_requests SET description = ${withNoticedCount(open[0].description, a.sentence)}, updated_at = now() WHERE id = ${open[0].id}`);
        return;
    }
    if (!(await underDailyLimit(db, a.orgId, a.day))) return;
    const title = a.area.charAt(0).toUpperCase() + a.area.slice(1);
    // 'manual': the table's source list has no assistant value; submitted_by NULL is what marks these, and keeps them
    // out of any user's "mine" list and status-change notifications. 'pending_review' keeps them off the public board.
    await db.execute(sql`
        INSERT INTO feature_requests (organisation_id, title, description, submitter_description, category, assistant_ref, status, source)
        VALUES (${a.orgId}, ${title}, ${`Noticed by an assistant: ${a.sentence}`}, ${a.sentence}, ${a.role ? 'existing_assistant' : 'app_core'}, ${a.role}, 'pending_review', 'manual')`);
}

/** Send a note to its queue. Best-effort: never throws. `names` are removed from it (the business, the assistant). */
export async function recordAssistantNote(db: Db, input: { note: AssistantNote; organisationId: number; assistantId: number; role: string | null; names?: Array<string | null | undefined> }): Promise<void> {
    try {
        const area = normaliseArea(input.note.area, input.names);
        const sentence = cleanNoteText(input.note.text, input.names);
        if (!area || !sentence) return;
        const a = { orgId: input.organisationId, assistantId: input.assistantId, role: input.role, area, sentence, day: ukDay() };
        if (input.note.kind === 'bug') await recordBug(db, a);
        else await recordGap(db, a);
    } catch (err) {
        console.warn('[assistant-notes] could not record (non-blocking):', (err as Error)?.message);
    }
}
