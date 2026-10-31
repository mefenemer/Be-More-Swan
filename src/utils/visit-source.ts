// src/utils/visit-source.ts — where a visit to the public site came from, for the growth funnel
// (Admin → Analytics → Growth funnel). Pure: no database, no clock. Owner decision 2026-10-31: our
// own cookieless counter, not a third-party analytics tool, because the privacy policy promises no
// analytics tracker and no pixel.
//
// What is kept, and what is not:
//   · kept — the page, a SOURCE LABEL (e.g. "linkedin", "google", "chatgpt"), a campaign tag, the day;
//     stored only as daily totals (site_visit_counts) and, for a sign-up, on that account
//     (signup_sources), so we can tell which marketing activity brought them.
//   · never kept — IP address, user agent, cookies, anything on the device, the full referring URL.
//
// How a source survives from the landing page to /register without storing anything on the device:
// visit-count.js rewrites same-site links as they are clicked to carry ?src=<label>&cmp=<campaign>,
// and the register page sends them with the sign-up. A visitor who arrives with no referrer and no
// tag is "direct"; when we can't tell, we say so — an unknown source is never relabelled organic.

/** Labels for the referring sites we recognise. Checked in order, so specific hosts come first. */
const KNOWN_HOSTS: Array<[RegExp, string]> = [
    [/(^|\.)gemini\.google\.com$/, 'gemini'],
    [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, 'chatgpt'],
    [/(^|\.)perplexity\.ai$/, 'perplexity'],
    [/(^|\.)claude\.ai$/, 'claude'],
    [/(^|\.)copilot\.microsoft\.com$/, 'copilot'],
    [/(^|\.)google\.[a-z.]+$/, 'google'],
    [/(^|\.)bing\.com$/, 'bing'],
    [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
    [/(^|\.)yahoo\.[a-z.]+$/, 'yahoo'],
    [/(^|\.)ecosia\.org$/, 'ecosia'],
    [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, 'linkedin'],
    [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/, 'facebook'],
    [/(^|\.)instagram\.com$/, 'instagram'],
    [/(^|\.)threads\.(net|com)$/, 'threads'],
    [/(^|\.)x\.com$|(^|\.)twitter\.com$|^t\.co$/, 'x'],
    [/(^|\.)reddit\.com$/, 'reddit'],
    [/(^|\.)youtube\.com$|^youtu\.be$/, 'youtube'],
    [/(^|\.)tiktok\.com$/, 'tiktok'],
    [/(^|\.)pinterest\.[a-z.]+$/, 'pinterest'],
    [/(^|\.)g2\.com$/, 'g2'],
    [/(^|\.)trustpilot\.com$/, 'trustpilot'],
    [/(^|\.)producthunt\.com$/, 'producthunt'],
];

/** Our own hosts: a referrer from one of these is a click inside the site, not a new source. */
export const OWN_HOSTS = /(^|\.)bemoreswan\.com$|(^|\.)netlify\.app$|^localhost$|^127\.0\.0\.1$/;

export const DIRECT = 'direct';
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_CAMPAIGN = 60;
const MAX_PATH = 80;

/** A source label or campaign tag as we store it: lower case, safe characters, bounded. */
export function cleanLabel(v: unknown, max = 40): string | null {
    const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').slice(0, max);
    return s && /^[a-z0-9]/.test(s) ? s : null;
}

/** A campaign tag (utm_campaign / cmp), or '' when there is none. */
export function cleanCampaign(v: unknown): string {
    return cleanLabel(v, MAX_CAMPAIGN) ?? '';
}

/** The host of a referring URL, lower case, without "www.", or null. */
export function referrerHost(ref: unknown): string | null {
    const raw = String(ref ?? '').trim();
    if (!raw) return null;
    try {
        const host = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
        return host.replace(/^www\./, '') || null;
    } catch { return null; }
}

/** The label for a referring host: a known site's name, else the host itself (bounded). */
export function labelForHost(host: string): string {
    for (const [re, label] of KNOWN_HOSTS) if (re.test(host)) return label;
    return cleanLabel(host) ?? 'other';
}

/** The page as we count it: "/", "/pricing", "/ai-mystery-shopper" — never a query string. Null = not a page we count. */
export function cleanPath(v: unknown): string | null {
    let p = String(v ?? '').trim().split(/[?#]/)[0].toLowerCase();
    if (!p.startsWith('/')) return null;
    p = p.replace(/\/index(\.html)?$/, '/').replace(/\.html$/, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    if (p.length > MAX_PATH || !/^\/[a-z0-9/_-]*$/.test(p) || p.includes('//')) return null;
    return p;
}

export interface VisitInput {
    path: unknown;
    /** document.referrer (only its host is ever read). */
    ref?: unknown;
    utmSource?: unknown;
    utmCampaign?: unknown;
    /** The source carried on an internal link by visit-count.js. */
    src?: unknown;
    cmp?: unknown;
}

export interface ClassifiedVisit {
    path: string;
    source: string;
    campaign: string;
    /** True when this view STARTS a visit (arrived from outside, or with no referrer). */
    entry: boolean;
}

/**
 * Classify one page view. Order matters:
 *   1. a campaign tag (utm_source) names the source outright — our own links in posts, emails, ads;
 *   2. a referrer from another site names it by that site;
 *   3. a carried ?src= means a click inside the site from an earlier landing — not a new visit;
 *   4. a referrer from our own site with nothing carried is a click inside a direct visit;
 *   5. no referrer at all is a direct visit (typed, bookmarked, an email app, or a stripped referrer).
 */
export function classifyVisit(v: VisitInput): ClassifiedVisit | null {
    const path = cleanPath(v.path);
    if (!path) return null;
    const utm = cleanLabel(v.utmSource);
    if (utm) return { path, source: utm, campaign: cleanCampaign(v.utmCampaign), entry: true };
    const host = referrerHost(v.ref);
    if (host && !OWN_HOSTS.test(host)) return { path, source: labelForHost(host), campaign: cleanCampaign(v.utmCampaign), entry: true };
    const carried = cleanLabel(v.src);
    if (carried && LABEL_RE.test(carried)) return { path, source: carried, campaign: cleanCampaign(v.cmp), entry: false };
    if (host) return { path, source: DIRECT, campaign: '', entry: false };
    return { path, source: DIRECT, campaign: '', entry: true };
}

/** The source a sign-up arrived with, from what register.html sends. Unknown → null (stored as nothing). */
export function cleanSignupSource(v: unknown): { source: string; campaign: string } | null {
    const o = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
    const source = cleanLabel(o.source);
    if (!source || !LABEL_RE.test(source)) return null;
    return { source, campaign: cleanCampaign(o.campaign) };
}

/** Crawlers and link previews: never counted (the user agent itself is never stored). */
export function isBot(userAgent: unknown): boolean {
    const ua = String(userAgent ?? '');
    if (!ua) return true;
    return /bot|crawl|spider|slurp|preview|fetch|monitor|headless|lighthouse|pingdom|uptime|curl|wget|python|go-http|axios|node-fetch|facebookexternalhit|embedly|whatsapp|telegram|discord|skype/i.test(ua);
}
