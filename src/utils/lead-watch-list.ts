// src/utils/lead-watch-list.ts
// The Watch list's tenant actions (buying triggers Phase 2). ONE implementation for the Watch list tab
// and the Lead Generator chat (netlify/functions/lead-watch.ts serves both; the chat card's button posts
// to the same endpoint, assistant-gui-chat-parity). Every query is scoped by organisation AND assistant.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { getCompanyProfile, isCompaniesHouseConfigured, searchCompaniesForPicker } from '../lib/companies-house';
import { companyUrl, normaliseCompanyNumber } from '../lib/triggers/ch-watch';
import { isClosingStatus } from '../lib/triggers/ch-watch';
import { isStreamConfigured, WATCH_SOURCE } from './lead-watch';

type Db = ReturnType<typeof getDb>;

export const MAX_MANUAL_PER_ASSISTANT = 200;
const SIGNAL_DAYS = 90;

export interface WatchListItem {
    id: number;
    kind: 'lead' | 'customer' | 'manual';
    companyName: string | null;
    chNumber: string;
    url: string;
    status: string | null;
    closing: boolean;
    watching: boolean;
    pausedReason: string | null;
    lastCheckedAt: string | null;
    recordId: number | null;
    latest: { text: string; direction: string; occurredOn: string; url: string | null } | null;
}

export interface WatchSignalItem {
    id: number;
    watchId: number;
    companyName: string | null;
    kind: string;
    text: string;
    direction: string;
    occurredOn: string;
    url: string | null;
    recordId: number | null;
    seenAt: string;
}

export interface WatchListView {
    setUp: true;
    enabled: boolean;
    companiesHouseConfigured: boolean;
    streamConfigured: boolean;
    counts: { lead: number; customer: number; manual: number; watching: number };
    items: WatchListItem[];
    signals: WatchSignalItem[];
    lastRunAt: string | null;
    maxManual: number;
}

export async function isWatchEnabled(db: Db, assistantId: number): Promise<boolean> {
    const [row] = await db.execute(sql`SELECT enabled FROM lead_watch_settings WHERE ai_assistant_id = ${assistantId}`) as Array<{ enabled: boolean }>;
    return row ? row.enabled !== false : true;
}

export async function listWatch(db: Db, orgId: number, assistantId: number): Promise<WatchListView> {
    const items = await db.execute(sql`
        SELECT w.id, w.watch_kind AS kind, w.company_name AS "companyName", w.ch_number AS "chNumber",
               w.ch_status AS status, w.paused_reason AS "pausedReason", w.assistant_record_id AS "recordId",
               to_char(w.last_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastCheckedAt",
               l.text AS "latestText", l.direction AS "latestDirection", l.occurred_on::text AS "latestOn", l.url AS "latestUrl"
          FROM lead_watch w
          LEFT JOIN LATERAL (
              SELECT text, direction, occurred_on, url FROM lead_watch_signals s
               WHERE s.watch_id = w.id ORDER BY s.occurred_on DESC, s.id DESC LIMIT 1
          ) l ON true
         WHERE w.organisation_id = ${orgId} AND w.ai_assistant_id = ${assistantId}
           AND (w.paused_reason IS NULL OR w.paused_reason IN ('removed_by_user', 'watching_off'))
         ORDER BY CASE w.watch_kind WHEN 'customer' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
                  l.occurred_on DESC NULLS LAST, w.company_name NULLS LAST
         LIMIT 1000`) as Array<Record<string, any>>;
    const signals = await db.execute(sql`
        SELECT s.id, s.watch_id AS "watchId", w.company_name AS "companyName", s.kind, s.text, s.direction,
               s.occurred_on::text AS "occurredOn", s.url, w.assistant_record_id AS "recordId",
               to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "seenAt"
          FROM lead_watch_signals s JOIN lead_watch w ON w.id = s.watch_id
         WHERE s.organisation_id = ${orgId} AND s.ai_assistant_id = ${assistantId}
           AND s.created_at > now() - make_interval(days => ${SIGNAL_DAYS})
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 100`) as unknown as WatchSignalItem[];
    const [run] = await db.execute(sql`
        SELECT to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM trigger_sources WHERE source = ${WATCH_SOURCE}`) as Array<{ at: string | null }>;

    const list: WatchListItem[] = items.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        companyName: r.companyName,
        chNumber: r.chNumber,
        url: companyUrl(r.chNumber),
        status: r.status,
        closing: isClosingStatus(r.status),
        watching: !r.pausedReason,
        pausedReason: r.pausedReason,
        lastCheckedAt: r.lastCheckedAt,
        recordId: r.recordId == null ? null : Number(r.recordId),
        latest: r.latestText ? { text: r.latestText, direction: r.latestDirection, occurredOn: r.latestOn, url: r.latestUrl } : null,
    }));
    const counts = { lead: 0, customer: 0, manual: 0, watching: 0 };
    for (const i of list) { counts[i.kind]++; if (i.watching) counts.watching++; }
    return {
        setUp: true,
        enabled: await isWatchEnabled(db, assistantId),
        companiesHouseConfigured: isCompaniesHouseConfigured(),
        streamConfigured: isStreamConfigured(),
        counts,
        items: list,
        signals: signals.map((s) => ({ ...s, id: Number(s.id), watchId: Number(s.watchId), recordId: s.recordId == null ? null : Number(s.recordId) })),
        lastRunAt: run?.at ?? null,
        maxManual: MAX_MANUAL_PER_ASSISTANT,
    };
}

export type WatchActionResult = { ok: true; message: string; id?: number } | { ok: false; status: number; error: string };

export async function setWatchEnabled(db: Db, orgId: number, assistantId: number, enabled: boolean, userId: number | null): Promise<WatchActionResult> {
    await db.execute(sql`
        INSERT INTO lead_watch_settings (ai_assistant_id, organisation_id, enabled, updated_by_user_id, updated_at)
        VALUES (${assistantId}, ${orgId}, ${enabled}, ${userId}, now())
        ON CONFLICT (ai_assistant_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`);
    if (!enabled) {
        await db.execute(sql`UPDATE lead_watch SET paused_reason = 'watching_off', updated_at = now()
                              WHERE organisation_id = ${orgId} AND ai_assistant_id = ${assistantId} AND paused_reason IS NULL`);
    } else {
        // Manual rows come back now; lead/customer rows come back at the next daily sync.
        await db.execute(sql`UPDATE lead_watch SET paused_reason = NULL, updated_at = now()
                              WHERE organisation_id = ${orgId} AND ai_assistant_id = ${assistantId} AND paused_reason = 'watching_off'`);
    }
    return { ok: true, message: enabled ? 'Watch list switched on. Your leads and customers are added at the next daily check.' : 'Watch list switched off. Nothing is checked until you switch it on again.' };
}

/** Adds a company by its Companies House number. Already watched → says so and starts watching again. */
export async function addManualWatch(db: Db, orgId: number, assistantId: number, rawNumber: unknown, userId: number | null): Promise<WatchActionResult> {
    const number = normaliseCompanyNumber(rawNumber);
    if (!number) return { ok: false, status: 400, error: 'That is not a Companies House company number (8 characters, like 01234567 or SC123456).' };
    if (!isCompaniesHouseConfigured()) return { ok: false, status: 503, error: 'Companies House is not connected on this site yet.' };
    const [existing] = await db.execute(sql`
        SELECT id, watch_kind, paused_reason, company_name FROM lead_watch
         WHERE organisation_id = ${orgId} AND ai_assistant_id = ${assistantId} AND ch_number = ${number}`) as Array<{ id: number; watch_kind: string; paused_reason: string | null; company_name: string | null }>;
    if (existing) {
        if (existing.paused_reason === 'removed_by_user' || existing.paused_reason === 'lead_excluded') {
            await db.execute(sql`UPDATE lead_watch SET paused_reason = NULL, watch_kind = CASE WHEN paused_reason = 'lead_excluded' THEN 'manual' ELSE watch_kind END, updated_at = now() WHERE id = ${existing.id}`);
            return { ok: true, id: Number(existing.id), message: `Watching ${existing.company_name ?? number} again.` };
        }
        return { ok: true, id: Number(existing.id), message: `${existing.company_name ?? number} is already on your Watch list.` };
    }
    const [{ n }] = await db.execute(sql`SELECT count(*)::int AS n FROM lead_watch WHERE ai_assistant_id = ${assistantId} AND watch_kind = 'manual'`) as Array<{ n: number }>;
    if (n >= MAX_MANUAL_PER_ASSISTANT) return { ok: false, status: 409, error: `You can add up to ${MAX_MANUAL_PER_ASSISTANT} companies by hand. Remove one first.` };
    const prof = await getCompanyProfile(number);
    if (!prof.ok) return { ok: false, status: 502, error: 'Companies House did not answer. Try again in a minute.' };
    if (!prof.profile) return { ok: false, status: 404, error: `Companies House has no company ${number}.` };
    const [row] = await db.execute(sql`
        INSERT INTO lead_watch (organisation_id, ai_assistant_id, watch_kind, company_name, ch_number, added_by_user_id)
        VALUES (${orgId}, ${assistantId}, 'manual', ${prof.profile.name}, ${number}, ${userId})
        ON CONFLICT (ai_assistant_id, ch_number) DO UPDATE SET paused_reason = NULL, updated_at = now()
        RETURNING id`) as Array<{ id: number }>;
    return { ok: true, id: Number(row.id), message: `Added ${prof.profile.name} (${number}). The first check records where it stands; news is reported from then on.` };
}

/** Stops watching. A company added by hand is removed; a lead or customer is paused (the sync keeps it paused). */
export async function removeWatch(db: Db, orgId: number, assistantId: number, id: number): Promise<WatchActionResult> {
    const [row] = await db.execute(sql`
        SELECT id, watch_kind, company_name, ch_number FROM lead_watch
         WHERE id = ${id} AND organisation_id = ${orgId} AND ai_assistant_id = ${assistantId}`) as Array<{ id: number; watch_kind: string; company_name: string | null; ch_number: string }>;
    if (!row) return { ok: false, status: 404, error: 'That company is not on this Watch list.' };
    const name = row.company_name ?? row.ch_number;
    if (row.watch_kind === 'manual') {
        await db.execute(sql`DELETE FROM lead_watch WHERE id = ${row.id}`);
        return { ok: true, message: `Removed ${name} from your Watch list.` };
    }
    await db.execute(sql`UPDATE lead_watch SET paused_reason = 'removed_by_user', updated_at = now() WHERE id = ${row.id}`);
    return { ok: true, message: `Stopped watching ${name}. It stays a ${row.watch_kind}; press "Watch again" to start again.` };
}

export async function resumeWatch(db: Db, orgId: number, assistantId: number, id: number): Promise<WatchActionResult> {
    const rows = await db.execute(sql`
        UPDATE lead_watch SET paused_reason = NULL, updated_at = now()
         WHERE id = ${id} AND organisation_id = ${orgId} AND ai_assistant_id = ${assistantId} AND paused_reason = 'removed_by_user'
        RETURNING company_name, ch_number`) as Array<{ company_name: string | null; ch_number: string }>;
    if (!rows.length) return { ok: false, status: 404, error: 'Nothing to start again.' };
    return { ok: true, message: `Watching ${rows[0].company_name ?? rows[0].ch_number} again.` };
}

export async function searchForWatch(query: string): Promise<{ ok: true; items: Array<{ number: string; name: string; status: string; postcode: string | null }> } | { ok: false; status: number; error: string }> {
    const r = await searchCompaniesForPicker(query);
    if (!r.ok) return { ok: false, status: r.reason === 'not_configured' ? 503 : 502, error: r.reason === 'not_configured' ? 'Companies House is not connected on this site yet.' : 'Companies House did not answer. Try again in a minute.' };
    return { ok: true, items: r.items.map(({ number, name, status, postcode }) => ({ number, name, status, postcode })) };
}

/**
 * The chat's view (Lead Generator prompt): the switch, the counts and the last 30 days of news, in a
 * few lines. Null when the tables are missing. Never throws.
 */
export async function buildWatchChatBlock(db: Db, orgId: number, assistantId: number): Promise<string | null> {
    try {
        const v = await listWatch(db, orgId, assistantId);
        const recent = v.signals.filter((s) => Date.now() - Date.parse(`${s.seenAt}`) < 30 * 86_400_000).slice(0, 15);
        const lines = [
            `WATCH LIST (Companies House news on companies this assistant watches; the Watch list tab):`,
            `- Switch: ${v.enabled ? 'ON' : 'OFF'}. Watching ${v.counts.watching} companies (${v.counts.customer} customers, ${v.counts.lead} leads, ${v.counts.manual} added by hand).`,
            recent.length
                ? `- News in the last 30 days:\n${recent.map((s) => `  • ${s.companyName ?? 'A company'}: ${s.text} [${s.direction}] (watch id ${s.watchId})`).join('\n')}`
                : `- No news in the last 30 days.`,
            ...v.items.filter((i) => i.kind === 'manual').slice(0, 30).map((i) => `- Added by hand: ${i.companyName ?? i.chNumber} (${i.chNumber}, watch id ${i.id}${i.watching ? '' : ', not watching'})`),
        ];
        return lines.join('\n');
    } catch {
        return null;
    }
}
