// src/utils/lead-site-watch.ts
// Why now Phase 2, website + US part (docs/lead-why-now-and-watching-plan.md §2.2). The Watch list
// (src/utils/lead-watch.ts, buying triggers Phase 2) watches Companies House. This watches what needs no
// register match: the lead's own team page (a new senior person), its careers page or job board
// (Greenhouse, Lever, Ashby, Workable: new jobs, or a careers page appearing), and SEC Form D for US leads
// ("Raised $2,000,000").
//
// ── It is part of the Watch list, not a second system ───────────────────────────────────────────
// • Same switch: lead_watch_settings (no row = ON, why-now decision 1). Off → its rows are paused.
// • Same daily run: run-lead-watch-background.ts calls syncSiteWatch + checkDueSiteWatches after the
//   Companies House check, inside the same time budget.
// • Same daily note: rollUpSignals (lead-watch.ts) reads lead_site_watch_signals too.
// • Same tab: the Watch list's News list includes these (lead-watch-list.ts listWatch).
// • Same effect on the lead: applySignalToLead (lead-watch.ts) — research findings, Why now, and a
//   positive signal restarts the 30-day deletion countdown.
//
// ── What it never does ───────────────────────────────────────────────────────────────────────────
// No model, no paid lookup, never contacts anyone, never moves a lead. First look at every source is
// silent. Nothing here stops follow-ups (only a Companies House closure does that).
//
// Needs db/z-lead-site-watch.sql. Until it is applied, every function here returns quietly and the
// Companies House Watch list runs exactly as before.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    getEdgarSubmissions, getFormDXml, isSecConfigured, lookAtSite, searchFormDFilers,
} from '../lib/lead-watch-sources';
import {
    NO_CAREERS, SEC_RELINK_DAYS,
    careersChanges, chooseEdgarFiler, edgarFilingsSince, edgarSignal, formDAmount, newTeamPeople,
    nextSiteCheckDays, parseEdgarSubmissions, resolveLeadCountry, teamSignal, usStatesInText,
    type SiteSignal,
} from '../config/lead-site-watch';
import { resolveSearchArea } from '../lib/discovery-search-area';
import { readTerritoryPlan } from '../config/territory-plan';
import { isRetentionDeleted } from '../config/lead-retention';
import { applySignalToLead, hasColumn, isMissingTable, maxPerAssistant, watchingOn } from './lead-watch';
import { siteChangesToSignals } from '../lib/triggers/site-watch';
import { recordEvent } from './revenue-ledger';
import { getBlueprintVersion } from './blueprint-version';
import { getIcpSnapshot } from './icp-snapshot';

type Db = ReturnType<typeof getDb>;

/** EDGAR allows 10 requests a second; stay well under. */
const SEC_GAP_MS = 200;
const CLAIM_BATCH = 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// ── Which leads (pure, exported for tests) ───────────────────────────────────────────────────────

export interface SiteCandidate {
    recordId: number;
    organisationId: number;
    assistantId: number;
    data: unknown;
    approvalStatus: string | null;
    updatedAt: string;
    domain: string | null;
    campaignIdea: string | null;
    approvedBrief: unknown;
}

export interface SitePlanRow { recordId: number; organisationId: number; assistantId: number; domain: string; country: string | null }

/** The host a lead's site lives on, or null. */
export function leadDomain(c: { domain: string | null; data: unknown }): string | null {
    const d = (c.data && typeof c.data === 'object' && !Array.isArray(c.data)) ? c.data as Record<string, unknown> : {};
    const raw = c.domain || (typeof d.website === 'string' ? d.website : '') || (typeof d.domain === 'string' ? d.domain : '');
    const host = String(raw).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/**
 * Lead records → the leads whose site is watched, per assistant. Same exclusions as the Companies House
 * Watch list (do-not-contact, deleted, lost or disqualified), plus turned-down and erased leads. Won leads
 * (customers) always; open leads newest first up to the cap. Emailed-with-no-reply leads stay watched
 * (why-now decision 5).
 */
export function planSiteRows(candidates: SiteCandidate[], cap: number): SitePlanRow[] {
    const byAssistant = new Map<number, { customers: SitePlanRow[]; leads: Array<SitePlanRow & { at: string }> }>();
    const seenRecord = new Set<number>();
    for (const c of candidates) {
        if (seenRecord.has(c.recordId)) continue;
        seenRecord.add(c.recordId);
        const d = (c.data && typeof c.data === 'object' && !Array.isArray(c.data)) ? c.data as Record<string, unknown> : {};
        if (c.approvalStatus === 'rejected' || d.erasedAt) continue;
        if (d.doNotContact === true || d.doNotContact === 'true') continue;
        if (isRetentionDeleted(d)) continue;
        const outcome = (d.dealOutcome && typeof d.dealOutcome === 'object') ? String((d.dealOutcome as Record<string, unknown>).outcome ?? '') : '';
        if (outcome && outcome !== 'won') continue;
        const domain = leadDomain(c);
        if (!domain) continue;
        const ch = (d.companiesHouse && typeof d.companiesHouse === 'object') ? d.companiesHouse as Record<string, unknown> : null;
        const area = resolveSearchArea([c.campaignIdea, readTerritoryPlan(c.approvedBrief)?.area]);
        const row: SitePlanRow = {
            recordId: c.recordId, organisationId: c.organisationId, assistantId: c.assistantId, domain,
            country: resolveLeadCountry({ chNumber: typeof ch?.number === 'string' ? ch.number : null, searchCountry: area?.country ?? null, domain }),
        };
        const slot = byAssistant.get(c.assistantId) ?? { customers: [], leads: [] };
        if (outcome === 'won') slot.customers.push(row); else slot.leads.push({ ...row, at: c.updatedAt });
        byAssistant.set(c.assistantId, slot);
    }
    const out: SitePlanRow[] = [];
    for (const { customers, leads } of byAssistant.values()) {
        out.push(...customers);
        const room = Math.max(0, cap - customers.length);
        leads.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        for (const { at: _at, ...r } of leads.slice(0, room)) out.push(r);
    }
    return out;
}

// ── Sync ─────────────────────────────────────────────────────────────────────────────────────────

export interface SiteSyncResult { setUp: boolean; watched: number; paused: number }

export async function syncSiteWatch(db: Db): Promise<SiteSyncResult> {
    try {
        await db.execute(sql`SELECT 1 FROM lead_site_watch LIMIT 1`);
    } catch (err) {
        if (isMissingTable(err)) return { setUp: false, watched: 0, paused: 0 };
        throw err;
    }
    const assistants = await db.execute(sql`
        SELECT a.id, s.enabled
          FROM ai_assistants a
          JOIN master_assistants m ON m.id = a.master_assistant_id
          LEFT JOIN lead_watch_settings s ON s.ai_assistant_id = a.id
         WHERE m.role_key = 'lead_qualifier' AND a.is_active = true AND a.archived_at IS NULL
    `) as Array<{ id: number; enabled: boolean | null }>;
    const onIds = assistants.filter((a) => watchingOn(a.enabled)).map((a) => a.id);
    const offIds = assistants.filter((a) => !watchingOn(a.enabled)).map((a) => a.id);

    let paused = 0;
    if (offIds.length) {
        const r = await db.execute(sql`
            UPDATE lead_site_watch SET paused_reason = 'watching_off', updated_at = now()
             WHERE ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(offIds)}::jsonb)::int)
               AND paused_reason IS DISTINCT FROM 'watching_off'
            RETURNING assistant_record_id`) as unknown[];
        paused += r.length;
    }
    if (!onIds.length) return { setUp: true, watched: 0, paused };

    const candidates = await db.execute(sql`
        SELECT r.id AS "recordId", r.organisation_id AS "organisationId", r.ai_assistant_id AS "assistantId",
               r.data, r.approval_status AS "approvalStatus",
               to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "updatedAt",
               dl.domain, dc.idea AS "campaignIdea", dc.approved_brief AS "approvedBrief"
          FROM assistant_records r
          LEFT JOIN discovered_leads dl ON dl.assistant_record_id = r.id
          LEFT JOIN discovery_campaigns dc ON dc.id = dl.campaign_id
         WHERE r.record_type = 'lead'
           AND r.ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(onIds)}::jsonb)::int)
           AND (dl.domain IS NOT NULL OR r.data ->> 'website' IS NOT NULL OR r.data ->> 'domain' IS NOT NULL)
    `) as unknown as SiteCandidate[];
    const plan = planSiteRows(candidates, maxPerAssistant());

    if (plan.length) {
        await db.execute(sql`
            INSERT INTO lead_site_watch (assistant_record_id, organisation_id, ai_assistant_id, domain, country, next_check_at)
            SELECT x."recordId", x."organisationId", x."assistantId", x.domain, x.country,
                   -- First looks spread over three days, so a big account's baseline is not one burst.
                   now() + make_interval(days => (x."recordId" % 3))
              FROM jsonb_to_recordset(${JSON.stringify(plan)}::jsonb)
                AS x("recordId" int, "organisationId" int, "assistantId" int, domain text, country text)
            ON CONFLICT (assistant_record_id) DO UPDATE SET
                domain = EXCLUDED.domain,
                country = COALESCE(EXCLUDED.country, lead_site_watch.country),
                paused_reason = NULL,
                updated_at = now()
        `);
    }
    const keep = plan.map((p) => p.recordId);
    const r = await db.execute(sql`
        UPDATE lead_site_watch SET paused_reason = 'lead_excluded', updated_at = now()
         WHERE ai_assistant_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(onIds)}::jsonb)::int)
           AND paused_reason IS NULL
           AND assistant_record_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb)::int)
        RETURNING assistant_record_id`) as unknown[];
    paused += r.length;
    return { setUp: true, watched: plan.length, paused };
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────

interface SiteRow {
    assistant_record_id: number;
    organisation_id: number;
    ai_assistant_id: number;
    domain: string;
    country: string | null;
    sec_cik: string | null;
    sec_link_tried_at: string | null;
    sec_last_accession: string | null;
    team_names: unknown;
    careers_hash: string | null;
    careers_titles: unknown;
    /** Phase 4: tools seen on the home page last time. NULL = never read (or the column is not there yet). */
    site_markers: unknown;
    title: string | null;
}

export interface SiteLookResult {
    signals: SiteSignal[];
    patch: {
        teamNames?: string[]; careersHash?: string; careersSource?: string | null; careersTitles?: string[];
        secCik?: string; secLinkTriedAt?: boolean; secLastAccession?: string | null;
        siteMarkers?: string[];
    };
    error: string | null;
}

/** One look at one lead's site (and SEC filer). Each source independent: a failure keeps its old snapshot. */
export async function lookAtLeadSite(row: SiteRow, day: string): Promise<SiteLookResult> {
    const signals: SiteSignal[] = [];
    const patch: SiteLookResult['patch'] = {};
    const errors: string[] = [];

    const look = await lookAtSite(row.domain, NO_CAREERS, usStatesInText);
    if (look.reached) {
        if (look.team) {
            const prev = Array.isArray(row.team_names) ? (row.team_names as unknown[]).map(String) : null;
            if (look.teamUrl) for (const p of newTeamPeople(prev, look.team)) signals.push(teamSignal(p, look.teamUrl, day));
            patch.teamNames = look.team.map((p) => p.name);
        }
        if (look.careersHash) {
            const prevTitles = Array.isArray(row.careers_titles) ? (row.careers_titles as unknown[]).map(String) : null;
            signals.push(...careersChanges(row.careers_hash, prevTitles, look.careersHash, look.jobs, look.careersUrl, day));
            patch.careersHash = look.careersHash;
            patch.careersSource = look.careersSource;
            patch.careersTitles = look.jobs.map((j) => j.title);
        }
        // Buying triggers Phase 4: a tool ADDED to the home page (ads, booking, shop, a rebuild).
        if (look.markers) {
            const prev = Array.isArray(row.site_markers) ? (row.site_markers as unknown[]).map(String) : null;
            for (const s of siteChangesToSignals(prev, look.markers, row.domain, day)) {
                signals.push({ ...s, kind: s.kind as SiteSignal['kind'], source: 'site' });
            }
            patch.siteMarkers = look.markers;
        }
    } else errors.push('site_unreachable');

    if (row.country === 'us' && isSecConfigured()) {
        let cik = row.sec_cik;
        const tried = row.sec_link_tried_at ? Date.parse(row.sec_link_tried_at) : 0;
        if (!cik && row.title && look.usStates.length && Date.now() - tried > SEC_RELINK_DAYS * 86400000) {
            const found = await searchFormDFilers(row.title);
            await sleep(SEC_GAP_MS);
            if (found.status === 'ok') {
                patch.secLinkTriedAt = true;
                const filer = chooseEdgarFiler(row.title, found.value, look.usStates);
                if (filer) { cik = filer.cik; patch.secCik = cik; }
            } else errors.push(`sec_search:${found.reason}`);
        }
        if (cik) {
            const sub = await getEdgarSubmissions(cik);
            await sleep(SEC_GAP_MS);
            if (sub.status === 'ok') {
                // A filer linked on THIS look has no previous accession: its history is the baseline.
                const { fresh, newest } = edgarFilingsSince(parseEdgarSubmissions(sub.value), row.sec_cik ? row.sec_last_accession : null);
                for (const f of fresh.slice(0, 3)) {
                    let amount: number | null = null;
                    if (f.form === 'D') {
                        const xml = await getFormDXml(cik, f.accession, f.primaryDocument);
                        await sleep(SEC_GAP_MS);
                        if (xml.status === 'ok') amount = formDAmount(xml.value);
                    }
                    const s = edgarSignal(f, cik, amount, day);
                    if (s) signals.push(s);
                }
                patch.secLastAccession = newest;
            } else errors.push(`sec_submissions:${sub.reason}`);
        }
    }
    return { signals, patch, error: errors.length ? errors.join(', ') : null };
}

/** Save one signal. False when the lead already had it (unique per lead and ref). */
async function recordSiteSignal(db: Db, row: SiteRow, sig: SiteSignal): Promise<boolean> {
    const inserted = await db.execute(sql`
        INSERT INTO lead_site_watch_signals (assistant_record_id, organisation_id, ai_assistant_id, kind, text, direction, occurred_on, ref, url, source)
        VALUES (${row.assistant_record_id}, ${row.organisation_id}, ${row.ai_assistant_id}, ${sig.kind}, ${sig.text}, ${sig.direction},
                ${sig.occurredOn}::date, ${sig.ref}, ${sig.url}, ${sig.source})
        ON CONFLICT (assistant_record_id, ref) DO NOTHING
        RETURNING id`) as unknown[];
    if (!inserted.length) return false;
    await applySignalToLead(db, row.assistant_record_id, sig);
    try {
        await recordEvent(db, 'signal_captured', {
            organisationId: row.organisation_id, aiAssistantId: row.ai_assistant_id, assistantRecordId: row.assistant_record_id,
            actor: 'system',
            blueprintVersion: await getBlueprintVersion(db, row.ai_assistant_id),
            icpSnapshot: await getIcpSnapshot(db, { assistantRecordId: row.assistant_record_id, aiAssistantId: row.ai_assistant_id }),
            payload: { source: 'watch', watchSource: sig.source, kind: sig.kind, direction: sig.direction, text: sig.text, url: sig.url, occurredOn: sig.occurredOn },
        });
    } catch (err) {
        console.warn('[lead-site-watch] ledger write failed (the signal is saved)', err);
    }
    return true;
}

async function claimDueSites(db: Db, limit: number): Promise<SiteRow[]> {
    return await db.execute(sql`
        WITH pick AS (
            SELECT assistant_record_id FROM (
                SELECT assistant_record_id, next_check_at,
                       row_number() OVER (PARTITION BY ai_assistant_id ORDER BY next_check_at) AS turn
                  FROM lead_site_watch
                 WHERE paused_reason IS NULL AND next_check_at <= now()
            ) due
            ORDER BY turn, next_check_at
            LIMIT ${limit}
        ), claimed AS (
            UPDATE lead_site_watch w SET next_check_at = now() + interval '2 hours'
              FROM pick WHERE w.assistant_record_id = pick.assistant_record_id
            RETURNING w.*
        )
        SELECT c.assistant_record_id, c.organisation_id, c.ai_assistant_id, c.domain, c.country, c.sec_cik,
               to_char(c.sec_link_tried_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sec_link_tried_at,
               c.sec_last_accession, c.team_names, c.careers_hash, c.careers_titles,
               -- to_jsonb(c): reads the Phase 4 column without failing before db/z-site-markers.sql adds it.
               to_jsonb(c) -> 'site_markers' AS site_markers, r.title
          FROM claimed c JOIN assistant_records r ON r.id = c.assistant_record_id`) as unknown as SiteRow[];
}

export interface SiteCheckResult { setUp: boolean; checked: number; signals: number; errors: number; stoppedEarly: boolean }

export async function checkDueSiteWatches(db: Db, opts: { deadline: number }): Promise<SiteCheckResult> {
    const out: SiteCheckResult = { setUp: true, checked: 0, signals: 0, errors: 0, stoppedEarly: false };
    try {
        await db.execute(sql`SELECT 1 FROM lead_site_watch LIMIT 1`);
    } catch (err) {
        if (isMissingTable(err)) return { ...out, setUp: false };
        throw err;
    }
    const day = today();
    const hasMarkers = await hasColumn(db, 'lead_site_watch', 'site_markers');
    while (Date.now() < opts.deadline) {
        const rows = await claimDueSites(db, CLAIM_BATCH);
        if (!rows.length) return out;
        for (const row of rows) {
            if (Date.now() >= opts.deadline) {
                await db.execute(sql`UPDATE lead_site_watch SET next_check_at = now() WHERE assistant_record_id = ${row.assistant_record_id}`);
                out.stoppedEarly = true;
                continue;
            }
            try {
                const look = await lookAtLeadSite(row, day);
                const saved: SiteSignal[] = [];
                for (const s of look.signals) if (await recordSiteSignal(db, row, s)) saved.push(s);
                const p = look.patch;
                await db.execute(sql`
                    UPDATE lead_site_watch SET
                        team_names = COALESCE(${p.teamNames ? JSON.stringify(p.teamNames) : null}::jsonb, team_names),
                        careers_hash = COALESCE(${p.careersHash ?? null}, careers_hash),
                        careers_source = CASE WHEN ${p.careersHash != null} THEN ${p.careersSource ?? null} ELSE careers_source END,
                        careers_titles = COALESCE(${p.careersTitles ? JSON.stringify(p.careersTitles) : null}::jsonb, careers_titles),
                        sec_cik = COALESCE(${p.secCik ?? null}, sec_cik),
                        sec_link_tried_at = CASE WHEN ${p.secLinkTriedAt === true} THEN now() ELSE sec_link_tried_at END,
                        sec_last_accession = COALESCE(${p.secLastAccession ?? null}, sec_last_accession),
                        ${hasMarkers && p.siteMarkers ? sql`site_markers = ${JSON.stringify(p.siteMarkers)}::jsonb,` : sql``}
                        checks_done = checks_done + 1,
                        last_checked_at = now(), last_error = ${look.error},
                        next_check_at = now() + make_interval(days => ${nextSiteCheckDays(saved)}),
                        updated_at = now()
                     WHERE assistant_record_id = ${row.assistant_record_id}`);
                out.checked++;
                out.signals += saved.length;
                if (look.error) out.errors++;
            } catch (err) {
                out.errors++;
                console.error('[lead-site-watch] look failed for record', row.assistant_record_id, err instanceof Error ? err.message : err);
                await db.execute(sql`
                    UPDATE lead_site_watch SET last_error = 'failed', next_check_at = now() + interval '1 day', updated_at = now()
                     WHERE assistant_record_id = ${row.assistant_record_id}`);
            }
        }
    }
    out.stoppedEarly = true;
    return out;
}
