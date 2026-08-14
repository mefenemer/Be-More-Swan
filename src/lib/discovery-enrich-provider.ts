// src/lib/discovery-enrich-provider.ts
// Tier 2 of contact enrichment: BUY an address when reading the company's own site found nothing.
//
// Mirrors the env-config philosophy of discovery-search.ts — swapping the vendor is an env-var
// change, never a code change — with one deliberate difference that matters more than the
// similarity:
//
// ⚠️ THIS DEFAULTS TO OFF. discovery-search.ts defaults DISCOVERY_SEARCH_PROVIDER to 'serper'
// because search is already provisioned and a run without it is useless. This module spends money
// per lookup on a third party's data about a named human. A default that silently began billing
// the moment a key appeared in the environment would be the wrong shape of mistake, so the
// provider must be named explicitly before a single request is made.
//
// ── Why buy at all ───────────────────────────────────────────────────────────
// Measured on a real prod run (2026-08-12): 64 leads in the Leads tab, 4 with a contact address.
// The free scraper attempts hot/warm leads only and hits roughly one in three of those — so the
// Review Queue, which can only hold leads that HAVE an address, was near-empty by construction.
// Every tool in the market solves this by buying the data; hand-rolling a better scraper is the
// one thing that demonstrably does not work.
//
// ── Contract ─────────────────────────────────────────────────────────────────
// NEVER THROWS. Every failure path — unconfigured, HTTP error, rate limit, malformed body,
// timeout — returns null, and the caller keeps whatever the free scrape produced. A paid lookup
// is an enhancement to a pipeline that already works without it; it must never be able to fail a
// discovery run.
//
// Config:
//   DISCOVERY_ENRICH_PROVIDER   — 'none' (DEFAULT — nothing is bought) | 'hunter'
//   HUNTER_API_KEY              — required when the provider is 'hunter'
//   DISCOVERY_ENRICH_COST_GBP   — charged to the run budget per lookup (default 0.008)
//   DISCOVERY_ENRICH_TIMEOUT_MS — per-lookup timeout (default 5000)

import { roleOrPersonal, type EmailKind } from '../config/lead-email-kind';

const PROVIDER = (process.env.DISCOVERY_ENRICH_PROVIDER ?? 'none').toLowerCase();
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
export const ENRICH_COST_GBP_PER_LOOKUP = Number(process.env.DISCOVERY_ENRICH_COST_GBP ?? '0.008');
const TIMEOUT_MS = Number(process.env.DISCOVERY_ENRICH_TIMEOUT_MS ?? '5000');

const HUNTER_ENDPOINT = 'https://api.hunter.io/v2/domain-search';

/** An address bought from a provider, classified by OUR rule rather than the vendor's label. */
export interface ProviderContact {
    email: string;
    kind: EmailKind;
    /** The vendor's own 0-100 confidence, when it supplies one. Recorded, never used as a gate. */
    confidence: number | null;
    /** Which provider supplied it — provenance for the Review Queue and the ledger. */
    provider: string;
}

/** Is a paid provider configured AND named? False is the normal state. */
export function isEnrichProviderConfigured(): boolean {
    if (PROVIDER === 'hunter') return Boolean(HUNTER_API_KEY);
    return false;
}

/** The configured provider's name, or null when nothing is configured. */
export function enrichProviderName(): string | null {
    return isEnrichProviderConfigured() ? PROVIDER : null;
}

/**
 * Prefer a role address over a named individual's.
 *
 * ⚠️ Deliberate, and the opposite of what a vendor's own ranking optimises for. Providers surface
 * the highest-confidence PERSON because that is what a salesperson clicking a UI wants. For cold
 * B2B outreach under UK GDPR/PECR a generic desk address is the defensible lane, and a named
 * individual triggers the personal-inbox confirmation gate — so taking the "best" result would
 * reliably buy us the address we least want to use.
 */
function pickBest(
    candidates: Array<{ email: string; confidence: number | null }>,
): { email: string; confidence: number | null; kind: EmailKind } | null {
    const classified = candidates
        .map((c) => ({ ...c, kind: roleOrPersonal(c.email.split('@')[0] ?? '') }))
        .filter((c) => c.email.includes('@'));
    if (classified.length === 0) return null;
    const roles = classified.filter((c) => c.kind === 'role');
    const pool = roles.length > 0 ? roles : classified;
    // Highest vendor confidence within the preferred class; unscored entries sort last.
    pool.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
    return pool[0];
}

/** Coerce whatever the vendor returned into 0-100, or null. Never throws on junk. */
function confidenceOf(raw: unknown): number | null {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Hunter.io Domain Search.
 *
 * ✅ RESPONSE MAPPING VERIFIED AGAINST THE LIVE API, 2026-08-14 (staging, campaign 5 / job 10):
 * the shape below (`data.emails[]` with `value` / `confidence`) parses real responses correctly —
 * 8 lookups bought 6 usable addresses. The parsing stays deliberately defensive — every field is
 * checked and anything unexpected yields null rather than a throw — so a future contract change
 * degrades to "found nothing" instead of breaking a run. That remains the failure mode to watch:
 * a silent zero hit rate reads identically to "these companies publish nothing", and the
 * console.warn below is the only thing that tells them apart.
 */
async function lookupHunter(domain: string, timeoutMs: number): Promise<ProviderContact | null> {
    const url = `${HUNTER_ENDPOINT}?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(HUNTER_API_KEY as string)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            // 429/401 are operational facts worth seeing in the logs — a silent zero hit rate
            // reads identically to "these companies publish nothing", which is the wrong lesson.
            console.warn(`[enrich-provider] hunter ${res.status} for ${domain}`);
            return null;
        }
        const body = await res.json().catch(() => null) as { data?: { emails?: unknown } } | null;
        const raw = body?.data?.emails;
        if (!Array.isArray(raw)) return null;

        const candidates = raw
            .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
            .map((e) => ({
                email: typeof e.value === 'string' ? e.value.trim() : '',
                confidence: confidenceOf(e.confidence),
            }))
            .filter((e) => e.email.includes('@'));

        const best = pickBest(candidates);
        if (!best) return null;
        return { email: best.email, kind: best.kind, confidence: best.confidence, provider: 'hunter' };
    } catch (err) {
        console.warn(`[enrich-provider] hunter lookup failed for ${domain}:`,
            err instanceof Error ? err.message : err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Buy a contact address for one domain, or null.
 *
 * Returns null — never throws — when no provider is configured, which is the default state and
 * not an error. The caller checks isEnrichProviderConfigured() before spending a slot from the
 * per-run cap, so an unconfigured environment costs nothing and behaves exactly as it did before
 * this module existed.
 */
export async function lookupProviderContact(
    domain: string | null,
    opts: { timeoutMs?: number } = {},
): Promise<ProviderContact | null> {
    if (!isEnrichProviderConfigured() || !domain) return null;
    const host = domain.toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
    if (!host || !host.includes('.')) return null;
    // A caller draining a shared slice budget passes what is left of it; a lookup that cannot
    // finish inside the tick is worth abandoning rather than risking a 504 that strands the job.
    const timeoutMs = Math.min(opts.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS);
    if (timeoutMs <= 0) return null;
    if (PROVIDER === 'hunter') return lookupHunter(host, timeoutMs);
    return null;
}
