// src/lib/lead-intel.ts
// Deep enrichment, EVIDENCE-GATHERING HALF: everything we can learn about a lead that might change
// what it is worth, collected without a model being involved at any point.
//
// ── What this is for ─────────────────────────────────────────────────────────
// Tier-1 enrichment (discovery-enrich.ts) answers one question — "is there an address?" — and it
// changes DELIVERABILITY. Nothing in this product could change a lead's TEMPERATURE. A company
// scored 42 on a thin SERP snippet in June stayed 42 forever, even after they raised a round,
// opened a second site and started hiring. That is the gap this closes: gather the facts that
// actually move a buying decision, then let one model call re-read the lead in the light of them
// (discovery-scoring.ts `rescoreWithIntel`).
//
// ── The split, and why it is absolute ────────────────────────────────────────
// THIS FILE NEVER CALLS A MODEL. It gathers: search results with their headlines, the text of the
// company's own team pages, the markers in their HTML. Everything it returns was literally
// published by someone else and can be opened in a browser at the URL beside it.
//
// The interpretation — "this is a funding signal, it makes them warmer, here is the opening line" —
// happens in ONE model call downstream, over evidence it was handed and nothing else. Keeping the
// two apart is what makes the fabrication guard possible: because the source text travels with the
// evidence, the caller can check that a person the model claims to have found actually appears in
// it (see `peopleSources` below), which is impossible once the two halves are mixed.
//
// This mirrors the HARD RULE at the top of discovery-enrich.ts, for the same reason and with more
// at stake: an invented address emails the wrong stranger, an invented CEO puts a fabricated
// person's name and job title in front of a real one.
//
// ── Cost ─────────────────────────────────────────────────────────────────────
// Up to LEAD_INTEL_SEARCHES search calls and ~6 page fetches per lead. At Serper's ~£0.001/query
// that is well under a penny of search per lead, but it is per lead and it is real money, so every
// caller passes a budget and this module stops when it runs out rather than when it runs out of
// ideas. See `gatherLeadIntel`'s `maxSearches`.
//
// Config:
//   LEAD_INTEL_ENABLED       — 'false' disables the whole pass (default on where search is wired)
//   LEAD_INTEL_TIMEOUT_MS    — per-page fetch timeout (default 8000)

import * as cheerio from 'cheerio';
import { safeFetchText } from '../utils/safe-fetch';
import { isSearchConfigured, search, type SearchResult } from './discovery-search';

const TIMEOUT_MS = Number(process.env.LEAD_INTEL_TIMEOUT_MS ?? '8000');
const ENABLED = (process.env.LEAD_INTEL_ENABLED ?? 'true').toLowerCase() !== 'false';

/** Ceiling on search calls for one lead, whatever the caller asks for. */
export const LEAD_INTEL_SEARCHES = 4;

// ── What a signal query is looking for ───────────────────────────────────────
//
// The `kind` is the QUERY's intent, not a claim about what came back — a hiring query can surface
// an article about a funding round. The re-scorer decides what each result actually is; this is
// only a record of what we went looking for, which matters when reading a lead's evidence later
// and asking "did we even check whether they were hiring?".
//
// Four queries, chosen because each maps to a reason a business starts buying: they have new money,
// they are growing headcount, they are opening/launching something, or they are publicly saying
// something we can open a conversation with. A fifth would be a fifth charge per lead for a
// diminishing return.
const SIGNAL_QUERIES: Array<{ kind: SignalKind; terms: string; recency: 'year' | 'month' | undefined }> = [
    { kind: 'funding', terms: '(funding OR raised OR investment OR "series a" OR acquired OR acquisition)', recency: 'year' },
    { kind: 'hiring', terms: '(hiring OR careers OR "join our team" OR vacancy OR recruiting)', recency: 'year' },
    { kind: 'expansion', terms: '(expansion OR "new office" OR opens OR launches OR announces OR award)', recency: 'year' },
    // Not date-restricted, and not about the company generally: this one reads the company's OWN
    // site for something to open a conversation with. A case study from two years ago is still a
    // usable opening line, where a two-year-old funding round is not a buying signal.
    { kind: 'publication', terms: '(news OR blog OR press OR "case study")', recency: undefined },
];

export type SignalKind = 'funding' | 'hiring' | 'expansion' | 'publication';

export interface SignalEvidence {
    /** Which query surfaced this — an intent, not a verdict. See the note above. */
    kind: SignalKind;
    title: string;
    url: string;
    snippet: string;
    /** The provider's own date string, unparsed, or null. Evidence for a human to weigh. */
    date: string | null;
    /** Whose site this is on. `null` when unparseable; equal to the lead's domain for own-site hits. */
    domain: string | null;
}

export interface PeopleSource {
    url: string;
    /** Visible text of the page, collapsed and truncated. THE fabrication guard reads this. */
    text: string;
}

export interface SiteFingerprint {
    /** Platforms/tools detected from markers in the HTML. Extraction only — never inferred. */
    platforms: string[];
    /** Did the site expose a careers/jobs page? A cheap, honest growth proxy. */
    hasCareersPage: boolean;
    /** Pages actually read, so a human can see how much we looked at. */
    pagesRead: string[];
}

export interface LeadIntel {
    gatheredAt: string;
    evidence: SignalEvidence[];
    peopleSources: PeopleSource[];
    fingerprint: SiteFingerprint;
    /** Charged to whatever budget the caller is holding. */
    searchCallsMade: number;
    costGbp: number;
}

/** Nothing found and nothing spent — the shape every failure path returns. */
const EMPTY: LeadIntel = {
    gatheredAt: '',
    evidence: [],
    peopleSources: [],
    fingerprint: { platforms: [], hasCareersPage: false, pagesRead: [] },
    searchCallsMade: 0,
    costGbp: 0,
};

/**
 * Markers that identify a platform from the raw HTML.
 *
 * Deliberately narrow and literal. A loose marker ("shop") would label half the web as Shopify, and
 * a fingerprint that is wrong is worse than absent: it feeds the re-scorer a fact about the company
 * that is not true, and the re-scorer has no way to check it.
 */
const PLATFORM_MARKERS: Array<{ name: string; re: RegExp }> = [
    { name: 'Shopify', re: /cdn\.shopify\.com|Shopify\.theme/i },
    { name: 'WooCommerce', re: /woocommerce/i },
    { name: 'Squarespace', re: /squarespace\.com|static1\.squarespace/i },
    { name: 'Wix', re: /wix\.com|wixstatic\.com/i },
    { name: 'Webflow', re: /webflow\.(com|io)|data-wf-site/i },
    { name: 'WordPress', re: /wp-content\/|wp-includes\//i },
    { name: 'HubSpot', re: /js\.hs-scripts\.com|hsforms\.(net|com)/i },
    { name: 'Klaviyo', re: /klaviyo\.com/i },
    { name: 'Intercom', re: /widget\.intercom\.io/i },
    { name: 'Mailchimp', re: /chimpstatic\.com|list-manage\.com/i },
    { name: 'Calendly', re: /calendly\.com/i },
    { name: 'Stripe', re: /js\.stripe\.com/i },
];

/** Paths worth reading for named people. Ordered by how likely they are to exist on an SMB site. */
const PEOPLE_PATHS = ['/about', '/about-us', '/team', '/our-team', '/people', '/leadership', '/meet-the-team'];

/** Paths that answer "are they hiring?" without spending a search call. */
const CAREERS_PATHS = ['/careers', '/jobs', '/vacancies', '/work-with-us'];

/** How much of a page's text is kept. Enough for a team page; short enough to stay a cheap prompt. */
const MAX_PAGE_TEXT = 6000;

/** Collapse a page to its visible text. */
function visibleText(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript, svg, head').remove();
    return $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TEXT);
}

/** Fetch one path, or null on any failure. Never throws — see the module contract. */
async function readPage(domain: string, path: string): Promise<{ url: string; html: string } | null> {
    const url = `https://${domain}${path}`;
    try {
        const { body } = await safeFetchText(url, { timeoutMs: TIMEOUT_MS, maxBytes: 1024 * 1024 });
        return { url, html: body };
    } catch {
        return null;
    }
}

/**
 * Gather everything we can learn about one lead.
 *
 * ⚠️ NEVER THROWS. The callers are a button press and a nightly sweep; the correct outcome of "the
 * site was down and the search provider rate-limited us" is a lead with no new evidence, not a 500
 * over a lead someone was trying to work. Every stage is independently guarded, so a failure in one
 * still returns whatever the others found.
 *
 * @param opts.maxSearches   hard ceiling for THIS lead; 0 skips the search half entirely and reads
 *                           only the company's own site (which costs nothing but fetches).
 */
export async function gatherLeadIntel(
    domain: string | null,
    companyName: string,
    opts: { maxSearches?: number } = {},
): Promise<LeadIntel> {
    if (!ENABLED || !domain) return { ...EMPTY, gatheredAt: new Date().toISOString() };

    const budget = Math.max(0, Math.min(opts.maxSearches ?? LEAD_INTEL_SEARCHES, LEAD_INTEL_SEARCHES));
    const evidence: SignalEvidence[] = [];
    let searchCallsMade = 0;
    let costGbp = 0;

    // ── Buying signals ──
    // Sequential rather than concurrent, because the budget has to be respected as it is spent: a
    // Promise.all of four queries has already bought all four by the time the first one returns.
    if (budget > 0 && isSearchConfigured()) {
        for (const q of SIGNAL_QUERIES) {
            if (searchCallsMade >= budget) break;
            // The company name is quoted and the domain is included so a common name ("Bramble &
            // Co") does not return four pages about a different business entirely. Unquoted, this
            // is the single biggest source of junk evidence.
            const query = q.kind === 'publication'
                ? `site:${domain} ${q.terms}`
                : `"${companyName}" ${domain} ${q.terms}`;
            try {
                const res = await search(query, { limit: 4, recency: q.recency });
                searchCallsMade++;
                costGbp += res.costGbp;
                for (const r of res.results) evidence.push(toEvidence(q.kind, r));
            } catch {
                // A failed query costs nothing and blocks nothing. Keep going: the other three
                // still have something to say about this company.
                searchCallsMade++;
            }
        }
    }

    // ── The company's own site: people, careers, fingerprint ──
    const peopleSources: PeopleSource[] = [];
    const platforms = new Set<string>();
    const pagesRead: string[] = [];
    let hasCareersPage = false;

    const home = await readPage(domain, '/');
    if (home) {
        pagesRead.push(home.url);
        for (const m of PLATFORM_MARKERS) if (m.re.test(home.html)) platforms.add(m.name);
        // A careers link on the homepage is as good an answer as fetching the page, and free.
        hasCareersPage = CAREERS_PATHS.some((p) => new RegExp(`href=["'][^"']*${p}\\b`, 'i').test(home.html));
    }

    // Two team pages at most. A third rarely says anything the first two did not, and each one is
    // a fetch against a stranger's server that we are making on a timer they never agreed to.
    for (const path of PEOPLE_PATHS) {
        if (peopleSources.length >= 2) break;
        const page = await readPage(domain, path);
        if (!page) continue;
        const text = visibleText(page.html);
        // A near-empty page is a soft 404 or a JS shell. Keeping it would hand the extractor a
        // page with no people on it and invite it to produce some anyway.
        if (text.length < 200) continue;
        pagesRead.push(page.url);
        peopleSources.push({ url: page.url, text });
        for (const m of PLATFORM_MARKERS) if (m.re.test(page.html)) platforms.add(m.name);
    }

    return {
        gatheredAt: new Date().toISOString(),
        evidence: dedupeEvidence(evidence),
        peopleSources,
        fingerprint: { platforms: [...platforms], hasCareersPage, pagesRead },
        searchCallsMade,
        costGbp,
    };
}

function toEvidence(kind: SignalKind, r: SearchResult): SignalEvidence {
    return {
        kind,
        title: r.title.slice(0, 300),
        url: r.url,
        snippet: r.snippet.slice(0, 500),
        date: r.date,
        domain: r.domain,
    };
}

/**
 * One row per URL.
 *
 * The queries overlap by design — an announcement about opening a second site turns up under both
 * "expansion" and "hiring" — and the same headline listed twice reads to both the model and the
 * user as two independent facts, which is exactly the kind of double-counting that talks a cold
 * lead into being warm.
 */
function dedupeEvidence(rows: SignalEvidence[]): SignalEvidence[] {
    const seen = new Set<string>();
    const out: SignalEvidence[] = [];
    for (const r of rows) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
    }
    return out;
}

/**
 * Does this name actually appear in the text it was supposedly extracted from?
 *
 * ⚠️ THE FABRICATION GUARD. The re-scorer is asked to return only people named on the pages it was
 * given; this is what makes that a rule rather than a request. A model that invents a plausible
 * managing director produces a name that is not in the source, and this drops it.
 *
 * Whitespace-insensitive and case-insensitive, because the source text has been collapsed and a
 * name may be split across markup ("Jane\n  Okafor"). Deliberately NOT fuzzy beyond that: the
 * point is to prove the string was there, and a tolerant match is a guard that passes things it
 * should not.
 */
export function nameAppearsInSources(name: string, sources: PeopleSource[]): boolean {
    const needle = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    // Two characters is not a name, and a one-character needle matches everything.
    if (needle.length < 3) return false;
    return sources.some((s) => s.text.toLowerCase().replace(/\s+/g, ' ').includes(needle));
}

/** Is there anything here worth spending a model call on? */
export function hasIntelWorthScoring(intel: LeadIntel): boolean {
    return intel.evidence.length > 0
        || intel.peopleSources.length > 0
        || intel.fingerprint.platforms.length > 0
        || intel.fingerprint.hasCareersPage;
}
