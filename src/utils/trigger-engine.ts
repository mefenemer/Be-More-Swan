// src/utils/trigger-engine.ts
// Buying triggers Phase 1 (docs/buying-triggers-plan.md §3, §5): the engine's first feed, the FSA list
// of new food and drink premises. ADMIN ONLY: events land in trigger_events and are counted on
// Admin ▸ Assistants ▸ Buying triggers. Nothing reaches a workspace, a lead list or a prospect.
//
// Phase 1 exists to MEASURE before anything is promised (§9.2, §9.3): daily volume by council and kind,
// how many trade as a company (PECR: only a Ltd / PLC / LLP may be emailed), and how many publish an
// address at all. Those are the numbers the owner's stop/go gate is set against.
//
// ── The rules that keep the counts honest ────────────────────────────────────────────────────────
// • FIRST LOOK IS SILENT (why-now 2.3). A council's list is a STOCK the first time we read it (councils
//   have inspection backlogs of months), so everything on it is recorded as seen, never as an event.
//   Baselining is per council: a council that fails on day 1, or joins the list later, is baselined
//   the first time it is read, never flooded into events.
// • A council not read successfully for 30 days is baselined again (its seen rows may have aged out).
// • A BULK RE-IMPORT is not news. If one council suddenly shows more than max(50, 25% of its list) new
//   entries (a council re-keying its records), they are recorded as seen and reported, not as events.
// • A council that fails today is simply skipped today.
//
// Run daily by run-trigger-poll-background.ts (scheduled via dispatch-trigger-polls.ts).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    FSA_SOURCE, isFsaSourceEnabled, fetchAuthorities, fetchAwaiting, fhrsToEvent, REQUEST_GAP_MS,
    type FhrsAuthority, type FhrsEstablishment,
} from '../lib/triggers/fsa-fhrs';
import { findCompanyByName, isCompaniesHouseConfigured } from '../lib/companies-house';
import type { TriggerEvent } from '../lib/triggers/types';
import { resolveBaseUrl } from './base-url';

type Db = ReturnType<typeof getDb>;

// One at a time: the FSA API's firewall answers bursts with 403/429 (see fsa-fhrs.ts getJson).
// 363 councils take about 3 minutes.
const CONCURRENCY = 1;
const REBASELINE_AFTER_DAYS = 30;
// Must stay ABOVE REBASELINE_AFTER_DAYS: a council's seen rows are only deleted after the council itself
// has dropped back to "needs a baseline", so a deleted row can never come back as a false event.
const SEEN_KEEP_DAYS = 45;
const EVENT_KEEP_DAYS = 90;
const BULK_MIN = 50;
const BULK_SHARE = 0.25;
// Companies House allows 600 requests per 5 minutes per key, shared with lead research. One request a
// match, ~110 a minute, leaves most of the allowance for everything else.
const CH_GAP_MS = 550;
const CH_MAX_PER_RUN = 600;

/**
 * Company types that are "corporate subscribers" under PECR (bodies corporate, incl. LLPs and Scottish
 * partnerships): B2B email allowed without consent. Everything else — and every premises with no
 * register match — is treated as an individual subscriber: no unsolicited email (plan §4).
 */
export const CORPORATE_COMPANY_TYPES: readonly string[] = [
    'ltd', 'plc', 'llp', 'private-unlimited', 'private-unlimited-nsc', 'old-public-company',
    'private-limited-guarant-nsc', 'private-limited-guarant-nsc-limited-exemption',
    'private-limited-shares-section-30-exemption', 'scottish-partnership',
    'charitable-incorporated-organisation', 'scottish-charitable-incorporated-organisation',
    'registered-society-non-jurisdictional', 'industrial-and-provident-society', 'royal-charter',
    'uk-establishment', 'oversea-company', 'further-education-or-sixth-form-college-corporation',
];
const CORPORATE_TYPES = new Set(CORPORATE_COMPANY_TYPES);

export function isCorporateCompanyType(type: string | null | undefined): boolean {
    return CORPORATE_TYPES.has(String(type || '').toLowerCase());
}

// ── Pure decisions (exported for tests/buying-triggers.test.ts) ──────────────────────────────────

export interface SourceState {
    /** Council id → ISO time it was last read successfully. Present = baselined. */
    authorities: Record<string, string>;
}

export function parseState(raw: unknown): SourceState {
    const a = (raw as { authorities?: unknown } | null)?.authorities;
    const authorities: Record<string, string> = {};
    if (a && typeof a === 'object') {
        for (const [k, v] of Object.entries(a as Record<string, unknown>)) if (typeof v === 'string') authorities[k] = v;
    }
    return { authorities };
}

/** Has this council been read before, recently enough that its seen rows are still all there? */
export function isBaselined(state: SourceState, authorityId: number, now: Date): boolean {
    const last = state.authorities[String(authorityId)];
    if (!last) return false;
    const t = Date.parse(last);
    return Number.isFinite(t) && now.getTime() - t <= REBASELINE_AFTER_DAYS * 86_400_000;
}

export type CouncilVerdict = 'baseline' | 'bulk' | 'events';

/**
 * What one council's new entries are: a first look (silent), a bulk re-import (silent, reported), or
 * real events.
 */
export function councilVerdict(baselined: boolean, newCount: number, listSize: number): CouncilVerdict {
    if (!baselined) return 'baseline';
    if (newCount > Math.max(BULK_MIN, Math.ceil(listSize * BULK_SHARE))) return 'bulk';
    return 'events';
}

export function splitNew(fetched: FhrsEstablishment[], seen: Set<string>): FhrsEstablishment[] {
    const out: FhrsEstablishment[] = [];
    const dup = new Set<string>();
    for (const e of fetched) {
        const id = String(e.FHRSID);
        if (seen.has(id) || dup.has(id)) continue;
        dup.add(id);
        out.push(e);
    }
    return out;
}

/** YYYY-MM-DD in UK time — the day "we first saw it" means to an admin reading the page. */
export function ukDay(now: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

export interface FsaPollResult {
    ok: boolean;
    skipped?: 'switched_off' | 'not_set_up';
    error?: string;
    councils?: number;
    councilsRead?: number;
    failedCouncils?: string[];
    failureReasons?: Record<string, number>;
    listed?: number;
    newEvents?: number;
    baselined?: number;
    bulkSkipped?: Array<{ area: string; count: number }>;
    companyChecks?: { checked: number; hits: number; corporate: number; misses: number; errors: number; stoppedBy?: string };
    durationMs?: number;
}

function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    }));
    return out;
}

async function markSeen(db: Db, rows: Array<{ id: string; baseline: boolean }>): Promise<void> {
    for (let i = 0; i < rows.length; i += 5000) {
        const chunk = JSON.stringify(rows.slice(i, i + 5000));
        await db.execute(sql`
            INSERT INTO trigger_seen (source, subject_id, baseline)
            SELECT ${FSA_SOURCE}, x.id, x.baseline FROM jsonb_to_recordset(${chunk}::jsonb) AS x(id text, baseline boolean)
            ON CONFLICT (source, subject_id) DO UPDATE SET last_seen_at = now()`);
    }
}

async function insertEvents(db: Db, events: TriggerEvent[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < events.length; i += 500) {
        const chunk = JSON.stringify(events.slice(i, i + 500).map((e) => ({
            kind: e.kind, source: e.source, source_event_id: e.sourceEventId, country: e.country,
            subject_type: e.subjectType, subject_id: e.subjectId, name: e.name, postcode: e.postcode,
            area: e.area, trade_codes: e.tradeCodes, occurred_on: e.occurredOn, payload: e.payload,
        })));
        const rows = await db.execute(sql`
            INSERT INTO trigger_events (kind, source, source_event_id, country, subject_type, subject_id, name, postcode, area, trade_codes, occurred_on, payload)
            SELECT x.kind, x.source, x.source_event_id, x.country, x.subject_type, x.subject_id, x.name, x.postcode, x.area,
                   ARRAY(SELECT jsonb_array_elements_text(x.trade_codes)), x.occurred_on::date, x.payload
            FROM jsonb_to_recordset(${chunk}::jsonb) AS x(kind text, source text, source_event_id text, country text,
                 subject_type text, subject_id text, name text, postcode text, area text, trade_codes jsonb,
                 occurred_on text, payload jsonb)
            ON CONFLICT (source, source_event_id) DO NOTHING
            RETURNING id`) as Array<{ id: number }>;
        inserted += rows.length;
    }
    return inserted;
}

/** Match not-yet-checked events to Companies House, oldest first, until the cap or the deadline. */
export async function checkCompanies(db: Db, deadline: number, max = CH_MAX_PER_RUN): Promise<NonNullable<FsaPollResult['companyChecks']>> {
    const stats = { checked: 0, hits: 0, corporate: 0, misses: 0, errors: 0 } as NonNullable<FsaPollResult['companyChecks']>;
    if (!isCompaniesHouseConfigured()) return { ...stats, stoppedBy: 'not_configured' };
    const rows = await db.execute(sql`
        SELECT id, name, postcode FROM trigger_events
        WHERE company_checked_at IS NULL AND source = ${FSA_SOURCE}
        ORDER BY first_seen_at, id LIMIT ${max}`) as Array<{ id: number; name: string | null; postcode: string | null }>;
    for (const r of rows) {
        if (Date.now() > deadline) { stats.stoppedBy = 'deadline'; break; }
        const out = await findCompanyByName(r.name || '', r.postcode ? [r.postcode] : []);
        if (out.status === 'error') {
            stats.errors++;
            // Rate limited or no key: stop and leave the rest for tomorrow. A one-off timeout: carry on.
            if (out.reason === 'http_429' || out.reason === 'not_configured' || out.reason === 'http_401') { stats.stoppedBy = out.reason; break; }
        } else if (out.status === 'hit') {
            stats.checked++; stats.hits++;
            if (isCorporateCompanyType(out.company.type)) stats.corporate++;
            await db.execute(sql`
                UPDATE trigger_events SET company_number = ${out.company.number}, company_type = ${out.company.type},
                       company_matched_by = ${out.company.matchedBy}, company_checked_at = now()
                WHERE id = ${r.id}`);
        } else {
            stats.checked++; stats.misses++;
            await db.execute(sql`UPDATE trigger_events SET company_checked_at = now() WHERE id = ${r.id}`);
        }
        await new Promise((res) => setTimeout(res, CH_GAP_MS));
    }
    return stats;
}

export async function runFsaPoll(db: Db, opts: { deadlineMs?: number; now?: Date; maxCompanyChecks?: number } = {}): Promise<FsaPollResult> {
    const started = Date.now();
    const deadline = started + (opts.deadlineMs ?? 13 * 60_000);
    const now = opts.now ?? new Date();
    if (!isFsaSourceEnabled()) return { ok: true, skipped: 'switched_off' };

    let stateRow: { state: unknown } | undefined;
    try {
        await db.execute(sql`INSERT INTO trigger_sources (source) VALUES (${FSA_SOURCE}) ON CONFLICT (source) DO NOTHING`);
        [stateRow] = await db.execute(sql`SELECT last_result -> 'state' AS state FROM trigger_sources WHERE source = ${FSA_SOURCE}`) as Array<{ state: unknown }>;
    } catch (err) {
        if (isMissingTable(err)) return { ok: false, skipped: 'not_set_up' };
        throw err;
    }
    const state = parseState(stateRow?.state);

    const finish = async (result: FsaPollResult) => {
        result.durationMs = Date.now() - started;
        const stored = { ...result, state };
        await db.execute(sql`
            UPDATE trigger_sources SET last_run_at = now(),
                   last_ok_at = CASE WHEN ${result.ok} THEN now() ELSE last_ok_at END,
                   baseline_done_at = CASE WHEN baseline_done_at IS NULL AND ${result.ok} AND ${(result.councils ?? 0) > 0}
                                            AND ${(result.councilsRead ?? 0) === (result.councils ?? -1)} THEN now() ELSE baseline_done_at END,
                   last_result = ${JSON.stringify(stored)}::jsonb, updated_at = now()
            WHERE source = ${FSA_SOURCE}`);
        return result;
    };

    let councils: FhrsAuthority[];
    try {
        councils = await fetchAuthorities();
    } catch (err) {
        return finish({ ok: false, error: `Could not read the FSA council list: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (councils.length === 0) return finish({ ok: false, error: 'The FSA council list came back empty.' });

    const seenRows = await db.execute(sql`SELECT subject_id FROM trigger_seen WHERE source = ${FSA_SOURCE}`) as Array<{ subject_id: string }>;
    const seen = new Set(seenRows.map((r) => r.subject_id));

    const day = ukDay(now);
    const failed: string[] = [];
    const failureReasons: Record<string, number> = {};
    const bulkSkipped: Array<{ area: string; count: number }> = [];
    let listed = 0, baselined = 0, councilsRead = 0;
    const events: TriggerEvent[] = [];
    const seenWrites: Array<{ id: string; baseline: boolean }> = [];

    await mapLimit(councils, CONCURRENCY, async (c) => {
        if (Date.now() > deadline) { failed.push(c.name); return; }
        let rows: FhrsEstablishment[];
        try {
            rows = await fetchAwaiting(c.id);
        } catch (err) {
            failed.push(c.name);
            const reason = err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : err.message) : String(err);
            failureReasons[reason.slice(0, 60)] = (failureReasons[reason.slice(0, 60)] || 0) + 1;
            return;
        }
        await new Promise((res) => setTimeout(res, REQUEST_GAP_MS));
        councilsRead++;
        listed += rows.length;
        const fresh = splitNew(rows, seen);
        const verdict = councilVerdict(isBaselined(state, c.id, now), fresh.length, rows.length);
        if (verdict === 'bulk') bulkSkipped.push({ area: c.name, count: fresh.length });
        if (verdict === 'events') events.push(...fresh.map((e) => fhrsToEvent(e, day)));
        else baselined += fresh.length;
        const freshIds = new Set(fresh.map((e) => String(e.FHRSID)));
        for (const e of rows) {
            const id = String(e.FHRSID);
            seenWrites.push({ id, baseline: freshIds.has(id) && verdict !== 'events' });
            seen.add(id); // a premises listed by two councils is counted once
        }
        state.authorities[String(c.id)] = now.toISOString();
    });

    const newEvents = await insertEvents(db, events);
    await markSeen(db, seenWrites);

    // Retention (plan §3): events nobody uses go after 90 days; premises off the list for 45 days go.
    await db.execute(sql`DELETE FROM trigger_events WHERE source = ${FSA_SOURCE} AND first_seen_at < now() - make_interval(days => ${EVENT_KEEP_DAYS})`);
    await db.execute(sql`DELETE FROM trigger_seen WHERE source = ${FSA_SOURCE} AND last_seen_at < now() - make_interval(days => ${SEEN_KEEP_DAYS})`);

    const companyChecks = await checkCompanies(db, deadline, opts.maxCompanyChecks);

    return finish({
        // A day with a few councils down is still a good day; most of the list missing is not.
        ok: failed.length <= Math.ceil(councils.length * 0.1),
        councils: councils.length, councilsRead, failedCouncils: failed.sort(), failureReasons, listed,
        newEvents, baselined, bulkSkipped, companyChecks,
    });
}

/**
 * Hand the poll to run-trigger-poll-background.ts (reading 363 councils plus up to 600 register
 * matches takes minutes, not the 30 s a scheduled or HTTP function gets). Awaited: an un-awaited fetch
 * can be frozen with the lambda. A -background invoke answers 202 as soon as Netlify accepts it.
 */
export async function startTriggerPoll(headers?: Record<string, string | undefined>): Promise<{ started: boolean; error?: string }> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const base = resolveBaseUrl(headers);
    if (!secret || !base) return { started: false, error: !secret ? 'CRON_TRIGGER_SECRET is not set on this site.' : 'Could not work out this site\'s address.' };
    try {
        const res = await fetch(`${base}/.netlify/functions/run-trigger-poll-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ source: FSA_SOURCE }),
            signal: AbortSignal.timeout(8_000),
        });
        return res.status === 202 || res.ok ? { started: true } : { started: false, error: `The poller refused to start (HTTP ${res.status}).` };
    } catch (err) {
        return { started: false, error: `The poller could not be reached: ${err instanceof Error ? err.message : String(err)}` };
    }
}
