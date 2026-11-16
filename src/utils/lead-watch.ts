// src/utils/lead-watch.ts
// Buying triggers Phase 2 (docs/buying-triggers-plan.md §3, §5; owner decisions 2026-11-16): the Lead
// Generator's Watch list. Companies a workspace watches on Companies House, and what changed.
//
// ── What is watched ──────────────────────────────────────────────────────────────────────────────
// Per Lead Generator (role 'lead_qualifier'), while its "Watch list" switch is on (lead_watch_settings;
// no row = ON, why-now decision 1):
//   - 'lead'     saved leads with a Companies House match (data.companiesHouse.number), not deleted, not
//                do-not-contact, no outcome yet; most recent first, up to LEAD_WATCH_MAX_PER_ASSISTANT;
//   - 'customer' leads marked won (owner decision 2: watch customers too), always included;
//   - 'manual'   companies added by hand on the Watch list tab or in chat.
// syncWatchList keeps lead/customer rows in step with the leads every day; it never touches manual rows
// except to pause them when the switch is off.
//
// ── How it is checked ────────────────────────────────────────────────────────────────────────────
// Two readers, one meaning (src/lib/triggers/ch-watch.ts):
//   1. The daily check (checkDueWatches): one filing-history call per company, plus the company profile
//      every 4th check for its status. Every 7 days; 3 after a positive signal; 30 when the stream is
//      healthy (then it is only a catch-up after downtime). Paced under Companies House's 600 calls / 5 min.
//   2. The Companies House stream (runChStream), when COMPANIES_HOUSE_STREAM_KEY is set: the national
//      filings and companies streams, matched against the watched numbers. Resumes from a saved timepoint.
// The first check of a company only records a baseline (why-now 2.3): watching a company never reports
// what it filed before it was watched. The stream skips a company until its first check has run.
// lead_watch_signals is unique on (watch, filing), so the two readers can never record a filing twice.
//
// ── What a signal does ───────────────────────────────────────────────────────────────────────────
// Saved in lead_watch_signals (the Watch list tab and chat read it), added to the lead's research
// findings (data.intel.signals, source 'watch') when the lead has been researched, and written to the
// revenue ledger as `signal_captured` (the lead's activity feed shows "Picked up a buying signal").
// A positive signal restarts the lead's 30-day deletion countdown (why-now decision 3).
// A company closing (liquidation, administration, dissolved…) stops the lead's follow-ups
// (halt reason company_closed) and is flagged; do-not-contact is NOT set (that stays the audited path).
// Once a day the workspace gets ONE note per assistant (rollUpSignals). Nothing is sent to a prospect
// and nothing is moved to Outreach.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    getCompanyProfile, getFilingHistory, isCompaniesHouseConfigured, parseFiling,
} from '../lib/companies-house';
import {
    companyUrl, filingToSignal, newFilingsSince, normaliseCompanyNumber, parseStreamEvent, statusToSignal,
    type StreamResource, type WatchSignal,
} from '../lib/triggers/ch-watch';
import { isRetentionDeleted } from '../config/lead-retention';
import { resolveBaseUrl } from './base-url';

type Db = ReturnType<typeof getDb>;

export const WATCH_SOURCE = 'lead_watch';
export const STREAM_SOURCES: Record<StreamResource, string> = { filings: 'ch_stream_filings', companies: 'ch_stream_companies' };
const STREAM_BASE = 'https://stream.companieshouse.gov.uk';

export const CHECK_EVERY_DAYS = 7;
export const RECHECK_AFTER_POSITIVE_DAYS = 3;
export const CATCH_UP_EVERY_DAYS = 30;
/** Companies House allows 600 calls per 5 minutes (2/s). 550 ms keeps one worker under it with room to spare. */
export const CH_GAP_MS = 550;
const CLAIM_BATCH = 20;

export function maxPerAssistant(): number {
    const n = Number(process.env.LEAD_WATCH_MAX_PER_ASSISTANT);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 300;
}

/** Operator kill switch: LEAD_WATCH_ENABLED=off stops syncing, checking and the stream. */
export function isLeadWatchEnabled(): boolean {
    return String(process.env.LEAD_WATCH_ENABLED ?? '').toLowerCase() !== 'off';
}

export function isStreamConfigured(): boolean {
    return !!String(process.env.COMPANIES_HOUSE_STREAM_KEY ?? '').trim();
}

/** The per-assistant switch (lead_watch_settings.enabled). No row = ON (why-now decision 1). */
export function watchingOn(enabled: boolean | null | undefined): boolean {
    return enabled !== false;
}

const columnCache = new Map<string, boolean>();
/**
 * Does this column exist yet? For columns a later SQL file adds (db/z-site-markers.sql): the code ships
 * before the owner runs it, and must keep working without it. Cached per instance once found.
 */
export async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
    const key = `${table}.${column}`;
    if (columnCache.get(key)) return true;
    const rows = await db.execute(sql`
        SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column} LIMIT 1`) as unknown[];
    const found = rows.length > 0;
    if (found) columnCache.set(key, true);
    return found;
}

export function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const ukDay = (d = new Date()) => d.toISOString().slice(0, 10);

// ── Which leads are watched (pure, exported for tests) ──────────────────────────────────────────

export interface LeadCandidate {
    recordId: number;
    organisationId: number;
    assistantId: number;
    data: unknown;
    updatedAt: string;
}

export interface WatchPlanRow {
    recordId: number;
    organisationId: number;
    assistantId: number;
    chNumber: string;
    companyName: string | null;
    kind: 'lead' | 'customer';
}

/**
 * Lead records → the rows that should be watched, per assistant. Customers (won) always; open leads
 * newest first up to the cap; lost / disqualified / do-not-contact / deleted / no number never.
 */
export function planWatchRows(candidates: LeadCandidate[], cap: number): WatchPlanRow[] {
    const byAssistant = new Map<number, { customers: WatchPlanRow[]; leads: Array<WatchPlanRow & { at: string }> }>();
    for (const c of candidates) {
        const d = (c.data && typeof c.data === 'object' && !Array.isArray(c.data)) ? c.data as Record<string, unknown> : {};
        const ch = (d.companiesHouse && typeof d.companiesHouse === 'object') ? d.companiesHouse as Record<string, unknown> : null;
        const chNumber = normaliseCompanyNumber(ch?.number);
        if (!chNumber) continue;
        if (d.doNotContact === true || d.doNotContact === 'true') continue;
        if (isRetentionDeleted(d)) continue;
        const outcome = (d.dealOutcome && typeof d.dealOutcome === 'object') ? String((d.dealOutcome as Record<string, unknown>).outcome ?? '') : '';
        if (outcome && outcome !== 'won') continue;
        const row: WatchPlanRow = {
            recordId: c.recordId, organisationId: c.organisationId, assistantId: c.assistantId, chNumber,
            companyName: typeof ch?.name === 'string' && ch.name ? ch.name : (typeof d.companyName === 'string' ? d.companyName : null),
            kind: outcome === 'won' ? 'customer' : 'lead',
        };
        const slot = byAssistant.get(c.assistantId) ?? { customers: [], leads: [] };
        if (row.kind === 'customer') slot.customers.push(row);
        else slot.leads.push({ ...row, at: c.updatedAt });
        byAssistant.set(c.assistantId, slot);
    }
    const out: WatchPlanRow[] = [];
    for (const { customers, leads } of byAssistant.values()) {
        const seen = new Set<string>();
        for (const r of customers) if (!seen.has(r.chNumber)) { seen.add(r.chNumber); out.push(r); }
        const room = Math.max(0, cap - seen.size);
        leads.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        let added = 0;
        for (const { at: _at, ...r } of leads) {
            if (added >= room) break;
            if (seen.has(r.chNumber)) continue;
            seen.add(r.chNumber);
            out.push(r);
            added++;
        }
    }
    return out;
}

/** When to look again, given what this check found. */
export function nextCheckDays(foundPositive: boolean, streamHealthy: boolean): number {
    if (foundPositive) return RECHECK_AFTER_POSITIVE_DAYS;
    return streamHealthy ? CATCH_UP_EVERY_DAYS : CHECK_EVERY_DAYS;
}

// ── Sync ─────────────────────────────────────────────────────────────────────────────────────────

export interface SyncResult { assistants: number; watched: number; paused: number }

export async function syncWatchList(db: Db): Promise<SyncResult> {
    const assistants = await db.execute(sql`
        SELECT a.id, a.organisation_id, s.enabled
          FROM ai_assistants a
          JOIN master_assistants m ON m.id = a.master_assistant_id
          LEFT JOIN lead_watch_settings s ON s.ai_assistant_id = a.id
         WHERE m.role_key = 'lead_qualifier' AND a.is_active = true AND a.archived_at IS NULL
    `) as Array<{ id: number; organisation_id: number; enabled: boolean | null }>;
    const onIds = assistants.filter((a) => watchingOn(a.enabled)).map((a) => a.id);
    const offIds = assistants.filter((a) => !watchingOn(a.enabled)).map((a) => a.id);

    let paused = 0;
    if (offIds.length) {
        const r = await db.execute(sql`
            UPDATE lead_watch SET paused_reason = 'watching_off', updated_at = now()
             WHERE ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(offIds)}::jsonb)::int)
               AND paused_reason IS DISTINCT FROM 'watching_off'
            RETURNING id`) as unknown[];
        paused += r.length;
    }
    if (!onIds.length) return { assistants: 0, watched: 0, paused };

    const candidates = await db.execute(sql`
        SELECT r.id AS "recordId", r.organisation_id AS "organisationId", r.ai_assistant_id AS "assistantId",
               r.data, to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "updatedAt"
          FROM assistant_records r
         WHERE r.record_type = 'lead'
           AND r.ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(onIds)}::jsonb)::int)
           AND r.data -> 'companiesHouse' ->> 'number' IS NOT NULL
    `) as unknown as LeadCandidate[];
    const plan = planWatchRows(candidates, maxPerAssistant());

    if (plan.length) {
        await db.execute(sql`
            INSERT INTO lead_watch (organisation_id, ai_assistant_id, assistant_record_id, watch_kind, company_name, ch_number)
            SELECT x."organisationId", x."assistantId", x."recordId", x.kind, x."companyName", x."chNumber"
              FROM jsonb_to_recordset(${JSON.stringify(plan)}::jsonb)
                AS x("organisationId" int, "assistantId" int, "recordId" int, kind text, "companyName" text, "chNumber" text)
            ON CONFLICT (ai_assistant_id, ch_number) DO UPDATE SET
                -- A company the user added by hand stays theirs; a lead becoming a customer is promoted.
                watch_kind = CASE WHEN lead_watch.watch_kind = 'manual' THEN 'manual' ELSE EXCLUDED.watch_kind END,
                assistant_record_id = COALESCE(lead_watch.assistant_record_id, EXCLUDED.assistant_record_id),
                company_name = COALESCE(lead_watch.company_name, EXCLUDED.company_name),
                -- "Stop watching" on the tab wins over the daily sync.
                paused_reason = CASE WHEN lead_watch.paused_reason = 'removed_by_user' THEN 'removed_by_user' ELSE NULL END,
                updated_at = now()
        `);
    }

    // Lead/customer rows on a watching assistant that are no longer in the plan: the lead was rejected,
    // lost, marked do-not-contact or fell past the cap. Paused, not deleted, so re-adding keeps the
    // baseline (and never re-reports old filings).
    const keep = plan.map((p) => `${p.assistantId}:${p.chNumber}`);
    const r = await db.execute(sql`
        UPDATE lead_watch SET paused_reason = 'lead_excluded', updated_at = now()
         WHERE ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(onIds)}::jsonb)::int)
           AND watch_kind IN ('lead', 'customer')
           AND paused_reason IS NULL
           AND (ai_assistant_id::text || ':' || ch_number) NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb))
        RETURNING id`) as unknown[];
    paused += r.length;
    // Manual rows come back when the switch is turned on again.
    await db.execute(sql`
        UPDATE lead_watch SET paused_reason = NULL, updated_at = now()
         WHERE ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(onIds)}::jsonb)::int)
           AND watch_kind = 'manual' AND paused_reason = 'watching_off'`);

    return { assistants: onIds.length, watched: plan.length, paused };
}

// ── Recording a signal ───────────────────────────────────────────────────────────────────────────

export interface WatchRow {
    id: number;
    organisation_id: number;
    ai_assistant_id: number;
    assistant_record_id: number | null;
    company_name: string | null;
    ch_number: string;
    ch_last_filing_id: string | null;
    ch_status: string | null;
    checks_done: number;
}

export type SignalHooks = {
    /** Ledger + follow-up halt. Injected so tests and the stream share one path. */
    afterInsert?: (db: Db, row: WatchRow, sig: WatchSignal) => Promise<void>;
};

/** Saves one signal. Returns false when it was already recorded (the unique key). */
export async function recordSignal(db: Db, row: WatchRow, sig: WatchSignal, source: 'ch_check' | 'ch_stream' | 'crtsh', hooks: SignalHooks = defaultHooks): Promise<boolean> {
    const inserted = await db.execute(sql`
        INSERT INTO lead_watch_signals (watch_id, organisation_id, ai_assistant_id, kind, text, direction, occurred_on, ref, url, source)
        VALUES (${row.id}, ${row.organisation_id}, ${row.ai_assistant_id}, ${sig.kind}, ${sig.text}, ${sig.direction},
                ${sig.occurredOn}::date, ${sig.ref}, ${sig.url}, ${source})
        ON CONFLICT (watch_id, ref) DO NOTHING
        RETURNING id`) as unknown[];
    if (!inserted.length) return false;

    if (row.assistant_record_id) {
        await applySignalToLead(db, row.assistant_record_id, { kind: sig.kind, text: sig.text, url: sig.url, direction: sig.direction, occurredOn: sig.occurredOn });
    }
    if (hooks.afterInsert) {
        try { await hooks.afterInsert(db, row, sig); } catch (err) { console.warn('[lead-watch] after-signal step failed', err); }
    }
    return true;
}

/**
 * Put one watch signal onto its lead. Shared by the Companies House checks here and the website / US
 * checks (src/utils/lead-site-watch.ts), so every watch signal does the same three things:
 *
 * 1. Into the lead's research findings (data.intel.signals, source 'watch'), ONLY when the lead has been
 *    researched. Creating data.intel here would make lead-enrichment-sweep.ts think the lead was
 *    researched (it keys on intel) and the lead panel would show a findings box with nothing else in it.
 * 2. A POSITIVE signal newer than the lead's current Why now becomes its Why now (data.intel.whyNow —
 *    the All leads "Why now" column, src/config/lead-why-now.ts), and its timing score is lifted to at
 *    least WATCH_WHY_NOW_TIMING_FLOOR. The date is the source's own, never later than tomorrow.
 * 3. A POSITIVE signal restarts the lead's 30-day deletion countdown (why-now decision 3): the retention
 *    clock is assistant_records.updated_at (src/config/lead-retention.ts). Neutral and negative news
 *    leave the clock and the Why now alone.
 */
export const WATCH_WHY_NOW_TIMING_FLOOR = 60;
export async function applySignalToLead(
    db: Db,
    assistantRecordId: number,
    sig: { kind: string; text: string; url: string; direction: string; occurredOn: string },
): Promise<void> {
    const entry = { summary: sig.text, url: sig.url, direction: sig.direction, date: sig.occurredOn, source: 'watch', kind: sig.kind };
    const positive = sig.direction === 'positive';
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const becomesWhyNow = positive && /^\d{4}-\d{2}-\d{2}$/.test(sig.occurredOn) && sig.occurredOn <= tomorrow && !!sig.url;
    const whyNow = { summary: sig.text, url: sig.url, date: sig.occurredOn };
    await db.execute(sql`
        UPDATE assistant_records
           SET data = CASE
                   WHEN jsonb_typeof(data -> 'intel') <> 'object' OR data -> 'intel' IS NULL THEN data
                   WHEN ${becomesWhyNow} AND COALESCE(data #>> '{intel,whyNow,date}', '') < ${sig.occurredOn}
                   THEN jsonb_set(jsonb_set(jsonb_set(data,
                            '{intel,signals}', COALESCE(data -> 'intel' -> 'signals', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb, true),
                            '{intel,whyNow}', ${JSON.stringify(whyNow)}::jsonb, true),
                            '{intel,timing}', to_jsonb(GREATEST(
                                CASE WHEN jsonb_typeof(data #> '{intel,timing}') = 'number' THEN (data #>> '{intel,timing}')::numeric ELSE 0 END,
                                ${WATCH_WHY_NOW_TIMING_FLOOR})), true)
                   ELSE jsonb_set(data, '{intel,signals}',
                            COALESCE(data -> 'intel' -> 'signals', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb, true)
               END,
               updated_at = CASE WHEN ${positive} THEN now() ELSE updated_at END
         WHERE id = ${assistantRecordId}`);
}

let defaultHooks: SignalHooks = {};
/** Wired by src/utils/lead-watch-effects.ts (ledger + follow-up halt) at import time. */
export function setDefaultSignalHooks(h: SignalHooks): void { defaultHooks = h; }

// ── The daily per-company check ─────────────────────────────────────────────────────────────────

export interface CheckResult { checked: number; signals: number; baselined: number; errors: number; stoppedEarly: boolean }

async function streamHealthy(db: Db): Promise<boolean> {
    if (!isStreamConfigured()) return false;
    const rows = await db.execute(sql`
        SELECT 1 FROM trigger_sources WHERE source = ${STREAM_SOURCES.filings} AND last_ok_at > now() - interval '2 hours'`) as unknown[];
    return rows.length > 0;
}

/** Claims due rows fairly across assistants (one assistant cannot starve the rest). */
async function claimDue(db: Db, limit: number): Promise<WatchRow[]> {
    return await db.execute(sql`
        UPDATE lead_watch w SET next_check_at = now() + interval '2 hours'
          FROM (
              SELECT id FROM (
                  SELECT id, next_check_at,
                         row_number() OVER (PARTITION BY ai_assistant_id ORDER BY next_check_at) AS turn
                    FROM lead_watch
                   WHERE paused_reason IS NULL AND next_check_at <= now()
              ) due
              ORDER BY turn, next_check_at
              LIMIT ${limit}
          ) pick
         WHERE w.id = pick.id
        RETURNING w.id, w.organisation_id, w.ai_assistant_id, w.assistant_record_id, w.company_name, w.ch_number,
                  w.ch_last_filing_id, w.ch_status, w.checks_done`) as unknown as WatchRow[];
}

export async function checkDueWatches(db: Db, opts: { deadline: number }): Promise<CheckResult> {
    const out: CheckResult = { checked: 0, signals: 0, baselined: 0, errors: 0, stoppedEarly: false };
    if (!isCompaniesHouseConfigured()) return out;
    const healthy = await streamHealthy(db);
    const today = ukDay();
    while (Date.now() < opts.deadline) {
        const rows = await claimDue(db, CLAIM_BATCH);
        if (!rows.length) return out;
        for (const row of rows) {
            if (Date.now() >= opts.deadline) {
                // Give the rest back so the next run picks them up first.
                await db.execute(sql`UPDATE lead_watch SET next_check_at = now() WHERE id = ${row.id}`);
                out.stoppedEarly = true;
                continue;
            }
            const firstLook = row.ch_last_filing_id === null;
            const wantStatus = row.checks_done % 4 === 0;
            const hist = await getFilingHistory(row.ch_number, 10);
            await sleep(CH_GAP_MS);
            const prof = wantStatus ? await getCompanyProfile(row.ch_number) : null;
            if (wantStatus) await sleep(CH_GAP_MS);
            if (!hist.ok || (prof && !prof.ok)) {
                out.errors++;
                const reason = !hist.ok ? hist.reason : (prof && !prof.ok ? prof.reason : 'unknown');
                await db.execute(sql`
                    UPDATE lead_watch SET last_error = ${reason}, last_checked_at = now(),
                           next_check_at = now() + interval '1 day', updated_at = now()
                     WHERE id = ${row.id}`);
                continue;
            }
            let foundPositive = false;
            for (const f of newFilingsSince(hist.filings, row.ch_last_filing_id)) {
                const sig = filingToSignal(f, row.ch_number, today);
                if (sig && await recordSignal(db, row, sig, 'ch_check')) {
                    out.signals++;
                    if (sig.direction === 'positive') foundPositive = true;
                }
            }
            const status = prof && prof.ok ? (prof.profile?.status ?? null) : null;
            if (prof && prof.ok) {
                const sig = statusToSignal(row.ch_status, status, row.ch_number, today);
                if (sig && await recordSignal(db, row, sig, 'ch_check')) out.signals++;
            }
            if (firstLook) out.baselined++;
            const newest = hist.filings[0]?.transactionId ?? row.ch_last_filing_id ?? '';
            const days = nextCheckDays(foundPositive, healthy);
            await db.execute(sql`
                UPDATE lead_watch
                   SET ch_last_filing_id = ${newest},
                       ch_status = COALESCE(${status}, ch_status),
                       company_name = COALESCE(company_name, ${prof && prof.ok ? prof.profile?.name ?? null : null}),
                       checks_done = checks_done + 1,
                       last_checked_at = now(), last_error = NULL,
                       next_check_at = now() + make_interval(days => ${days}),
                       updated_at = now()
                 WHERE id = ${row.id}`);
            out.checked++;
        }
    }
    out.stoppedEarly = true;
    return out;
}

// ── The daily roll-up: one note per assistant ───────────────────────────────────────────────────

export interface RollUpGroup { organisationId: number; assistantId: number; positive: number; negative: number; companies: string[]; fromSites?: boolean; fromRegister?: boolean }

/** Unnotified signals → one group per assistant. Neutral-only assistants get no note. Pure. */
export function groupForRollUp(rows: Array<{ organisation_id: number; ai_assistant_id: number; direction: string; company_name: string | null; site?: boolean }>): RollUpGroup[] {
    const map = new Map<number, RollUpGroup>();
    for (const r of rows) {
        const g = map.get(r.ai_assistant_id) ?? { organisationId: r.organisation_id, assistantId: r.ai_assistant_id, positive: 0, negative: 0, companies: [] };
        if (r.direction === 'positive') g.positive++;
        if (r.direction === 'negative') g.negative++;
        if (r.direction === 'positive' || r.direction === 'negative') { if (r.site) g.fromSites = true; else g.fromRegister = true; }
        if ((r.direction === 'positive' || r.direction === 'negative') && r.company_name && !g.companies.includes(r.company_name)) g.companies.push(r.company_name);
        map.set(r.ai_assistant_id, g);
    }
    return [...map.values()].filter((g) => g.positive + g.negative > 0);
}

/** The note's wording. Pure. */
export function rollUpText(g: RollUpGroup): { title: string; body: string } {
    const n = g.companies.length;
    const names = g.companies.slice(0, 3).join(', ') + (n > 3 ? ` and ${n - 3} more` : '');
    const title = n === 1 ? `News on a company you watch: ${g.companies[0]}` : `News on ${n} companies you watch`;
    const parts: string[] = [];
    if (g.positive) parts.push(`${g.positive} new reason${g.positive === 1 ? '' : 's'} to get in touch`);
    if (g.negative) parts.push(`${g.negative} warning${g.negative === 1 ? '' : 's'} (a company closing)`);
    // Where the news came from, in the user's words. Register-only notes read exactly as before.
    const from = g.fromSites && g.fromRegister ? 'from Companies House and their websites'
        : g.fromSites ? 'from their websites and filings'
        : 'from Companies House';
    return { title, body: `${parts.join(' and ')} ${from}: ${names}. See the Watch list tab.` };
}

export async function rollUpSignals(db: Db, notify: (g: RollUpGroup) => Promise<void>): Promise<number> {
    const rows = await db.execute(sql`
        SELECT s.id, s.organisation_id, s.ai_assistant_id, s.direction, w.company_name
          FROM lead_watch_signals s JOIN lead_watch w ON w.id = s.watch_id
         WHERE s.notified_at IS NULL`) as Array<{ id: number; organisation_id: number; ai_assistant_id: number; direction: string; company_name: string | null; site?: boolean }>;
    // The website and SEC news (Why now Phase 2, src/utils/lead-site-watch.ts) goes in the same note.
    // Missing table (db/z-lead-site-watch.sql not applied yet) = no such news.
    let siteRows: typeof rows = [];
    try {
        siteRows = (await db.execute(sql`
            SELECT s.id, s.organisation_id, s.ai_assistant_id, s.direction, r.title AS company_name
              FROM lead_site_watch_signals s JOIN assistant_records r ON r.id = s.assistant_record_id
             WHERE s.notified_at IS NULL`) as typeof rows).map((r) => ({ ...r, site: true }));
    } catch (err) {
        if (!isMissingTable(err)) throw err;
    }
    const all = [...rows, ...siteRows];
    if (!all.length) return 0;
    let sent = 0;
    for (const g of groupForRollUp(all)) {
        try { await notify(g); sent++; } catch (err) { console.warn('[lead-watch] roll-up note failed', err); }
    }
    // Marked whether or not a note went out (neutral-only news is shown on the tab, never sent).
    if (rows.length) await db.execute(sql`
        UPDATE lead_watch_signals SET notified_at = now()
         WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(rows.map((r) => r.id))}::jsonb)::bigint)`);
    if (siteRows.length) await db.execute(sql`
        UPDATE lead_site_watch_signals SET notified_at = now()
         WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(siteRows.map((r) => r.id))}::jsonb)::bigint)`);
    return sent;
}

// ── The Companies House stream ──────────────────────────────────────────────────────────────────

export interface StreamResult { resource: StreamResource; events: number; matched: number; signals: number; timepoint: number | null; error?: string }

async function loadWatchedByNumber(db: Db): Promise<Map<string, WatchRow[]>> {
    // Only companies whose first check has run: the baseline stays silent.
    const rows = await db.execute(sql`
        SELECT id, organisation_id, ai_assistant_id, assistant_record_id, company_name, ch_number,
               ch_last_filing_id, ch_status, checks_done
          FROM lead_watch WHERE paused_reason IS NULL AND ch_last_filing_id IS NOT NULL`) as unknown as WatchRow[];
    const map = new Map<string, WatchRow[]>();
    for (const r of rows) map.set(r.ch_number, [...(map.get(r.ch_number) ?? []), r]);
    return map;
}

async function saveTimepoint(db: Db, resource: StreamResource, timepoint: number, extra: Record<string, unknown>, ok: boolean): Promise<void> {
    const source = STREAM_SOURCES[resource];
    await db.execute(sql`
        INSERT INTO trigger_sources (source, last_run_at, last_ok_at, last_result)
        VALUES (${source}, now(), ${ok ? sql`now()` : sql`NULL`}, ${JSON.stringify({ timepoint, ...extra })}::jsonb)
        ON CONFLICT (source) DO UPDATE SET
            last_run_at = now(),
            last_ok_at = ${ok ? sql`now()` : sql`trigger_sources.last_ok_at`},
            last_result = trigger_sources.last_result || ${JSON.stringify({ timepoint, ...extra })}::jsonb,
            updated_at = now()`);
}

/**
 * Reads one stream from the saved timepoint until `deadline`, then saves where it got to. A timepoint
 * too old for the stream (HTTP 416) restarts from now; the daily check covers the gap.
 */
export async function runChStream(db: Db, resource: StreamResource, opts: { deadline: number }): Promise<StreamResult> {
    const out: StreamResult = { resource, events: 0, matched: 0, signals: 0, timepoint: null };
    if (!isStreamConfigured()) return { ...out, error: 'not_configured' };
    const [state] = await db.execute(sql`SELECT (last_result ->> 'timepoint')::bigint AS tp FROM trigger_sources WHERE source = ${STREAM_SOURCES[resource]}`) as Array<{ tp: string | number | null }>;
    let timepoint = state?.tp != null ? Number(state.tp) : null;
    const watched = await loadWatchedByNumber(db);
    const path = resource === 'filings' ? '/filings' : '/companies';
    const key = String(process.env.COMPANIES_HOUSE_STREAM_KEY).trim();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, opts.deadline - Date.now()));
    const today = ukDay();
    try {
        let res = await fetch(`${STREAM_BASE}${path}${timepoint != null ? `?timepoint=${timepoint + 1}` : ''}`, {
            headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` }, signal: ctrl.signal,
        });
        if (res.status === 416) {
            await res.arrayBuffer().catch(() => null);
            timepoint = null;
            res = await fetch(`${STREAM_BASE}${path}`, { headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` }, signal: ctrl.signal });
        }
        if (!res.ok || !res.body) {
            await saveTimepoint(db, resource, timepoint ?? 0, { lastError: `HTTP ${res.status}` }, false);
            return { ...out, error: `HTTP ${res.status}` };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let sinceSave = 0;
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const ev = parseStreamEvent(line, resource, parseFiling);
                if (!ev) continue;
                out.events++;
                timepoint = ev.timepoint;
                const rows = watched.get(ev.companyNumber);
                if (rows) {
                    out.matched++;
                    for (const row of rows) {
                        const sig = ev.filing ? filingToSignal(ev.filing, row.ch_number, today) : statusToSignal(row.ch_status, ev.status, row.ch_number, today);
                        if (sig && await recordSignal(db, row, sig, 'ch_stream')) out.signals++;
                        if (ev.status) {
                            row.ch_status = ev.status;
                            await db.execute(sql`UPDATE lead_watch SET ch_status = ${ev.status}, updated_at = now() WHERE id = ${row.id}`);
                        }
                    }
                }
                if (++sinceSave >= 1000) { await saveTimepoint(db, resource, timepoint, {}, true); sinceSave = 0; }
            }
        }
    } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
            out.error = err instanceof Error ? err.message : String(err);
        }
    } finally {
        clearTimeout(timer);
    }
    out.timepoint = timepoint;
    await saveTimepoint(db, resource, timepoint ?? 0, { lastEvents: out.events, lastMatched: out.matched, lastSignals: out.signals, lastError: out.error ?? null }, !out.error);
    return out;
}

// ── Starting the background functions ───────────────────────────────────────────────────────────

export async function startBackground(fn: 'run-lead-watch-background' | 'run-ch-stream-background', headers?: Record<string, string | undefined>): Promise<{ started: boolean; error?: string }> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const base = resolveBaseUrl(headers);
    if (!secret || !base) return { started: false, error: !secret ? 'CRON_TRIGGER_SECRET is not set on this site.' : 'Could not work out this site\'s address.' };
    try {
        const res = await fetch(`${base}/.netlify/functions/${fn}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: '{}',
            signal: AbortSignal.timeout(8_000),
        });
        return res.status === 202 || res.ok ? { started: true } : { started: false, error: `It refused to start (HTTP ${res.status}).` };
    } catch (err) {
        return { started: false, error: `It could not be reached: ${err instanceof Error ? err.message : String(err)}` };
    }
}

export { companyUrl };
