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
// timeout — is reported, not raised, and the caller keeps whatever the free scrape produced. A
// paid lookup is an enhancement to a pipeline that already works without it; it must never be
// able to fail a discovery run.
//
// ⚠️ IT RETURNS AN OUTCOME, NOT AN ADDRESS-OR-NULL, and that distinction is the whole point of
// this module's shape. `null` used to mean BOTH "the provider answered and this company publishes
// nothing" and "the provider never answered us". Those are opposite facts — one is about the
// lead, the other is about our account — and collapsing them cost a real customer their pipeline:
//
//   Prod, 2026-08-27. The Hunter account was on the Free plan (50 searches/month) and ran dry at
//   ~14:00 UTC. The next 172 lookups all returned null. The worker read that as "no address
//   published", stamped every one of those leads `paidLookupAt` + `enrichAttemptedAt` — which
//   permanently suppresses a retry — and charged £1.46 of phantom spend for calls that were
//   rejected and cost nothing. The tenant then spent a day and a half MANUALLY DELETING 104
//   schools, because the product told them those schools had no contact address. Hunter had
//   addresses for them; we simply had no credits left to ask.
//
// The header below already predicted this ("a silent zero hit rate reads identically to 'these
// companies publish nothing'") and pointed at a console.warn as the only discriminator. That was
// not enough: the warning went to a log nobody can read (`netlify logs:function` is dead), while
// the DATA said the companies were unreachable. The discriminator has to be in the return value.
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

/**
 * What a lookup ACTUALLY established. Three outcomes, because there are three facts:
 *
 *   • `hit`   — the provider answered and we have an address.
 *   • `miss`  — the provider answered and this domain publishes nothing we can use. A fact about
 *               the LEAD. Money was spent; the lead is settled and should not be retried.
 *   • `error` — the provider did not answer: no credits, rate limited, timed out, or its response
 *               did not parse. A fact about US. ⚠️ Nothing was learned about the lead, so the
 *               caller must not spend a cap slot on it, must not charge the run budget, and must
 *               NOT record it as "we looked and found nothing".
 */
export type ProviderOutcome =
    | { status: 'hit'; contact: ProviderContact }
    | { status: 'miss' }
    | { status: 'error'; reason: string };

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
async function lookupHunter(domain: string, timeoutMs: number): Promise<ProviderOutcome> {
    const url = `${HUNTER_ENDPOINT}?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(HUNTER_API_KEY as string)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            // ⚠️ EVERY non-2xx is an `error`, never a miss. 401 (bad key) and 429 (out of credits
            // / rate limited) are the two that actually happen, and both mean the account is the
            // problem — the domain was never even looked at. Treating these as "publishes
            // nothing" is the exact bug described in the header.
            console.warn(`[enrich-provider] hunter HTTP ${res.status} for ${domain} — NOT a miss, the lookup did not happen`);
            return { status: 'error', reason: `http_${res.status}` };
        }
        const body = await res.json().catch(() => null) as { data?: { emails?: unknown } } | null;
        const raw = body?.data?.emails;
        // A 200 whose body does not carry the array we map is a CONTRACT CHANGE, not an empty
        // result — the one failure the module header calls out as indistinguishable by eye. It
        // must not settle the lead either.
        if (!Array.isArray(raw)) {
            console.warn(`[enrich-provider] hunter 200 but data.emails was not an array for ${domain} — response shape changed?`);
            return { status: 'error', reason: 'bad_body' };
        }

        const candidates = raw
            .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
            .map((e) => ({
                email: typeof e.value === 'string' ? e.value.trim() : '',
                confidence: confidenceOf(e.confidence),
            }))
            .filter((e) => e.email.includes('@'));

        // Answered, parsed, and genuinely nothing usable on this domain. THIS is a miss: a fact
        // about the company, worth recording and worth a cap slot, because we paid to learn it.
        const best = pickBest(candidates);
        if (!best) return { status: 'miss' };
        return {
            status: 'hit',
            contact: { email: best.email, kind: best.kind, confidence: best.confidence, provider: 'hunter' },
        };
    } catch (err) {
        // Aborted by our own timeout, DNS, TLS, socket — we never got an answer.
        const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network';
        console.warn(`[enrich-provider] hunter lookup ${reason} for ${domain}:`,
            err instanceof Error ? err.message : err);
        return { status: 'error', reason };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Buy a contact address for one domain.
 *
 * ⚠️ Every early return here is an `error`, not a `miss` — none of them asked the provider
 * anything, so none of them learned that the company publishes no address. `not_configured` is
 * the normal, un-alarming case (the caller checks isEnrichProviderConfigured() first and skips
 * the whole phase), but it is still not a fact about the lead, and a caller that settled a lead
 * on it would mark the entire backlog unreachable the moment the provider was switched off.
 */
export async function lookupProviderContact(
    domain: string | null,
    opts: { timeoutMs?: number } = {},
): Promise<ProviderOutcome> {
    if (!isEnrichProviderConfigured()) return { status: 'error', reason: 'not_configured' };
    if (!domain) return { status: 'error', reason: 'no_domain' };
    const host = domain.toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
    if (!host || !host.includes('.')) return { status: 'error', reason: 'no_domain' };
    // A caller draining a shared slice budget passes what is left of it; a lookup that cannot
    // finish inside the tick is worth abandoning rather than risking a 504 that strands the job.
    // Abandoning it is emphatically NOT a miss — we ran out of OUR time, not their addresses.
    const timeoutMs = Math.min(opts.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS);
    if (timeoutMs <= 0) return { status: 'error', reason: 'no_budget' };
    if (PROVIDER === 'hunter') return lookupHunter(host, timeoutMs);
    return { status: 'error', reason: 'not_configured' };
}
