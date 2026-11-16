// src/lib/triggers/ch-watch.ts
// Buying triggers Phase 2 (docs/buying-triggers-plan.md §3, §5; docs/lead-why-now-and-watching-plan.md
// 2.2): what a Companies House filing or status change MEANS for a watched company, in fixed wording.
//
// Pure: no network, no database. The wording is written by code, never by a model, so a signal can
// never claim more than the register said (plan §2). Unknown filing types return null and are ignored.
//
// Two readers feed this module the same filing shape (CompaniesHouseFiling):
//   - the per-company check (filing history, src/utils/lead-watch.ts), and
//   - the Companies House filings stream (parseStreamEvent below), when COMPANIES_HOUSE_STREAM_KEY is set.

import type { CompaniesHouseFiling } from '../companies-house';
import type { TriggerDirection } from './types';

export type WatchSignalKind =
    | 'director_appointed'
    | 'director_left'
    | 'office_moved'
    | 'charge_registered'
    | 'owner_added'
    | 'owner_left'
    | 'company_closing';

export interface WatchSignal {
    kind: WatchSignalKind;
    text: string;
    direction: TriggerDirection;
    /** YYYY-MM-DD: the date on the filing (or the day we saw a status change). */
    occurredOn: string;
    /** Unique per company: the filing's transaction id, or `status:<status>` for a status change. */
    ref: string;
    /** Where a person can check it for themselves. */
    url: string;
}

export function companyUrl(number: string): string {
    return `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number)}`;
}

function filingsUrl(number: string): string {
    return `${companyUrl(number)}/filing-history`;
}

/** "MR JOHN SMITH" / "Mr John Smith" → "John Smith". Titles dropped; register capitals softened. */
export function tidyName(raw: string | undefined | null): string {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(mr|mrs|ms|miss|dr|sir|dame|lord|lady|prof|professor|rev)\.?\s+/i, '');
    if (s && s === s.toUpperCase()) {
        s = s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`);
    }
    return s.slice(0, 120);
}

function friendlyDate(iso: string): string {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * One filing → one signal, or null when the type is not one we turn into news. The directions follow
 * the why-now plan's 2.2 table; PSC changes are this plan's "New owner / controller" (Phase 2).
 */
export function filingToSignal(f: CompaniesHouseFiling, companyNumber: string, seenOn: string): WatchSignal | null {
    const on = f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : seenOn;
    const when = friendlyDate(on);
    const base = { occurredOn: on, ref: f.transactionId, url: filingsUrl(companyNumber) };
    const officer = tidyName(f.values.officer_name);
    const psc = tidyName(f.values.psc_name);
    switch (f.type) {
        case 'AP01':
        case 'AP02':
            return { ...base, kind: 'director_appointed', direction: 'positive', text: officer ? `Appointed a new director: ${officer}, ${when}` : `Appointed a new director, ${when}` };
        case 'TM01': // TM02 (a company secretary leaving) is not news for a seller
            return { ...base, kind: 'director_left', direction: 'neutral', text: officer ? `${officer} stepped down as director, ${when}` : `A director stepped down, ${when}` };
        case 'AD01':
            return { ...base, kind: 'office_moved', direction: 'positive', text: `Moved registered office, ${when}` };
        case 'MR01':
            return { ...base, kind: 'charge_registered', direction: 'positive', text: `Registered a new charge (borrowing), ${when}` };
        case 'PSC01':
        case 'PSC02':
        case 'PSC03':
            return { ...base, kind: 'owner_added', direction: 'positive', text: psc ? `New owner or controller: ${psc}, ${when}` : `New owner or controller, ${when}` };
        case 'PSC07':
            return { ...base, kind: 'owner_left', direction: 'neutral', text: psc ? `${psc} is no longer an owner or controller, ${when}` : `An owner or controller left, ${when}` };
        default:
            return null;
    }
}

/** Register statuses that mean the company is closing or closed. Wording for each. */
const CLOSING_STATUS: Record<string, string> = {
    liquidation: 'in liquidation',
    administration: 'in administration',
    receivership: 'in receivership',
    'insolvency-proceedings': 'in insolvency proceedings',
    'voluntary-arrangement': 'in a voluntary arrangement with creditors',
    dissolved: 'dissolved',
    'converted-closed': 'closed',
};

export function isClosingStatus(status: string | null | undefined): boolean {
    return !!status && Object.prototype.hasOwnProperty.call(CLOSING_STATUS, status);
}

/**
 * A status change → a negative signal, only when it moves INTO a closing status. The first status we
 * ever record (prev = null) is the silent baseline and never a signal.
 */
export function statusToSignal(prev: string | null, next: string | null, companyNumber: string, seenOn: string): WatchSignal | null {
    if (prev === null || !next || prev === next || !isClosingStatus(next)) return null;
    return {
        kind: 'company_closing',
        direction: 'negative',
        text: `Companies House shows this company ${CLOSING_STATUS[next]}`,
        occurredOn: seenOn,
        ref: `status:${next}`,
        url: companyUrl(companyNumber),
    };
}

/**
 * Filings newer than the last one we saw, oldest first. `lastSeen` null = first look: nothing is new
 * (the baseline is silent, why-now 2.3). If the last seen id is no longer in the list (more than a
 * page of filings since, or it was removed), everything in the list is treated as new; the caller's
 * unique (watch, ref) key stops a repeat.
 */
export function newFilingsSince(filingsNewestFirst: CompaniesHouseFiling[], lastSeen: string | null): CompaniesHouseFiling[] {
    if (lastSeen === null) return [];
    const idx = filingsNewestFirst.findIndex((f) => f.transactionId === lastSeen);
    const fresh = idx === -1 ? filingsNewestFirst : filingsNewestFirst.slice(0, idx);
    return [...fresh].reverse();
}

/** Company numbers: 8 characters, digits or a 2-letter prefix (SC, NI, OC…). Returns null if not one. */
export function normaliseCompanyNumber(raw: unknown): string | null {
    let s = String(raw ?? '').toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{1,8}$/.test(s)) return null;
    if (/^\d+$/.test(s)) s = s.padStart(8, '0');
    else if (/^[A-Z]{2}\d{1,6}$/.test(s)) s = s.slice(0, 2) + s.slice(2).padStart(6, '0');
    return /^([A-Z]{2}\d{6}|\d{8})$/.test(s) ? s : null;
}

// ── The Companies House streaming API ────────────────────────────────────────────────────────────

export type StreamResource = 'filings' | 'companies';

export interface StreamEvent {
    resource: StreamResource;
    timepoint: number;
    companyNumber: string;
    /** For filings: the filing. For companies: the company status. */
    filing: CompaniesHouseFiling | null;
    status: string | null;
}

/**
 * One line of a stream → an event, or null (heartbeats are blank lines; anything unreadable is
 * skipped). resource_uri is "/company/{number}/filing-history/{id}" or "/company/{number}".
 */
export function parseStreamEvent(line: string, resource: StreamResource, parse: (raw: unknown) => CompaniesHouseFiling | null): StreamEvent | null {
    const t = line.trim();
    if (!t) return null;
    let j: Record<string, unknown>;
    try { j = JSON.parse(t); } catch { return null; }
    const ev = (j.event && typeof j.event === 'object') ? j.event as Record<string, unknown> : {};
    const timepoint = Number(ev.timepoint);
    const m = /^\/company\/([A-Z0-9]+)/i.exec(String(j.resource_uri || ''));
    const companyNumber = m ? normaliseCompanyNumber(m[1]) : null;
    if (!Number.isFinite(timepoint) || !companyNumber) return null;
    const data = (j.data && typeof j.data === 'object') ? j.data as Record<string, unknown> : {};
    if (resource === 'filings') {
        return { resource, timepoint, companyNumber, filing: parse(data), status: null };
    }
    return { resource, timepoint, companyNumber, filing: null, status: typeof data.company_status === 'string' ? data.company_status : null };
}
