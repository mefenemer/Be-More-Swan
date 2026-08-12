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
    // Hospitality/venue desks — a live staging run classified reservations@ as 'personal'
    // and warned on it. Misclassifying role→personal only over-warns (the safe direction),
    // but it puts needless friction on the reviewer, so keep this list current.
    'reservations', 'reservation', 'booking', 'events', 'event', 'enquires', 'frontdesk',
    'stay', 'guestservices', 'concierge', 'hire', 'orders', 'shop', 'studio', 'welcome',
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
 *
 * ── The fusion bug this guards against (prod, indielee.com, 2026-08-12) ──────
 * cheerio's `.text()` concatenates adjacent text nodes with NOTHING between them, so
 * `<span>Support</span><a>hello@indielee.com</a>` reads as "Supporthello@indielee.com" —
 * and EMAIL_RE happily matches the whole thing, because the label ran straight into the
 * local part. `supporthello@indielee.com` then passed every check in classify(): the
 * domain is genuinely the lead's, and the prefix is on no blocklist.
 *
 * It cost more than one bad address. `supporthello` is not in ROLE_PREFIXES, so it was
 * graded 'personal' — and by swallowing the real `hello@indielee.com` it left the page
 * with no role address to find, so the correct, higher-quality inbox was never returned.
 * The lead reached the Review Queue with an undeliverable recipient and an Approve button.
 *
 * Two defences below: a boundary between text nodes so the fusion cannot form, and a
 * suffix check so a fused address can never outlive the real one it swallowed.
 */
export function extractEmails(html: string, leadDomain: string | null): Array<{ email: string; kind: EmailKind }> {
    const $ = cheerio.load(html);
    const found: Array<{ addr: string; from: 'mailto' | 'text' }> = [];

    // mailto: links first — an explicit "contact us" affordance beats a text match.
    $('a[href^="mailto:"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const addr = href.slice('mailto:'.length).split('?')[0].trim();
        if (addr) found.push({ addr, from: 'mailto' });
    });

    $('script, style, noscript, svg').remove();

    // ⚠️ Insert an explicit boundary after every element BEFORE reading text, or adjacent
    // nodes fuse (see above). Done through the DOM rather than by stripping tags out of the
    // raw HTML with a regex, because `.text()` also decodes entities — and an address
    // written `&#104;ello@acme.com` must still be found.
    //
    // The trade-off is deliberate: an address split ACROSS elements (`hello@<b>acme.com</b>`)
    // now fails to match instead of fusing. That direction is the safe one. This module's
    // hard rule is extraction, never inference — a missed address leaves a lead visibly
    // un-emailable, while a fabricated one gets sent to a real stranger.
    $('body').find('*').each((_, el) => { $(el).after('\n'); });

    const text = $('body').text();
    for (const m of text.matchAll(EMAIL_RE)) found.push({ addr: m[0], from: 'text' });

    const seen = new Set<string>();
    const candidates: Array<{ email: string; kind: EmailKind; from: 'mailto' | 'text' }> = [];
    for (const { addr, from } of found) {
        const email = addr.toLowerCase().trim().replace(/^mailto:/, '').replace(/[.,;:)]+$/, '');
        if (seen.has(email)) continue;   // mailto pushed first, so it wins the dedupe
        seen.add(email);
        const kind = classify(email, leadDomain);
        if (kind) candidates.push({ email, kind, from });
    }

    // Second defence. Fusion can only ever PREPEND junk to a real address, so a text match
    // that ends with an address the page also published as a mailto: link is that same
    // address with a label stuck to its front. Scoped to text-vs-mailto on purpose: dropping
    // any suffix match would discard `presales@acme.com` merely because `sales@acme.com`
    // exists, and two mailto links are two deliberate addresses, not an accident.
    const explicit = candidates.filter((c) => c.from === 'mailto').map((c) => c.email);
    const out = candidates
        .filter((c) => !(c.from === 'text' && explicit.some((m) => m !== c.email && c.email.endsWith(m))))
        .map(({ email, kind }) => ({ email, kind }));

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
