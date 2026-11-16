// src/config/lead-site-watch.ts
// Why now Phase 2, website + US part (docs/lead-why-now-and-watching-plan.md §2.2): the RULES for
// watching a saved lead beyond Companies House — which country it is in, what a change on its team page,
// careers page or job board, or in its SEC filings MEANS in plain words, and what counts as new. The
// Companies House rules are the Watch list's (src/lib/triggers/ch-watch.ts); the reads are in
// src/lib/lead-watch-sources.ts; the worker is src/utils/lead-site-watch.ts.
//
// ── The rules that keep a watch signal honest (same as the Watch list) ───────────────────────────
// 1. FIXED WORDING, written by code — never a model's summary. Nothing claims more than the page did.
// 2. FIRST LOOK IS SILENT, per source: the first read of a team page, careers page or SEC filer is the
//    baseline. The one exception that needs a previous look is "Started a careers page".
// 3. EVERY SIGNAL HAS A LINK, A DATE AND A REF. The ref is unique per lead (lead_site_watch_signals), so a
//    job or a person is never reported twice, even if a page flickers.
//
// Pure. No I/O.

export type SiteSignalSource = 'team_page' | 'careers' | 'sec';
export type SiteSignalKind = 'new_team_member' | 'new_job' | 'careers_page' | 'raised_money' | 'fundraising_update' | 'sec_event';
export type SiteDirection = 'positive' | 'neutral' | 'negative';

/** One change, in the Watch list's signal shape plus where it came from. */
export interface SiteSignal {
    kind: SiteSignalKind;
    text: string;
    direction: SiteDirection;
    /** YYYY-MM-DD. */
    occurredOn: string;
    /** Unique per lead. */
    ref: string;
    url: string;
    source: SiteSignalSource;
}

/** How often a watched lead's site is looked at, and sooner after a fresh positive change. */
export const SITE_CHECK_EVERY_DAYS = 7;
export const SITE_RECHECK_AFTER_POSITIVE_DAYS = 3;
/** An EDGAR link that failed is tried again after this long (a company may file its first Form D). */
export const SEC_RELINK_DAYS = 30;
/** The sentinel stored as careers_hash when we looked and found no careers page. */
export const NO_CAREERS = 'none';

const isDay = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d);
const refPart = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);

// ── Country ──────────────────────────────────────────────────────────────────────────────────────

const TLD_COUNTRY: Record<string, string> = { uk: 'gb', us: 'us', ie: 'ie', ca: 'ca', au: 'au', nz: 'nz' };

/**
 * Which country a lead is in (plan §2.1): a Companies House match → gb; else the search's own country;
 * else the web address's country code. Null when nothing settles it — the lead then gets only the
 * sources that work everywhere. Never guessed from the company's name.
 */
export function resolveLeadCountry(input: { chNumber?: string | null; searchCountry?: string | null; domain?: string | null }): string | null {
    if (input.chNumber && /^[A-Z0-9]{6,10}$/i.test(input.chNumber)) return 'gb';
    if (input.searchCountry && /^[a-z]{2}$/.test(input.searchCountry)) return input.searchCountry;
    const tld = String(input.domain || '').toLowerCase().replace(/\.$/, '').split('.').pop() ?? '';
    return TLD_COUNTRY[tld] ?? null;
}

// ── Team page and careers ───────────────────────────────────────────────────────────────────────

export interface TeamPerson { name: string; title: string }

/** New senior people since the last look. `prev` null = first look (baseline). */
export function newTeamPeople(prev: string[] | null, now: TeamPerson[]): TeamPerson[] {
    if (!prev) return [];
    const seen = new Set(prev.map((n) => n.toLowerCase()));
    return now.filter((p) => !seen.has(p.name.toLowerCase()));
}

export function teamSignal(p: TeamPerson, url: string, today: string): SiteSignal {
    return {
        kind: 'new_team_member', source: 'team_page', direction: 'positive', occurredOn: today, url,
        text: `New on their team page: ${p.name}, ${p.title}`, ref: `team:${refPart(p.name)}`,
    };
}

export interface CareersJob { title: string; url: string | null; date: string | null }

/**
 * What changed on the careers side.
 *   prevHash null              → first look: baseline, nothing.
 *   now NO_CAREERS             → nothing (a careers page disappearing is not a reason to call).
 *   prevHash NO_CAREERS, now some → "Started a careers page".
 *   otherwise                  → one signal per new job title, at most five.
 */
export function careersChanges(
    prevHash: string | null, prevTitles: string[] | null, nowHash: string, jobs: CareersJob[], pageUrl: string | null, today: string,
): SiteSignal[] {
    if (!prevHash || nowHash === NO_CAREERS) return [];
    if (prevHash === NO_CAREERS) {
        const url = pageUrl || jobs[0]?.url || '';
        return url ? [{ kind: 'careers_page', source: 'careers', direction: 'positive', occurredOn: today, url, text: 'Started a careers page', ref: 'careers:started' }] : [];
    }
    const seen = new Set((prevTitles ?? []).map((t) => t.toLowerCase()));
    const out: SiteSignal[] = [];
    for (const j of jobs) {
        if (out.length >= 5 || seen.has(j.title.toLowerCase())) continue;
        const url = j.url || pageUrl || '';
        if (!url) continue;
        out.push({
            kind: 'new_job', source: 'careers', direction: 'positive', url,
            occurredOn: isDay(j.date) ? j.date.slice(0, 10) : today,
            text: `Now hiring: ${j.title}`, ref: `job:${refPart(j.title)}`,
        });
    }
    return out;
}

// ── SEC EDGAR (US) ───────────────────────────────────────────────────────────────────────────────

/** "Acme Holdings, Inc." / "ACME HOLDINGS INC" → "acme holdings". US company endings removed. */
export function normaliseUsCompanyName(name: string): string {
    return String(name || '')
        .toLowerCase()
        .replace(/\(cik[^)]*\)/g, ' ')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w && !['inc', 'incorporated', 'llc', 'l', 'c', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'lp', 'llp', 'pllc', 'pc', 'the', 'dba'].includes(w))
        .join(' ');
}

export interface EdgarHit { cik: string; name: string; states: string[] }

/**
 * The EDGAR filer that IS this lead, or null. Needs the same name (normalised) AND one of the filer's
 * business states printed on the lead's own site — a wrong match would tell a user a stranger raised
 * money. More than one filer passing → null (ambiguous).
 */
export function chooseEdgarFiler(leadName: string, hits: EdgarHit[], siteStates: string[]): EdgarHit | null {
    const want = normaliseUsCompanyName(leadName);
    if (want.length < 3 || !siteStates.length) return null;
    const states = new Set(siteStates.map((s) => s.toUpperCase()));
    const byCik = new Map<string, EdgarHit>();
    for (const h of hits) {
        if (normaliseUsCompanyName(h.name) !== want) continue;
        if (!h.states.some((s) => states.has(s.toUpperCase()))) continue;
        byCik.set(h.cik, h);
    }
    return byCik.size === 1 ? [...byCik.values()][0] : null;
}

const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);

/** US states printed on a page as part of an address ("Austin, TX 78701"). Two-letter code + ZIP only. */
export function usStatesInText(text: string): string[] {
    const found = new Set<string>();
    for (const m of String(text || '').matchAll(/,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/g)) {
        if (US_STATES.has(m[1])) found.add(m[1]);
    }
    return [...found];
}

export interface EdgarFiling { accession: string; form: string; date: string | null; primaryDocument: string | null }

/** The SEC submissions JSON's `filings.recent` columns, as rows, newest first. */
export function parseEdgarSubmissions(raw: unknown): EdgarFiling[] {
    const recent = (raw as { filings?: { recent?: Record<string, unknown> } } | null)?.filings?.recent;
    if (!recent) return [];
    const col = (k: string) => (Array.isArray(recent[k]) ? recent[k] as unknown[] : []);
    const acc = col('accessionNumber'); const form = col('form'); const date = col('filingDate'); const doc = col('primaryDocument');
    return acc.map((a, i) => ({
        accession: String(a ?? ''),
        form: String(form[i] ?? ''),
        date: typeof date[i] === 'string' ? String(date[i]) : null,
        primaryDocument: typeof doc[i] === 'string' ? String(doc[i]) : null,
    })).filter((f) => f.accession);
}

/** The new filings since the last look worth a signal. First look (no last accession) → baseline only. */
export function edgarFilingsSince(filings: EdgarFiling[], lastAccession: string | null): { fresh: EdgarFiling[]; newest: string | null } {
    const newest = filings[0]?.accession ?? lastAccession;
    if (!lastAccession) return { fresh: [], newest };
    const idx = filings.findIndex((f) => f.accession === lastAccession);
    if (idx === -1) return { fresh: [], newest };
    return { fresh: filings.slice(0, idx).filter((f) => ['D', 'D/A', '8-K'].includes(f.form)), newest };
}

/** Amount sold, from a Form D's XML (`totalAmountSold`, falling back to `totalOfferingAmount`). */
export function formDAmount(xml: string): number | null {
    for (const tag of ['totalAmountSold', 'totalOfferingAmount']) {
        const m = new RegExp(`<${tag}>\\s*([0-9][0-9.,]*)\\s*</${tag}>`, 'i').exec(String(xml || ''));
        if (m) {
            const n = Number(m[1].replace(/,/g, ''));
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    return null;
}

/** An EDGAR filing as a signal. `amount` from formDAmount (Form D only). */
export function edgarSignal(f: EdgarFiling, cik: string, amount: number | null, today: string): SiteSignal | null {
    const cikInt = String(Number(cik));
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cikInt)}&type=${encodeURIComponent(f.form)}`;
    const occurredOn = f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : today;
    const ref = `sec:${f.accession}`;
    if (f.form === 'D') {
        const text = amount ? `Raised $${Math.round(amount).toLocaleString('en-US')} (SEC Form D)` : 'Filed to raise money (SEC Form D)';
        return { kind: 'raised_money', source: 'sec', direction: 'positive', text, url, occurredOn, ref };
    }
    if (f.form === 'D/A') return { kind: 'fundraising_update', source: 'sec', direction: 'neutral', text: 'Updated its fundraising filing (SEC Form D/A)', url, occurredOn, ref };
    if (f.form === '8-K') return { kind: 'sec_event', source: 'sec', direction: 'neutral', text: 'Filed a company update with the SEC (8-K)', url, occurredOn, ref };
    return null;
}

/** When the lead's site is next due, after a look that found these signals. */
export function nextSiteCheckDays(signals: SiteSignal[]): number {
    return signals.some((s) => s.direction === 'positive') ? SITE_RECHECK_AFTER_POSITIVE_DAYS : SITE_CHECK_EVERY_DAYS;
}
