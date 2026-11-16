// src/lib/lead-watch-sources.ts
// Why now Phase 2 (docs/lead-why-now-and-watching-plan.md §2.2): the READS for watching a saved lead —
// SEC EDGAR, the lead's own team page and careers page, and the public job boards a careers page links
// to. Companies House reads live with the rest of the register code (src/lib/companies-house.ts
// and the Watch list, src/utils/lead-watch.ts). What a change MEANS is decided in src/config/lead-site-watch.ts.
//
// ── Contract ─────────────────────────────────────────────────────────────────────────────────────
// NEVER THROWS. Every read says whether it ANSWERED: `error` (timeout, 429, not configured) is a fact
// about us, never about the company — the worker keeps the previous snapshot rather than recording
// "no careers page" because a site was slow. Same rule as discovery-enrich-provider.ts.
//
// No model anywhere. Free sources only: nothing here costs per call.
//
// Config:
//   SEC_USER_AGENT        — required for EDGAR ("Be More Swan ops@…"); unset = EDGAR skipped. The SEC
//                           requires a contact in the User-Agent. ⚠️ An ops mailbox, NEVER a customer's.
//   LEAD_WATCH_TIMEOUT_MS — per request (default 8000)

import * as cheerio from 'cheerio';
import { safeFetchText, USER_AGENTS } from '../utils/safe-fetch';
import { discoverSitePaths } from './discovery-enrich';
import { CAREERS_PATHS, PEOPLE_PATHS } from './lead-intel';
import { isDecisionMakerTitle } from '../config/lead-person';
import type { CareersJob, EdgarHit, TeamPerson } from '../config/lead-site-watch';

const TIMEOUT_MS = Number(process.env.LEAD_WATCH_TIMEOUT_MS ?? '8000');
const MAX_PAGE_BYTES = 1024 * 1024;

type Outcome<T> = { status: 'ok'; value: T } | { status: 'error'; reason: string };

// ── Plain JSON from a fixed host ─────────────────────────────────────────────────────────────────

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Outcome<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
        if (res.status === 404) return { status: 'ok', value: null };
        if (!res.ok) return { status: 'error', reason: `http_${res.status}` };
        return { status: 'ok', value: await res.json().catch(() => null) };
    } catch (err) {
        return { status: 'error', reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

async function getText(url: string, headers: Record<string, string> = {}): Promise<Outcome<string>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers });
        if (!res.ok) return { status: 'error', reason: `http_${res.status}` };
        return { status: 'ok', value: (await res.text()).slice(0, MAX_PAGE_BYTES) };
    } catch (err) {
        return { status: 'error', reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

// ── SEC EDGAR ────────────────────────────────────────────────────────────────────────────────────

export function isSecConfigured(): boolean {
    return Boolean((process.env.SEC_USER_AGENT || '').trim());
}
function secHeaders(): Record<string, string> {
    return { 'User-Agent': String(process.env.SEC_USER_AGENT).trim() };
}

/** Form D filers whose filings mention this name (EDGAR full-text search). Parsed defensively. */
export async function searchFormDFilers(name: string): Promise<Outcome<EdgarHit[]>> {
    if (!isSecConfigured()) return { status: 'error', reason: 'not_configured' };
    const r = await getJson(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name}"`)}&forms=D`, secHeaders());
    if (r.status === 'error') return r;
    return { status: 'ok', value: parseEdgarSearch(r.value) };
}

/** EDGAR full-text search JSON → one hit per (cik, name). Exported for the tests. */
export function parseEdgarSearch(raw: unknown): EdgarHit[] {
    const hits = (raw as { hits?: { hits?: unknown } } | null)?.hits?.hits;
    if (!Array.isArray(hits)) return [];
    const out: EdgarHit[] = [];
    for (const h of hits) {
        const src = (h && typeof h === 'object' ? (h as Record<string, unknown>)._source : null) as Record<string, unknown> | null;
        if (!src) continue;
        const ciks = Array.isArray(src.ciks) ? src.ciks.map(String) : [];
        const names = Array.isArray(src.display_names) ? src.display_names.map(String) : [];
        const states = Array.isArray(src.biz_states) ? src.biz_states.map(String) : [];
        ciks.forEach((cik, i) => {
            const name = (names[i] ?? '').replace(/\s*\(CIK[^)]*\)\s*$/i, '').replace(/\s*\([A-Z]{1,5}\)\s*$/, '').trim();
            if (/^\d{1,10}$/.test(cik) && name) out.push({ cik: cik.padStart(10, '0'), name, states });
        });
    }
    return out;
}

/** A filer's submissions JSON (raw; parse with parseEdgarSubmissions). */
export async function getEdgarSubmissions(cik: string): Promise<Outcome<unknown>> {
    if (!isSecConfigured()) return { status: 'error', reason: 'not_configured' };
    return getJson(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, secHeaders());
}

/** A Form D's XML, for the amount. */
export async function getFormDXml(cik: string, accession: string, primaryDocument: string | null): Promise<Outcome<string>> {
    if (!isSecConfigured()) return { status: 'error', reason: 'not_configured' };
    const doc = primaryDocument && primaryDocument.endsWith('.xml') ? primaryDocument.split('/').pop() : 'primary_doc.xml';
    return getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${doc}`, secHeaders());
}

// ── The lead's own site ──────────────────────────────────────────────────────────────────────────

/** Fetch one page of the lead's own site through the SSRF-guarded fetcher. Null on any failure. */
async function readPage(domain: string, path: string): Promise<{ url: string; html: string } | null> {
    const url = `https://${domain}${path}`;
    try {
        const { body } = await safeFetchText(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES, userAgent: USER_AGENTS.leadWatch });
        return { url, html: body };
    } catch {
        return null;
    }
}

const NAME_RE = /^([A-Z][a-z'’]+(?:[- ][A-Z][a-z'’]+){1,2})$/;
const NOT_A_NAME = /\b(our|the|team|about|meet|contact|services|limited|ltd|company|home|privacy|policy|careers|jobs)\b/i;

/**
 * Senior people named on a team page, read WITHOUT a model: a person is a "Firstname Lastname" with a
 * decision-maker title (isDecisionMakerTitle) either on the same line ("Jane Smith, Managing
 * Director", "Jane Smith – Founder") or in the element right after their name (a card: <h3>Jane
 * Smith</h3><p>Managing Director</p>). Anything less clear is skipped: a missed name costs a signal,
 * a wrong one puts a stranger in front of a seller. Exported for the tests.
 */
export function extractTeamPeople(html: string): TeamPerson[] {
    const $ = cheerio.load(String(html || ''));
    $('script, style, noscript, svg, head, nav, footer').remove();
    const out = new Map<string, TeamPerson>();
    const add = (name: string, title: string) => {
        const n = name.trim().replace(/\s+/g, ' ');
        const t = title.trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!NAME_RE.test(n) || NOT_A_NAME.test(n) || !isDecisionMakerTitle(t) || t.length < 3) return;
        if (!out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, title: t });
    };
    $('h1, h2, h3, h4, h5, h6, p, li, strong, b, span, div').each((_, el) => {
        // Only leaf-ish elements: a container's text is every card at once.
        if ($(el).children('h1,h2,h3,h4,h5,h6,p,li,div').length) return;
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!text || text.length > 120) return;
        const same = /^(.+?)\s*(?:,|–|—|-|\|)\s*(.+)$/.exec(text);
        if (same && NAME_RE.test(same[1].trim())) { add(same[1], same[2]); return; }
        if (NAME_RE.test(text)) {
            const next = $(el).next().text().replace(/\s+/g, ' ').trim();
            if (next && next.length <= 80) add(text, next);
        }
    });
    return [...out.values()].slice(0, 30);
}

const ROLE_WORDS = /\b(manager|assistant|engineer|technician|chef|cook|sales|driver|apprentice|nurse|developer|designer|cleaner|administrator|admin|officer|executive|coordinator|co-ordinator|specialist|receptionist|supervisor|operative|consultant|accountant|adviser|advisor|analyst|stylist|therapist|teacher|tutor|director|lead|head of|representative|associate|carer|electrician|plumber|joiner|labourer|barista|waiter|waitress|bartender|mechanic|surveyor|marketing|recruiter|intern|trainee)\b/i;

/** Job titles on a careers page, read without a model. Exported for the tests. */
export function extractJobTitles(html: string): string[] {
    const $ = cheerio.load(String(html || ''));
    $('script, style, noscript, svg, head, nav, footer').remove();
    const seen = new Map<string, string>();
    $('h2, h3, h4, h5, li, a, strong').each((_, el) => {
        if ($(el).children('h2,h3,h4,li,div,p').length) return;
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (t.length < 4 || t.length > 80 || !ROLE_WORDS.test(t)) return;
        if (/\b(apply|view|see all|read more|click|cookie|privacy|jobs at|careers at|join our team)\b/i.test(t)) return;
        if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    });
    return [...seen.values()].slice(0, 30);
}

/** A hosted job board linked from a page. Exported for the tests. */
export function detectJobBoard(html: string): { kind: 'greenhouse' | 'lever' | 'ashby' | 'workable'; id: string } | null {
    const h = String(html || '');
    const g = /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]{2,60})/i.exec(h);
    if (g) return { kind: 'greenhouse', id: g[1] };
    const l = /jobs\.lever\.co\/([a-z0-9_.-]{2,60})/i.exec(h);
    if (l) return { kind: 'lever', id: l[1] };
    const a = /jobs\.ashbyhq\.com\/([a-z0-9_.%-]{2,60})/i.exec(h);
    if (a) return { kind: 'ashby', id: decodeURIComponent(a[1]) };
    const w = /apply\.workable\.com\/([a-z0-9_-]{2,60})/i.exec(h);
    if (w && !['api', 'j'].includes(w[1].toLowerCase())) return { kind: 'workable', id: w[1] };
    return null;
}

/** Each board's public JSON → jobs. Exported for the tests. */
export function parseJobBoard(kind: 'greenhouse' | 'lever' | 'ashby' | 'workable', raw: unknown): CareersJob[] {
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const date = (v: unknown) => {
        if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
        const t = s(v);
        return t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString().slice(0, 10) : null;
    };
    const rows: unknown[] = kind === 'lever'
        ? (Array.isArray(raw) ? raw : [])
        : (Array.isArray((raw as { jobs?: unknown } | null)?.jobs) ? (raw as { jobs: unknown[] }).jobs : []);
    return rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => {
            if (kind === 'greenhouse') return { title: s(r.title), url: s(r.absolute_url), date: date(r.first_published ?? r.updated_at) };
            if (kind === 'lever') return { title: s(r.text), url: s(r.hostedUrl), date: date(r.createdAt) };
            if (kind === 'ashby') return { title: s(r.title), url: s(r.jobUrl), date: date(r.publishedAt) };
            return { title: s(r.title), url: s(r.url) ?? s(r.shortlink), date: date(r.published_on ?? r.created_at) };
        })
        .filter((j): j is CareersJob => !!j.title)
        .slice(0, 50);
}

async function fetchJobBoard(board: { kind: 'greenhouse' | 'lever' | 'ashby' | 'workable'; id: string }): Promise<Outcome<CareersJob[]>> {
    const id = encodeURIComponent(board.id);
    const url = board.kind === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${id}/jobs`
        : board.kind === 'lever' ? `https://api.lever.co/v0/postings/${id}?mode=json`
        : board.kind === 'ashby' ? `https://api.ashbyhq.com/posting-api/job-board/${id}`
        : `https://apply.workable.com/api/v1/widget/accounts/${id}`;
    const r = await getJson(url);
    if (r.status === 'error') return r;
    return { status: 'ok', value: parseJobBoard(board.kind, r.value) };
}

/** A short stable fingerprint of a list (order-insensitive). */
export function listHash(items: string[]): string {
    const s = [...new Set(items.map((i) => i.toLowerCase().trim()))].sort().join('\n');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `${items.length}:${(h >>> 0).toString(36)}`;
}

export interface SiteLook {
    /** Did we reach the site at all? False = keep the previous snapshot, record nothing. */
    reached: boolean;
    teamUrl: string | null;
    team: TeamPerson[] | null;
    /** NO_CAREERS when we looked and there is none; null when we could not tell. */
    careersHash: string | null;
    careersSource: string | null;
    careersUrl: string | null;
    jobs: CareersJob[];
    /** US states printed on the home page, for the EDGAR match. */
    usStates: string[];
    homeText: string;
}

/**
 * One look at the lead's own site: home page, up to two team pages, the careers page and, if it links
 * one, the job board. At most ~5 fetches. Never throws.
 */
export async function lookAtSite(domain: string, noCareers: string, usStatesInText: (t: string) => string[]): Promise<SiteLook> {
    const look: SiteLook = { reached: false, teamUrl: null, team: null, careersHash: null, careersSource: null, careersUrl: null, jobs: [], usStates: [], homeText: '' };
    const home = await readPage(domain, '/');
    if (!home) return look;
    look.reached = true;
    const $ = cheerio.load(home.html);
    $('script, style, noscript').remove();
    look.homeText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);
    look.usStates = usStatesInText(look.homeText);

    // Team: the home page's own about/team links first, then the usual paths. Two pages at most.
    const teamPaths = [...new Set([...discoverSitePaths(home.html, domain, 'about').slice(0, 3), ...PEOPLE_PATHS])];
    const people = new Map<string, TeamPerson>();
    let pagesRead = 0;
    for (const path of teamPaths) {
        if (pagesRead >= 2) break;
        const page = await readPage(domain, path);
        if (!page || page.html.length < 500) continue;
        pagesRead++;
        const found = extractTeamPeople(page.html);
        if (found.length && !look.teamUrl) look.teamUrl = page.url;
        for (const p of found) people.set(p.name.toLowerCase(), p);
    }
    // No team page read at all → we cannot tell (null keeps the old snapshot). Read but nobody senior
    // named → an empty list, which is a real answer.
    look.team = pagesRead ? [...people.values()] : null;

    // Careers: a job board linked from the home page wins; else a careers path linked from home; else
    // the usual paths.
    let board = detectJobBoard(home.html);
    const linked = CAREERS_PATHS.find((p) => new RegExp(`href=["'][^"']*${p}\\b`, 'i').test(home.html));
    let careersPage: { url: string; html: string } | null = null;
    for (const path of [...new Set([...(linked ? [linked] : []), ...CAREERS_PATHS])]) {
        careersPage = await readPage(domain, path);
        if (careersPage && careersPage.html.length >= 500) break;
        careersPage = null;
    }
    if (!board && careersPage) board = detectJobBoard(careersPage.html);
    if (board) {
        const jobs = await fetchJobBoard(board);
        if (jobs.status === 'ok') {
            look.careersSource = board.kind;
            look.careersUrl = careersPage?.url ?? null;
            look.jobs = jobs.value;
            look.careersHash = jobs.value.length ? listHash(jobs.value.map((j) => j.title)) : listHash([]);
            return look;
        }
    }
    if (careersPage) {
        const titles = extractJobTitles(careersPage.html);
        look.careersSource = 'page';
        look.careersUrl = careersPage.url;
        look.jobs = titles.map((t) => ({ title: t, url: careersPage!.url, date: null }));
        look.careersHash = listHash(titles);
    } else {
        // We reached the site and none of the careers paths exists: a real "no careers page".
        look.careersHash = noCareers;
    }
    return look;
}
