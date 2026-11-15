// src/lib/triggers/fsa-fhrs.ts
// Buying-trigger source 1 (docs/buying-triggers-plan.md §1 row 1, §5 Phase 1): new food and drink
// premises, from the Food Standards Agency's food hygiene ratings list (FHRS in England, Wales and
// Northern Ireland, FHIS in Scotland).
//
// ── Why this list ────────────────────────────────────────────────────────────────────────────────
// A food business must register with its council 28 days before it opens. The council lists it as
// "Awaiting Inspection" until its first visit, so a NEW entry on that list is often a business that
// has not opened yet: the moment a sign maker, fit-out firm, accountant or insurer wants to be first.
//
// ── How it is read ───────────────────────────────────────────────────────────────────────────────
// The list has no "added since" filter, so we diff: every day, read every council's awaiting list and
// compare the FHRSIDs with the ones already seen (trigger_seen). One request per council (363 of them,
// the largest about 1,900 entries, under the 5,000 page size) rather than paging the national list:
// the national list re-sorts as entries arrive, so a row can slip between two pages and come back the
// next day looking new. A council that fails is skipped for the day, never half-read.
//
// The API: https://api.ratings.food.gov.uk (header x-api-version: 2). Free, no key, Open Government
// Licence v3.0 — attribution "Contains public sector information licensed under the Open Government
// Licence v3.0" (on the Admin page that shows it).
//
// Switched off with TRIGGER_SOURCE_FSA_FHRS=off (one switch per source, §7).

import type { TriggerEvent, TriggerLabel } from './types';

const API = 'https://api.ratings.food.gov.uk';
const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 5000;

export const FSA_SOURCE = 'fsa_fhrs' as const;

export function isFsaSourceEnabled(): boolean {
    return String(process.env.TRIGGER_SOURCE_FSA_FHRS ?? '').toLowerCase() !== 'off';
}

/** The fields we read from one FHRS establishment. The API sends more; we keep only these. */
export interface FhrsEstablishment {
    FHRSID: number;
    BusinessName?: string;
    BusinessType?: string;
    BusinessTypeID?: number;
    AddressLine1?: string;
    AddressLine2?: string;
    AddressLine3?: string;
    AddressLine4?: string;
    PostCode?: string;
    RatingValue?: string;
    RatingKey?: string;
    LocalAuthorityName?: string;
    LocalAuthorityCode?: string;
    SchemeType?: string;
    geocode?: { longitude?: string | null; latitude?: string | null } | null;
}

export interface FhrsAuthority {
    id: number;
    name: string;
}

// ── Pure helpers (exported for tests/buying-triggers.test.ts) ────────────────────────────────────

/**
 * The FSA's business type as a stable code: "Restaurant/Cafe/Canteen" → "restaurant_cafe_canteen".
 * The FSA's own type names are the trade list for this source (plan §3 "trade codes").
 */
export function fhrsTradeCode(businessType: string | undefined | null): string {
    const s = String(businessType || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'unknown';
}

/** Does the trading name itself say it is a company? (Most do not — the register match finds more.) */
export function nameLooksCorporate(name: string | null | undefined): boolean {
    return /\b(ltd|limited|plc|llp|cic)\b\.?/i.test(String(name || ''));
}

export function fhrsAddress(e: FhrsEstablishment): string {
    return [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4]
        .map((p) => String(p || '').trim()).filter(Boolean).join(', ');
}

/**
 * Was an address published that a letter could go to? Home-based businesses have theirs withheld
 * (about half in a Leeds sample), and the FSA then often shows only the postcode district ("DE55"):
 * that is not an address, so it counts as withheld.
 */
export function fhrsHasAddress(e: FhrsEstablishment): boolean {
    return fhrsAddress(e).length > 0 && normalisePostcode(e.PostCode) !== null;
}

/** Is this entry still awaiting its first inspection (England/Wales/NI or Scotland wording)? */
export function isAwaitingInspection(e: FhrsEstablishment): boolean {
    const key = String(e.RatingKey || '').toLowerCase();
    return /awaitinginspection|awaiting_inspection|ratingawaited/.test(key) || String(e.RatingValue || '') === 'AwaitingInspection';
}

function normalisePostcode(pc: unknown): string | null {
    const m = String(pc || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    return m ? `${m[1]} ${m[2]}` : null;
}

/** One establishment seen for the first time → one trigger event, dated the day we saw it. */
export function fhrsToEvent(e: FhrsEstablishment, seenOn: string): TriggerEvent {
    const address = fhrsAddress(e);
    const lat = Number(e.geocode?.latitude);
    const lng = Number(e.geocode?.longitude);
    return {
        kind: 'food_premises_registered',
        source: FSA_SOURCE,
        sourceEventId: String(e.FHRSID),
        country: 'GB',
        subjectType: 'fhrs_id',
        subjectId: String(e.FHRSID),
        name: String(e.BusinessName || '').trim() || null,
        postcode: normalisePostcode(e.PostCode),
        area: String(e.LocalAuthorityName || '').trim() || null,
        tradeCodes: [fhrsTradeCode(e.BusinessType)],
        occurredOn: seenOn,
        payload: {
            businessType: e.BusinessType ?? null,
            businessTypeId: e.BusinessTypeID ?? null,
            address: address || null,
            hasAddress: fhrsHasAddress(e),
            nameLooksCorporate: nameLooksCorporate(e.BusinessName),
            scheme: e.SchemeType ?? null,
            localAuthorityCode: e.LocalAuthorityCode ?? null,
            lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
            lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
        },
    };
}

/**
 * The fixed wording (plan §2, §4). Says how we know ("the FSA's public ratings list") and never
 * implies official status or treats the inspection as a threat.
 */
export function fhrsLabel(ev: Pick<TriggerEvent, 'occurredOn' | 'payload'>): TriggerLabel {
    const address = typeof ev.payload?.address === 'string' && ev.payload.address ? ` at ${ev.payload.address}` : '';
    const d = new Date(`${ev.occurredOn}T12:00:00Z`);
    const when = Number.isNaN(d.getTime()) ? ev.occurredOn : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return {
        text: `Registered a new food business${address}: awaiting first inspection, from the FSA's public ratings list (${when})`,
        direction: 'positive',
    };
}

// ── Network ──────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * The API sits behind a firewall that answers bursts with 429 or 403 (2026-11-15: two councils at a time
 * from Node got 172 × 403 out of 363; one at a time still got the odd 403/429). So the engine reads ONE
 * council at a time with a short gap (REQUEST_GAP_MS), and a 403, 429 or 5xx waits (Retry-After, else
 * 2 s, 5 s, 10 s, 20 s) and tries again. Any other 4xx is final.
 */
export const REQUEST_GAP_MS = 250;

async function getJson(path: string): Promise<unknown> {
    const waits = [2_000, 5_000, 10_000, 20_000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= waits.length; attempt++) {
        let retryAfterMs = 0;
        try {
            const res = await fetch(`${API}${path}`, {
                headers: { 'x-api-version': '2', accept: 'application/json', 'user-agent': 'BeMoreSwan-triggers/1.0' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) return await res.json();
            await res.arrayBuffer().catch(() => null);
            lastErr = new Error(`HTTP ${res.status}`);
            if (res.status !== 403 && res.status !== 429 && res.status < 500) break;
            retryAfterMs = Math.min(30_000, (Number(res.headers.get('retry-after')) || 0) * 1000);
        } catch (err) {
            lastErr = err;
        }
        if (attempt < waits.length) await sleep(Math.max(retryAfterMs, waits[attempt]));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchAuthorities(): Promise<FhrsAuthority[]> {
    const body = await getJson('/Authorities/basic') as { authorities?: Array<{ LocalAuthorityId?: number; Name?: string }> };
    return (body.authorities || [])
        .filter((a) => Number.isInteger(a.LocalAuthorityId))
        .map((a) => ({ id: a.LocalAuthorityId as number, name: String(a.Name || '') }));
}

/** Every establishment in one council still awaiting inspection. Throws if any page fails. */
export async function fetchAwaiting(authorityId: number): Promise<FhrsEstablishment[]> {
    const out: FhrsEstablishment[] = [];
    for (let page = 1; page <= 20; page++) {
        const body = await getJson(`/Establishments?localAuthorityId=${authorityId}&ratingKey=AwaitingInspection&pageSize=${PAGE_SIZE}&pageNumber=${page}`) as {
            establishments?: FhrsEstablishment[]; meta?: { totalPages?: number };
        };
        const rows = Array.isArray(body.establishments) ? body.establishments : [];
        out.push(...rows.filter((e) => Number.isInteger(e.FHRSID) && isAwaitingInspection(e)));
        if (page >= Number(body.meta?.totalPages || 1)) break;
    }
    return out;
}
