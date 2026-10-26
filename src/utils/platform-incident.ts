// src/utils/platform-incident.ts — automatic incident reports (docs/business-mentor-plan.md §6.2).
//
// ONE helper every incident source calls. The trigger is deterministic code at the call site (a job
// failed after its last retry, a chat turn errored, a Mentor action threw), never the model's opinion.
// Rows go to issue_reports with source 'system', user_id NULL, so the admin portal's Report an Issue
// queue — and Pass to Developer — works on them unchanged, while no user ever sees or is told about one.
//
// ⚠️ Privacy (§6.2): the error, the role, ids and the view ONLY. No customer content, no prompts, no DB
// state. Messages are cut short and stripped of email addresses and quoted text before they are stored.
//
// De-duplicated: one row per fingerprint (kind + error class + role) per UK day; a repeat adds to
// `occurrences`. Rate-limited: at most MAX_NEW_PER_ORG_PER_DAY new rows per workspace per day.
// Never throws, and tolerates db/z-platform-incidents.sql not being applied yet.

import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';

type Db = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

export const MAX_NEW_PER_ORG_PER_DAY = 10;

/** What failed. The label is what the admin reads in the queue. */
export const INCIDENT_KINDS = {
    social_post_job: 'Social post drafting',
    social_post_job_upstream: 'Social post drafting (AI provider refusing)',
    blog_post_job: 'Blog drafting',
    chat_turn: 'Chat reply',
    chat_request: 'Chat request (before the reply)',
    mentor_action: 'Business Mentor action',
    mentor_job: 'Business Mentor background job',
    mentor_review: 'Business Mentor weekly review',
} as const;

export type IncidentKind = keyof typeof INCIDENT_KINDS;

export interface IncidentInput {
    kind: IncidentKind;
    error: unknown;
    organisationId?: number | null;
    assistantId?: number | null;
    /** The assistant's role (configuration ->> 'type'); looked up from assistantId when left out. */
    role?: string | null;
    /** Ids that locate the failure (job id, session id, attempt). Numbers and short strings only. */
    ids?: Record<string, string | number | null | undefined>;
    /** The view or endpoint, e.g. 'chat-orchestrator' or 'mentor:review_now'. */
    view?: string | null;
}

/** Pure: a short, stable name for the error — a Postgres code, an Error subclass, or the message's shape. */
export function errorClass(err: unknown): string {
    const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
    if (typeof e?.code === 'string' && e.code.length > 0 && e.code.length <= 24) return e.code;
    const name = typeof e?.name === 'string' && e.name.length <= 40 ? e.name : '';
    if (name && name !== 'Error') return name;
    const msg = typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : '';
    // A plain Error is identified by what it says, with the parts that vary between occurrences removed.
    const shape = scrub(msg).toLowerCase()
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\d+/g, '#')
        .replace(/[^a-z#:() -]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .trim();
    return shape || name || 'unknown';
}

/** Pure: strip anything that could be someone's content — emails, quoted text, URLs — and cut it short. */
export function scrub(message: string, max = 200): string {
    const out = String(message || '')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/[“"‘'][^“”"‘’']{3,}[”"’']/g, '[text]')
        .replace(/\s+/g, ' ')
        .trim();
    return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : out;
}

/** Pure: the dedupe key. Same kind, same error class, same role → the same incident for the day. */
export function fingerprintOf(kind: IncidentKind, cls: string, role: string | null | undefined): string {
    return createHash('sha1').update(`${kind}|${cls}|${role || '-'}`).digest('hex').slice(0, 20);
}

/** Pure: the UK calendar day, YYYY-MM-DD. */
export function ukDay(now = new Date()): string {
    return now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/** Pure: the queue's one-line description. */
export function describeIncident(kind: IncidentKind, cls: string, role: string | null | undefined): string {
    return `Automatic: ${INCIDENT_KINDS[kind]} failed${role ? ` (${role})` : ''} — ${cls}`;
}

function safeIds(ids: IncidentInput['ids']): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(ids ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'string' && v.length <= 64) out[k] = v;
    }
    return out;
}

let warnedMissing = false;
let readyCache: { ready: boolean; at: number } | null = null;

/**
 * Has db/z-platform-incidents.sql been applied? Cached per function instance: a yes is kept, a no is
 * re-checked after five minutes so the admin portal picks the columns up without a redeploy.
 */
export async function incidentColumnsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'issue_reports' AND column_name = 'incident_context' LIMIT 1`) as unknown[];
        readyCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}

export interface IncidentFields {
    source: 'user' | 'system' | 'suspected';
    occurrences: number;
    lastSeenAt: string | null;
    incident: Record<string, unknown> | null;
}

/** The incident columns for these issue ids (empty until the SQL is applied). Never throws. */
export async function loadIncidentFields(db: Db, ids: number[]): Promise<Map<number, IncidentFields>> {
    const out = new Map<number, IncidentFields>();
    const clean = ids.filter((id) => Number.isInteger(id));
    if (!clean.length || !(await incidentColumnsReady(db))) return out;
    try {
        const rows = await db.execute(sql`
            SELECT id, source, occurrences, last_seen_at::text AS last_seen_at, incident_context
              FROM issue_reports WHERE id IN (${sql.join(clean.map((id) => sql`${id}`), sql`, `)})`) as Array<Record<string, any>>;
        for (const r of rows) {
            out.set(Number(r.id), {
                source: r.source, occurrences: Number(r.occurrences) || 1,
                lastSeenAt: r.last_seen_at ?? null, incident: r.incident_context ?? null,
            });
        }
    } catch (err) {
        console.warn('[platform-incident] could not read incident fields:', (err as Error)?.message);
    }
    return out;
}

/** Record an incident. Best-effort: never throws, never blocks the caller's own error handling for long. */
export async function recordPlatformIncident(db: Db, input: IncidentInput): Promise<void> {
    try {
        const orgId = Number.isInteger(input.organisationId) ? Number(input.organisationId) : null;
        const assistantId = Number.isInteger(input.assistantId) ? Number(input.assistantId) : null;
        let role = input.role ?? null;
        if (!role && assistantId) {
            const rows = await db.execute(sql`SELECT configuration ->> 'type' AS role FROM ai_assistants WHERE id = ${assistantId}`) as Array<{ role: string | null }>;
            role = rows?.[0]?.role ?? null;
        }
        const cls = errorClass(input.error);
        const fp = fingerprintOf(input.kind, cls, role);
        const day = ukDay();
        const e = input.error as { message?: unknown } | null;
        const context = {
            kind: input.kind,
            errorClass: cls,
            message: scrub(typeof e?.message === 'string' ? e.message : typeof input.error === 'string' ? input.error : ''),
            role,
            assistantId,
            view: input.view ? String(input.view).slice(0, 80) : null,
            ids: safeIds(input.ids),
        };

        // Rate limit (per workspace per day). A repeat of an incident already recorded today still counts.
        const [{ n }] = await db.execute(sql`
            SELECT count(*)::int AS n FROM issue_reports
             WHERE source <> 'user' AND fingerprint_day = ${day}::date
               AND organisation_id IS NOT DISTINCT FROM ${orgId}::int`) as Array<{ n: number }>;
        if (n >= MAX_NEW_PER_ORG_PER_DAY) {
            await db.execute(sql`
                UPDATE issue_reports SET occurrences = occurrences + 1, last_seen_at = now()
                 WHERE fingerprint = ${fp} AND fingerprint_day = ${day}::date`);
            return;
        }

        await db.execute(sql`
            INSERT INTO issue_reports (organisation_id, user_id, source, description, source_location,
                                       fingerprint, fingerprint_day, occurrences, last_seen_at, incident_context)
            VALUES (${orgId}, NULL, 'system', ${describeIncident(input.kind, cls, role)}, ${`System · ${INCIDENT_KINDS[input.kind]}`},
                    ${fp}, ${day}::date, 1, now(), ${JSON.stringify(context)}::jsonb)
            ON CONFLICT (fingerprint, fingerprint_day) WHERE fingerprint IS NOT NULL
            DO UPDATE SET occurrences = issue_reports.occurrences + 1, last_seen_at = now(),
                          incident_context = EXCLUDED.incident_context`);
    } catch (err) {
        const code = (err as { code?: string })?.code;
        // 42703 undefined column / 42P10 no matching unique index: db/z-platform-incidents.sql isn't applied.
        if (code === '42703' || code === '42P10' || code === '23502') {
            if (!warnedMissing) console.warn('[platform-incident] not switched on yet — apply db/z-platform-incidents.sql');
            warnedMissing = true;
            return;
        }
        console.warn('[platform-incident] could not record (non-blocking):', (err as Error)?.message);
    }
}
