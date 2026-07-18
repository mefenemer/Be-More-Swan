// src/lib/discovery-enrich.ts
// Contact enrichment for discovered leads — TIER 1: site scrape only, no vendor, no spend.
//
// Discovery finds companies from SERP results, but a discovered lead has no email, so
// lead-generation.ts `send_outreach` returns { sent:false, reason:'no_recipient' } for
// essentially every one of them. This closes that gap by reading the address the company
// already publishes on its own website.
//
// HARD RULE — EXTRACTION ONLY, NEVER GENERATIVE.
// No LLM is involved and no address is ever inferred (no "firstname@domain" guessing).
// An email here is sent to a real stranger, so a fabricated one is worse than none at all.
// Every address returned was literally present on the company's own page. Do NOT wire
// crm_enricher in here — its route deliberately emits mock data (chat-orchestrator.ts).
//
// All fetches go through safeFetchText (SSRF-guarded, re-validates every redirect hop):
// these domains come from search results, i.e. attacker-influenceable input.

import * as cheerio from 'cheerio';
import { safeFetchText } from '../utils/safe-fetch';

/** Where a contact address came from, and how much trust it earns. */
export type EmailKind = 'role' | 'personal';

export interface EnrichmentResult {
    email: string;
    kind: EmailKind;
    source: 'scrape';
    /** The page it was actually found on — provenance for the Review Queue. */
    foundOn: string;
}

// Paths tried in order, stopping at the first usable address. Homepage first because it
// carries a footer address on most SMB sites and costs one fetch.
const CANDIDATE_PATHS = ['', '/contact', '/contact-us', '/about'];

// Generic inbox prefixes. These are corporate role addresses, not identified individuals —
// the defensible lane for B2B outreach under UK GDPR legitimate interests / PECR.
const ROLE_PREFIXES = new Set([
    'info', 'hello', 'hi', 'contact', 'contactus', 'enquiries', 'enquiry', 'inquiries',
    'sales', 'admin', 'office', 'team', 'mail', 'general', 'reception', 'bookings',
    'support', 'help', 'ask', 'talk', 'connect', 'business',
]);

// Never contact these, and never let them shadow a real address.
const BLOCKED_PREFIXES = [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications', 'mailer-daemon',
    'postmaster', 'abuse', 'unsubscribe', 'privacy', 'dpo', 'legal', 'webmaster',
    'example', 'test', 'your', 'name', 'email', 'user', 'someone', 'firstname',
];

// Domains that appear in scraped markup but belong to tooling/agencies, never the lead.
const BLOCKED_DOMAIN_FRAGMENTS = [
    'sentry.io', 'wixpress.com', 'godaddy.com', 'squarespace.com', 'shopify.com',
    'wordpress.com', 'wordpress.org', 'w3.org', 'schema.org', 'googleapis.com',
    'gstatic.com', 'cloudflare.com', 'jquery.com', 'bootstrapcdn.com', 'example.com',
    'sentry-cdn.com', 'litespeedtech.com', 'domain.com',
];

// Asset extensions that turn up when a filename is mis-parsed as an address
// (e.g. "logo@2x.png" — a real hazard on retina-image sites).
const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|mp4|pdf)$/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Per-lead wall clock. The worker tick is ~10s total (see QUERIES_PER_SLICE in
// process-discovery-jobs.ts — 3 searches/tick already caused 504s), so a lead that
// stalls must give up fast rather than take the whole batch down with it.
const FETCH_TIMEOUT_MS = 2500;
// Total budget for ONE lead across all its candidate paths. The per-fetch timeout alone
// is not enough: 4 slow-but-not-timing-out paths compound (a live smoke test hit 11.4s on
// one domain), which would blow the whole tick. Measured cost of a hit is ~1-2.5s.
const LEAD_BUDGET_MS = 6000;
const MAX_BYTES = 400_000;

/**
 * Extract every plausible contact address from a page, best first.
 * Reads `mailto:` hrefs (highest signal — an explicit contact link) before falling back
 * to addresses written in body text.
 */
export function extractEmails(html: string, leadDomain: string | null): Array<{ email: string; kind: EmailKind }> {
    const $ = cheerio.load(html);
    const found: string[] = [];

    // mailto: links first — an explicit "contact us" affordance beats a text match.
    $('a[href^="mailto:"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const addr = href.slice('mailto:'.length).split('?')[0].trim();
        if (addr) found.push(addr);
    });

    $('script, style, noscript, svg').remove();
    const text = $('body').text();
    for (const m of text.matchAll(EMAIL_RE)) found.push(m[0]);

    const seen = new Set<string>();
    const out: Array<{ email: string; kind: EmailKind }> = [];
    for (const raw of found) {
        const email = raw.toLowerCase().trim().replace(/^mailto:/, '').replace(/[.,;:)]+$/, '');
        if (seen.has(email)) continue;
        seen.add(email);
        const kind = classify(email, leadDomain);
        if (kind) out.push({ email, kind });
    }

    // Role addresses outrank personal ones: they're both more durable and the safer
    // target for cold outreach. Otherwise preserve discovery order (mailto: before text).
    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'role' ? -1 : 1));
}

/**
 * Decide whether an address is contactable, and which kind it is.
 * Returns null to reject. The lead-domain check is the important one: a scraped page is
 * full of third-party addresses (the web designer, a CDN, a partner), and emailing those
 * would be both useless and a complaint risk.
 */
function classify(email: string, leadDomain: string | null): EmailKind | null {
    if (email.length > 200 || (email.match(/@/g) || []).length !== 1) return null;
    if (ASSET_EXTENSIONS.test(email)) return null;

    const [prefix, domain] = email.split('@');
    if (!prefix || !domain || !domain.includes('.')) return null;
    if (BLOCKED_PREFIXES.some((p) => prefix === p || prefix.startsWith(`${p}.`) || prefix.startsWith(`${p}-`))) return null;
    if (BLOCKED_DOMAIN_FRAGMENTS.some((d) => domain === d || domain.endsWith(`.${d}`))) return null;

    // Must belong to the lead's own domain (or a subdomain of it). Without this the
    // scraper happily returns the site builder's support address on every lead.
    if (leadDomain) {
        const normalised = leadDomain.toLowerCase().replace(/^www\./, '');
        if (domain !== normalised && !domain.endsWith(`.${normalised}`)) return null;
    }

    const bare = prefix.replace(/[._-]/g, '');
    return ROLE_PREFIXES.has(prefix) || ROLE_PREFIXES.has(bare) ? 'role' : 'personal';
}

/**
 * Find a contact address for one lead by reading its own website.
 * Best-effort by design: returns null on anything unexpected (dead domain, JS-only site,
 * no published address, SSRF rejection). A lead with no email is a normal outcome, not a
 * failure — it just stays un-emailable, exactly as it is today.
 */
export async function enrichLeadContact(domain: string | null): Promise<EnrichmentResult | null> {
    if (!domain) return null;
    const host = domain.toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
    if (!host || !host.includes('.')) return null;

    let best: { email: string; kind: EmailKind; foundOn: string } | null = null;
    const deadline = Date.now() + LEAD_BUDGET_MS;

    for (const path of CANDIDATE_PATHS) {
        // Give up on a slow site rather than starve the rest of the batch. Anything
        // already found (a personal address) is still returned below.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        const url = `https://${host}${path}`;
        let body: string;
        try {
            ({ body } = await safeFetchText(url, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining), maxBytes: MAX_BYTES }));
        } catch {
            // Dead path, blocked host, timeout — try the next candidate.
            continue;
        }

        const hits = extractEmails(body, host);
        if (hits.length === 0) continue;

        // A role address is the best outcome available — take it and stop paying for fetches.
        if (hits[0].kind === 'role') return { email: hits[0].email, kind: 'role', source: 'scrape', foundOn: url };

        // Hold the personal address but keep looking: /contact may yet yield a role inbox.
        if (!best) best = { email: hits[0].email, kind: hits[0].kind, foundOn: url };
    }

    return best ? { ...best, source: 'scrape' } : null;
}
