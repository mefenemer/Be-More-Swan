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

// ── Your own forums ──────────────────────────────────────────────────────────────────────────────
// Beyond the four built-ins, a watch can name up to MAX_OWN_FORUMS forums of its own — a trade forum,
// a US community, a wedding forum. They live in the SAME `sites` array as `forum:<host[/path]>`
// entries (no schema change), are searched the same way (`site:<host[/path]>`), and are judged the
// same way. The thread check is generic, so a stray listing page costs one triage slot at most.

export const MAX_OWN_FORUMS = 5;
export type OwnForum = `forum:${string}`;
/** Anything a watch can search: a built-in site key or one of the user's own forums. */
export type DiscussionSource = DiscussionSiteKey | OwnForum;

/** Starter suggestions, one click each. Each was probed (2026-10-30) and returned threads from the last week. */
export const SUGGESTED_FORUMS: Array<{ address: string; label: string; about: string }> = [
    { address: 'indiehackers.com', label: 'Indie Hackers', about: 'founders and online businesses, mostly US' },
    { address: 'community.shopify.com', label: 'Shopify Community', about: 'online shop owners' },
    { address: 'warriorforum.com', label: 'Warrior Forum', about: 'internet marketing, mostly US' },
    { address: 'biggerpockets.com/forums', label: 'BiggerPockets', about: 'US property investors' },
    { address: 'contractortalk.com', label: 'ContractorTalk', about: 'US builders and trades' },
];

const OWN_FORUM_NOTE = 'Check this forum’s rules before replying — many only allow a business to be named in a signature or a promotions section. Lead with the help.';

/**
 * A forum address as the user typed it ("https://www.contractortalk.com/forums/", "biggerpockets.com/forums")
 * → `host[/path]`, lowercased, no scheme, `www.`, query or trailing slash. Null when it isn't a public
 * web address, or it is one of the built-in sites (tick that instead).
 */
export function normaliseForumAddress(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let t = raw.trim().toLowerCase().replace(/^forum:/, '');
    if (!t) return null;
    if (!/^https?:\/\//.test(t)) t = `https://${t}`;
    let u: URL;
    try { u = new URL(t); } catch { return null; }
    const host = u.hostname.replace(/^www\./, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+)+$/.test(host) || host.endsWith('.local') || host === 'localhost') return null;
    if (DISCUSSION_SITE_KEYS.some((k) => DISCUSSION_SITES[k].hosts.some((h) => host === h || host.endsWith(`.${h}`)))) return null;
    const path = u.pathname.replace(/\/+$/, '').replace(/[^a-z0-9/_.-]/g, '').slice(0, 60);
    return `${host}${path}`;
}

export function isOwnForum(v: unknown): v is OwnForum {
    return typeof v === 'string' && v.startsWith('forum:') && normaliseForumAddress(v) === v.slice(6);
}

export function isDiscussionSource(v: unknown): v is DiscussionSource {
    return isDiscussionSite(v) || isOwnForum(v);
}

/** Label, search filter, hosts and rules note for any source. */
export function sourceInfo(source: DiscussionSource): { label: string; siteFilter: string; hosts: string[]; pathPrefix: string; promotionNote: string; own: boolean } {
    if (isDiscussionSite(source)) {
        const s = DISCUSSION_SITES[source];
        return { label: s.label, siteFilter: s.siteFilter, hosts: s.hosts, pathPrefix: '', promotionNote: s.promotionNote, own: false };
    }
    const address = source.slice(6);
    const slash = address.indexOf('/');
    const host = slash === -1 ? address : address.slice(0, slash);
    const suggested = SUGGESTED_FORUMS.find((f) => f.address === address);
    return {
        label: suggested?.label ?? address, siteFilter: `site:${address}`, hosts: [host],
        pathPrefix: slash === -1 ? '' : address.slice(slash), promotionNote: OWN_FORUM_NOTE, own: true,
    };
}

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

/** Built-in sites in their fixed order, then up to MAX_OWN_FORUMS own forums (`forum:<address>`, cleaned and deduped). */
export function normaliseSites(raw: unknown): DiscussionSource[] {
    const list = Array.isArray(raw) ? raw : [];
    const own: OwnForum[] = [];
    for (const v of list) {
        if (typeof v !== 'string' || !v.startsWith('forum:')) continue;
        const a = normaliseForumAddress(v);
        if (a && !own.includes(`forum:${a}`)) own.push(`forum:${a}`);
        if (own.length >= MAX_OWN_FORUMS) break;
    }
    return [...DISCUSSION_SITE_KEYS.filter((k) => list.includes(k)), ...own];
}

/** The Google query for one topic on one source. */
export function discussionQuery(topic: string, site: DiscussionSource): string {
    return `${sourceInfo(site).siteFilter} ${topic}`;
}

/** Which watched source a result URL belongs to, or null when Google strayed off it. */
export function siteForUrl(url: string, sites: readonly DiscussionSource[]): DiscussionSource | null {
    let host: string; let path: string;
    try { const u = new URL(url); host = u.hostname.toLowerCase().replace(/^www\./, ''); path = u.pathname.toLowerCase(); } catch { return null; }
    for (const k of sites) {
        const info = sourceInfo(k);
        if (!info.hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
        if (info.pathPrefix && !path.startsWith(info.pathPrefix)) continue;
        return k;
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
export function looksLikeThread(url: string, site: DiscussionSource): boolean {
    let path: string;
    try { path = new URL(url).pathname; } catch { return false; }
    if (isOwnForum(site)) {
        // Any forum software: not the home page, not a file, not a member/search/login/tag page.
        if (path.replace(/\/+$/, '').split('/').filter(Boolean).length < 1) return false;
        if (/\.(pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?)$/i.test(path)) return false;
        return !/\/(attachments?|members?|users?|profile|profiles|u|tags?|search|login|register|signup|account|help|about|learning-center|directory)(\/|$)/i.test(path);
    }
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

/**
 * Reddit renders markdown. Quora, UK Business Forums and LinkedIn don't — `*this*` pastes as literal
 * asterisks — so off Reddit the emphasis markers come out (the words stay).
 */
export function plainForSite(reply: string, site: DiscussionSource): string {
    if (site === 'reddit') return reply;
    return reply
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1');
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
