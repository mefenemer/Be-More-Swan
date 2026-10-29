// src/config/discussion-sites.ts
// The Lead Generator's Discussions tab — which public forums it watches, how a search for each is
// written, and the rules every drafted reply obeys. Pure: no DB, no network. Tested in
// tests/discussions.test.ts.
//
// ── Listening, never posting ─────────────────────────────────────────────────────────────────────
// Threads are FOUND through Google (Serper, `site:` + last week) and LINKED TO. Nothing in the
// product posts to any of these sites, and nothing should: Reddit's Responsible Builder Policy bans
// promotional bots, most communities ban undisclosed self-promotion, and the DMCC Act 2024 makes
// hiding that a recommendation comes from the business itself an unfair practice. So the reply is
// drafted here and posted by a person, from their own account, with the disclosure line on it.
//
// ── Why Google and not each site's API ───────────────────────────────────────────────────────────
// Reddit's Data API now needs advance approval and a negotiated licence for commercial use; Quora
// has no public API; LinkedIn has no post search. One `site:` search through the provider the Lead
// Generator already pays for covers all of them, and reads only what Google already shows.

export const DISCUSSION_SITE_KEYS = ['reddit', 'ukbf', 'quora', 'linkedin'] as const;
export type DiscussionSiteKey = typeof DISCUSSION_SITE_KEYS[number];

export interface DiscussionSite {
    key: DiscussionSiteKey;
    label: string;
    /** The `site:` filter. LinkedIn is narrowed to posts — profiles and company pages are not threads. */
    siteFilter: string;
    /** Hostnames a result must belong to; anything else Google returns for the filter is dropped. */
    hosts: string[];
    /** Shown on every card from this site, beside the draft. Plain facts about the house rules. */
    promotionNote: string;
}

export const DISCUSSION_SITES: Record<DiscussionSiteKey, DiscussionSite> = {
    reddit: {
        key: 'reddit', label: 'Reddit', siteFilter: 'site:reddit.com', hosts: ['reddit.com'],
        promotionNote: 'Most subreddits ban self-promotion or limit it to a small share of what you post. Read the subreddit’s rules (sidebar or “About”) before replying, and lead with the help, not the link.',
    },
    ukbf: {
        key: 'ukbf', label: 'UK Business Forums', siteFilter: 'site:ukbusinessforums.co.uk', hosts: ['ukbusinessforums.co.uk'],
        promotionNote: 'Advertising in replies is not allowed outside the forum’s promotion sections. Answer the question; your business can be named in your profile signature.',
    },
    quora: {
        key: 'quora', label: 'Quora', siteFilter: 'site:quora.com', hosts: ['quora.com'],
        promotionNote: 'Quora asks you to disclose any connection to a product you mention. Keep the disclosure line in.',
    },
    linkedin: {
        key: 'linkedin', label: 'LinkedIn', siteFilter: 'site:linkedin.com/posts', hosts: ['linkedin.com'],
        promotionNote: 'A comment from your own profile already shows who you are. A short, useful answer works better than a pitch.',
    },
};

/** What a new watch starts with. LinkedIn is off by default — its posts are mostly people selling. */
export const DEFAULT_DISCUSSION_SITES: DiscussionSiteKey[] = ['reddit', 'ukbf', 'quora'];

/** Bounds on one scan: MAX_TOPICS × sites searches, so at most 5 × 4 = 20 Serper calls. */
export const MAX_TOPICS = 5;
export const TOPIC_MAX_CHARS = 120;
/** Results asked for per search. */
export const RESULTS_PER_SEARCH = 10;
/** New threads sent to the model in one scan; the rest wait for tomorrow's (they are still new). */
export const MAX_TRIAGE_PER_SCAN = 20;
/** Below this the thread is not kept at all — no card for something that only mentions a keyword. */
export const MIN_RELEVANCE = 50;
/** A thread Google dates further back than this is past the point where a reply is welcome. */
export const MAX_THREAD_AGE_DAYS = 7;

export function isDiscussionSite(v: unknown): v is DiscussionSiteKey {
    return typeof v === 'string' && (DISCUSSION_SITE_KEYS as readonly string[]).includes(v);
}

/** Clean, dedupe and bound the user's topics. Pure. */
export function normaliseTopics(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\n|;/) : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of list) {
        if (typeof v !== 'string') continue;
        // Quotes and `site:` are the user's to keep out — a stray one would rewrite the whole search.
        const t = v.replace(/\bsite:\S+/gi, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX_CHARS);
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
        if (out.length >= MAX_TOPICS) break;
    }
    return out;
}

export function normaliseSites(raw: unknown): DiscussionSiteKey[] {
    const list = Array.isArray(raw) ? raw : [];
    return DISCUSSION_SITE_KEYS.filter((k) => list.includes(k));
}

/** The Google query for one topic on one site. */
export function discussionQuery(topic: string, site: DiscussionSiteKey): string {
    return `${DISCUSSION_SITES[site].siteFilter} ${topic}`;
}

/** Which watched site a result URL belongs to, or null when Google strayed off it. */
export function siteForUrl(url: string, sites: readonly DiscussionSiteKey[]): DiscussionSiteKey | null {
    let host: string;
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
    for (const k of sites) {
        if (DISCUSSION_SITES[k].hosts.some((h) => host === h || host.endsWith(`.${h}`))) return k;
    }
    return null;
}

/**
 * One thread, one row. Drops the query string and fragment (tracking, comment anchors), the
 * trailing slash, and `www.`/`old.`/`m.` hosts, so the same thread reached two ways dedupes.
 * Null for anything that is not an http(s) URL.
 */
export function normaliseThreadUrl(raw: string): string | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase().replace(/^(www|old|m|new)\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `https://${host}${path}`;
}

/**
 * Is this result a THREAD, or a page about the site? Listing pages, profiles and search pages are
 * not something a person can reply to. Conservative — a false keep costs one triage slot.
 */
export function looksLikeThread(url: string, site: DiscussionSiteKey): boolean {
    let path: string;
    try { path = new URL(url).pathname; } catch { return false; }
    if (site === 'reddit') return /\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(path);
    if (site === 'ukbf') return /\/threads\//i.test(path);
    if (site === 'linkedin') return /^\/posts\//i.test(path);
    if (site === 'quora') return !/^\/(profile|topic|search|spaces?)\b/i.test(path) && path.length > 1;
    return true;
}

/**
 * How old Google says a result is, in days, from its own label ("3 days ago", "2 weeks ago",
 * "12 Oct 2026"). Null when there is no label or it cannot be read — the `tbs` week filter on the
 * search is the real bound; this only catches what Google lets through.
 */
export function postedAgeDays(label: string | null | undefined, now: Date = new Date()): number | null {
    if (!label) return null;
    const s = label.trim().toLowerCase();
    const rel = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/.exec(s);
    if (rel) {
        const n = Number(rel[1]);
        const per: Record<string, number> = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
        return n * per[rel[2]];
    }
    const t = Date.parse(label);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/**
 * The line every drafted reply ends with. Added in CODE after the model has written the reply, so
 * no prompt drift can drop it. Without a business name it still says the writer has an interest.
 */
export function discussionDisclosure(businessName: string | null | undefined): string {
    const name = (businessName || '').trim();
    return name
        ? `(Full disclosure: I work at ${name}, so I’m biased.)`
        : '(Full disclosure: I sell something in this space, so I’m biased.)';
}

/** Matches any disclosure line we would have added, so a redraft never stacks two. */
const DISCLOSURE_RE = /\n*\(Full disclosure:[^)]*\)\s*$/i;

/** The reply as it is stored and shown: the model's words, then exactly one disclosure line. */
export function withDisclosure(reply: string, businessName: string | null | undefined): string {
    const body = reply.replace(DISCLOSURE_RE, '').trim();
    return `${body}\n\n${discussionDisclosure(businessName)}`;
}

/** True when the stored reply still carries a disclosure line (the user may edit the draft). */
export function hasDisclosure(reply: string | null | undefined): boolean {
    return !!reply && DISCLOSURE_RE.test(reply);
}

export const DISCUSSION_STATUSES = ['new', 'replied', 'dismissed'] as const;
export type DiscussionStatus = typeof DISCUSSION_STATUSES[number];
export const DISCUSSION_FITS = ['asking_for', 'can_help'] as const;
export type DiscussionFit = typeof DISCUSSION_FITS[number];
export const DISCUSSION_FIT_LABELS: Record<DiscussionFit, string> = {
    asking_for: 'Asking for what you sell',
    can_help: 'You could help',
};

/** A scan left `running` longer than this is treated as dead and may be started again. */
export const SCAN_STALE_MS = 20 * 60_000;
/** The daily scan skips a watch scanned more recently than this (a "Scan now" earlier today). */
export const DAILY_SCAN_MIN_GAP_MS = 18 * 3_600_000;
