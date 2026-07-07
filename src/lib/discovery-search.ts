// src/lib/discovery-search.ts
// The one external dependency the outbound discovery layer needs: a web search
// provider + a fetch-and-extract step. Mirrors the env-config philosophy of
// ai-gateway.ts / fal-gateway.ts — swapping the provider is an env-var change,
// never a code change. Design: docs/lead-generator-discovery-plan.md (§3.1).
//
// The worker (process-discovery-jobs.ts) calls this one typed interface so the
// provider stays swappable and the queue never hard-depends on a vendor SDK.
//
// Config:
//   DISCOVERY_SEARCH_PROVIDER   — 'serper' (default) | 'none'
//   SERPER_API_KEY              — Serper.dev key (https://serper.dev); provider is
//                                 disabled without it (isSearchConfigured() === false)
//   DISCOVERY_SEARCH_COST_GBP   — cost charged to the run budget per search call
//                                 (default 0.001 — Serper's ~$0.001/query)
//   DISCOVERY_FETCH_TIMEOUT_MS  — per-page fetch timeout for footprint checks (default 8000)

import * as cheerio from 'cheerio';

const PROVIDER = (process.env.DISCOVERY_SEARCH_PROVIDER ?? 'serper').toLowerCase();
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const COST_GBP_PER_CALL = Number(process.env.DISCOVERY_SEARCH_COST_GBP ?? '0.001');
const FETCH_TIMEOUT_MS = Number(process.env.DISCOVERY_FETCH_TIMEOUT_MS ?? '8000');

const SERPER_ENDPOINT = 'https://google.serper.dev/search';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    domain: string | null;   // normalised: lowercased, no leading www., no path
}

export interface SearchResponse {
    results: SearchResult[];
    costGbp: number;          // charge this to the run budget
}

/** Thrown when no search provider is configured — the worker turns this into a clear
 *  "connect a search provider" job failure instead of a stack trace. */
export class SearchNotConfiguredError extends Error {
    constructor(message = 'No web search provider configured. Set SERPER_API_KEY.') {
        super(message);
        this.name = 'SearchNotConfiguredError';
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** True when a real provider is wired. UI / worker gate on this before enqueuing. */
export function isSearchConfigured(): boolean {
    if (PROVIDER === 'none') return false;
    if (PROVIDER === 'serper') return Boolean(SERPER_API_KEY);
    return false;
}

/** Normalise a URL (or bare host) to a dedupe-friendly domain, or null if unparseable. */
export function normaliseDomain(input: string | null | undefined): string | null {
    if (!input) return null;
    let host: string;
    try {
        host = new URL(input.includes('://') ? input : `https://${input}`).hostname;
    } catch {
        return null;
    }
    return host.toLowerCase().replace(/^www\./, '') || null;
}

/**
 * Run one search query against the configured provider.
 * @param query the literal query string (an entry from an LLM-generated query array)
 * @param opts.limit max results to return (default 10)
 * @throws SearchNotConfiguredError when no provider is wired
 */
export async function search(query: string, opts: { limit?: number } = {}): Promise<SearchResponse> {
    if (!isSearchConfigured()) throw new SearchNotConfiguredError();
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 20));

    if (PROVIDER === 'serper') return searchSerper(query, limit);
    throw new SearchNotConfiguredError(`Unknown DISCOVERY_SEARCH_PROVIDER "${PROVIDER}".`);
}

/**
 * Fetch a page's visible text for footprint checks (e.g. detecting the ABSENCE of a
 * booking widget). Best-effort: returns '' on any error/timeout so a single bad page
 * never fails the run. Uses cheerio (already a dependency).
 */
export async function fetchPageText(url: string): Promise<string> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'BeMoreSwan-LeadDiscovery/1.0 (+https://bemoreswan.com)' },
        }).finally(() => clearTimeout(timer));
        if (!res.ok) return '';
        const html = await res.text();
        const $ = cheerio.load(html);
        $('script, style, noscript, svg').remove();
        return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);
    } catch {
        return '';
    }
}

// ── Serper.dev provider ──────────────────────────────────────────────────────

async function searchSerper(query: string, limit: number): Promise<SearchResponse> {
    const res = await fetch(SERPER_ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY as string, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: limit }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Serper search failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { organic?: Array<Record<string, unknown>> };
    const organic = Array.isArray(data.organic) ? data.organic : [];
    const results: SearchResult[] = organic.slice(0, limit).map((r) => {
        const url = typeof r.link === 'string' ? r.link : '';
        return {
            title: typeof r.title === 'string' ? r.title : '',
            url,
            snippet: typeof r.snippet === 'string' ? r.snippet : '',
            domain: normaliseDomain(url),
        };
    });
    return { results, costGbp: COST_GBP_PER_CALL };
}
