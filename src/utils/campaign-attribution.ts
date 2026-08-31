// src/utils/campaign-attribution.ts
// Campaign Assistant, Phase A — the pure half of the attribution spine.
//
// Token minting, click-parameter extraction, cookie encoding and the binding rule. No database,
// no clock it does not receive, no I/O: everything here is a function of its arguments, so the
// decisions that actually matter are unit-testable without a Postgres.
//
// Tables: db/campaign-attribution.sql. Redirector: netlify/functions/campaign-link-redirect.ts.
//
// ⚠️ NOT src/utils/attribution.ts. That is the "Powered by Be More Swan" export footer and shares
// nothing with this file but four syllables.
//
// ── The problem this file exists to solve honestly ──────────────────────────────────────────────
// Attribution is a measurement with a known, large error bar, and every ad tool in the market
// hides that. Cookies get capped by ITP, stripped by consent tooling, or never set at all in a
// third-party context; click ids get truncated by link shorteners and email clients; people click
// on a phone and convert on a laptop. So there are two independent binding paths here, deliberately:
//
//   1. click_ref — a per-click id appended to the destination as ?bmsc=…, echoed back by a capture
//      form. No cookie involved. Survives ITP entirely. Lost if the destination strips query
//      parameters or the person navigates away and comes back.
//   2. cookie    — our own first-party visitor id, set on the redirect. Survives navigation within
//      the destination. Capped or dropped in third-party contexts.
//
// Neither is reliable alone. Both together still miss journeys. The rule the whole feature rests on
// is therefore: **an unattributed conversion is reported as unattributed, never as organic and
// never silently dropped.** A funnel that quietly reassigns its own blind spot is worse than no
// funnel, because it is confidently wrong in the direction that flatters us.

import { randomBytes } from 'node:crypto';

// ── Public constants ────────────────────────────────────────────────────────────────────────────

/** Query parameter carrying the per-click id to the destination. Short: it rides in ad URLs. */
export const CLICK_REF_PARAM = 'bmsc';

/** First-party cookie holding the visitor id. */
export const VISITOR_COOKIE = 'bms_ca';

/**
 * How long a click can precede a conversion and still be credited.
 *
 * 90 days matches LinkedIn's and Google's own default conversion windows, which is the point:
 * when a tenant compares our funnel against the network's dashboard, a different window would
 * produce a different number and every conversation would be about the discrepancy rather than
 * the campaign. Not a tuning knob — changing it silently re-dates historical attributions.
 */
export const ATTRIBUTION_WINDOW_DAYS = 90;

/** Cookie lifetime. Matches the attribution window; a cookie outliving it can only mislead. */
export const VISITOR_COOKIE_MAX_AGE_SECS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60;

/**
 * The ad networks' own click-id parameters, in the order we prefer them.
 *
 * Order matters when a URL carries more than one (common when a tenant pastes a link that has
 * been through two tools): first match wins, so the list is ordered by how much we trust the
 * parameter to mean "this specific click", not alphabetically.
 */
export const NETWORK_CLICK_PARAMS: readonly string[] = [
    'li_fat_id',  // LinkedIn
    'gclid',      // Google Ads
    'fbclid',     // Meta
    'ttclid',     // TikTok
    'msclkid',    // Microsoft
];

/** UTM parameters we keep. Anything else on the URL is the caller's business, not ours. */
export const UTM_PARAMS: readonly string[] = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
];

// ── Minting ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Mint a public link token.
 *
 * 64 bits of randomness, hex, `c_`-prefixed to match the house convention (`wgt_`, `aud_`).
 * Unguessable is a requirement, not a nicety: the token is the only thing standing between an
 * outsider and another organisation's click counts.
 */
export function mintLinkToken(): string {
    return 'c_' + randomBytes(8).toString('hex');
}

/** Shape check for a link token, so the redirector rejects junk before it touches the database. */
export function isLinkToken(value: unknown): value is string {
    return typeof value === 'string' && /^c_[0-9a-f]{16}$/.test(value);
}

/** Mint the per-click id that rides to the destination as ?bmsc=… */
export function mintClickRef(): string {
    return randomBytes(9).toString('base64url');
}

/** Mint a visitor id for a browser we have not seen before. */
export function mintVisitorId(): string {
    return randomBytes(16).toString('base64url');
}

/** Shape check for a visitor id read back off a cookie — never trust a client-supplied value. */
export function isVisitorId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

// ── Cookie encoding ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Set-Cookie header value for a visitor id.
 *
 * ⚠️ `SameSite=None; Secure` is load-bearing and is not a copy-paste default. The redirect that
 * sets this cookie happens on OUR domain, but the conversion usually happens on the TENANT's
 * site, whose form posts back to us cross-site. Under the browser default (`SameSite=Lax`) that
 * request carries no cookie at all, so cookie binding would work perfectly in local testing —
 * where everything is same-site — and then attribute nothing whatsoever in production. That
 * failure is completely silent: the funnel just reports every conversion as unattributed.
 *
 * `HttpOnly` because only the server ever reads it, and a cookie script can read is a cookie any
 * third-party tag on the tenant's page can read.
 *
 * `secure` is a parameter rather than a constant only so local http development can set a cookie
 * at all; production callers must pass true, and `SameSite=None` without `Secure` is rejected by
 * every current browser anyway.
 */
export function buildVisitorCookie(visitorId: string, secure = true): string {
    const parts = [
        `${VISITOR_COOKIE}=${visitorId}`,
        'Path=/',
        `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECS}`,
        'HttpOnly',
        secure ? 'SameSite=None' : 'SameSite=Lax',
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

/**
 * Read our visitor id out of a raw Cookie header.
 *
 * Returns null for anything that is not a well-formed id we could have minted, so a hand-edited
 * cookie cannot inject a value that later gets written into the ledger as though we issued it.
 */
export function readVisitorCookie(cookieHeader: string | null | undefined): string | null {
    if (!cookieHeader) return null;
    for (const pair of cookieHeader.split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        if (pair.slice(0, eq).trim() !== VISITOR_COOKIE) continue;
        const value = pair.slice(eq + 1).trim();
        return isVisitorId(value) ? value : null;
    }
    return null;
}

// ── Reading the incoming click ──────────────────────────────────────────────────────────────────

export interface NetworkClick {
    id: string;
    /** The parameter it arrived in: 'li_fat_id' | 'gclid' | … */
    kind: string;
}

/**
 * Pull the ad network's own click id off the incoming URL, if there is one.
 *
 * NULL is the overwhelmingly common case (every organic click) and is not a failure — nothing
 * downstream may treat its absence as an error or as "not from a campaign".
 */
export function extractNetworkClick(params: URLSearchParams): NetworkClick | null {
    for (const kind of NETWORK_CLICK_PARAMS) {
        const id = params.get(kind);
        // Length-capped: these are opaque ids, and an unbounded one is someone probing the column.
        if (id && id.length <= 512) return { id, kind };
    }
    return null;
}

/** Pull the UTMs off the incoming URL. Values are length-capped for the same reason. */
export function extractUtm(params: URLSearchParams): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of UTM_PARAMS) {
        const value = params.get(key);
        if (value) out[key] = value.slice(0, 256);
    }
    return out;
}

/**
 * The registrable host of the referring page, or null.
 *
 * Host only, never the full referring URL: the path of the page someone was on before they
 * clicked is browsing history, and we have no use for it.
 */
export function refererHost(referer: string | null | undefined): string | null {
    if (!referer) return null;
    try {
        return new URL(referer).hostname.toLowerCase() || null;
    } catch {
        return null;
    }
}

/**
 * Crude bot heuristic.
 *
 * Deliberately crude, and deliberately non-blocking. Email scanners, link-preview fetchers and
 * corporate proxies hit tracked links constantly, and counting them would inflate every
 * click-through rate in the product. But a heuristic that is *wrong* must not discard a real
 * person's click, so this only ever sets a flag — the row is still written, and the funnel
 * chooses whether to exclude it. Recording and filtering are separable; refusing to record is not.
 */
export function isProbableBot(userAgent: string | null | undefined): boolean {
    if (!userAgent) return true; // A browser always sends one; nothing else reliably does.
    const ua = userAgent.toLowerCase();
    return /bot|crawler|spider|scanner|preview|curl|wget|python-requests|headless|slackbot|whatsapp|facebookexternalhit/.test(ua);
}

// ── Destination safety ──────────────────────────────────────────────────────────────────────────

/**
 * Is this URL safe to redirect a member of the public to?
 *
 * ⚠️ This is an OPEN REDIRECTOR guard, not an SSRF guard, and the distinction changes the answer.
 * safe-fetch.ts blocks private addresses because the SERVER makes the request; here the BROWSER
 * does, so private ranges are the user's own business and blocking them would break a tenant
 * testing against their staging host. What matters instead is that a link on our domain cannot be
 * turned into a credible phishing hop — so: http(s) only (no `javascript:`, no `data:`), no
 * embedded credentials (the classic `https://bemoreswan.com@evil.example` display trick), and no
 * pointing a tracked link at another tracked link.
 *
 * Called at the WRITE boundary, when a link is created. Validating only at redirect time would
 * mean a bad destination sits in the database looking legitimate until someone clicks it.
 */
export function isSafeDestination(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    // No tracked link pointing at a tracked link: two hops is a loop waiting to happen, and it
    // makes the click ledger double-count one click.
    if (/^\/go\//.test(url.pathname)) return false;
    return true;
}

/**
 * Append the click ref to the destination, preserving whatever is already on the URL.
 *
 * The cookie-free binding path. Uses URL rather than string concatenation so a destination that
 * already has a query string, or a fragment, survives intact — a hand-rolled `?` + `&` here would
 * corrupt exactly the links tenants care most about.
 *
 * If the destination already carries a `bmsc`, ours replaces it: the last redirect is the one that
 * happened, and leaving a stale ref would bind the conversion to someone else's click.
 */
export function appendClickRef(destinationUrl: string, clickRef: string): string {
    const url = new URL(destinationUrl);
    url.searchParams.set(CLICK_REF_PARAM, clickRef);
    return url.toString();
}

// ── The binding rule ────────────────────────────────────────────────────────────────────────────

export interface BindingCandidate {
    clickEventId: number;
    campaignId: number;
    linkId: number;
    organisationId: number;
    occurredAt: Date;
}

export interface BindingDecision {
    candidate: BindingCandidate;
    boundVia: 'click_ref' | 'cookie';
}

/**
 * Decide which click, if any, a conversion belongs to.
 *
 * Two rules, in this order, and the order is the interesting part:
 *
 *  1. **A click_ref match always wins.** It identifies one specific click that this specific
 *     person was sent on. A cookie only identifies a browser, which may have clicked several
 *     links since. Precision beats recency.
 *  2. **Otherwise the most recent cookie-matched click wins** — last click at capture, which is
 *     what the unique index on (subject_type, subject_id) enforces downstream.
 *
 * Both are subject to the attribution window. A click outside it is not a weaker signal, it is a
 * different journey, and crediting it would let a campaign that ended in March take credit for a
 * sale in December.
 *
 * Returns null when nothing matches, and null is a real, expected, frequently-correct answer:
 * it means "this conversion is unattributed", which the funnel must then say out loud.
 */
export function chooseBinding(
    byClickRef: BindingCandidate | null,
    byCookie: BindingCandidate[],
    now: Date,
): BindingDecision | null {
    if (byClickRef && isWithinAttributionWindow(byClickRef.occurredAt, now)) {
        return { candidate: byClickRef, boundVia: 'click_ref' };
    }
    const eligible = byCookie
        .filter((c) => isWithinAttributionWindow(c.occurredAt, now))
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    if (eligible.length > 0) return { candidate: eligible[0], boundVia: 'cookie' };
    return null;
}

/** Is a click recent enough to be credited? Inclusive at the boundary. */
export function isWithinAttributionWindow(clickAt: Date, now: Date): boolean {
    const ageMs = now.getTime() - clickAt.getTime();
    // A click from the future is a clock problem, not an attribution: refuse rather than credit.
    if (ageMs < 0) return false;
    return ageMs <= ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
