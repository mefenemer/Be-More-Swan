// src/utils/linkedin-page-api.ts
// The Community Management reads and writes behind a LinkedIn Company Page's results and comments:
// per-post statistics, the follower total, the comments on a Page post, and a reply posted AS the
// Page. Network + pure parsers only — no database — so tests can drive the parsers directly and the
// ingest (ingest-linkedin-insights.ts) and the Comments tab (src/utils/page-comments.ts) share one
// copy of every URL.
//
// Scopes (src/config/linkedin-capabilities.ts, Community app only — a member token is refused):
//   rw_organization_admin       — organizationalEntityShareStatistics, networkSizes
//   r_organization_social_feed  — GET socialActions/{post}/comments
//   w_organization_social_feed  — POST socialActions/{comment}/comments (reply as the Page)
//
// Shapes are from LinkedIn's li-lms-2026-11 docs (Comments API, Organization Share Statistics,
// Organization Follower Statistics / networkSizes), read 2026-11-18. Nothing here has been called
// against LinkedIn yet; the parsers are written to the documented field tables, and every call
// returns null/[] rather than throwing so one refused call never sinks a whole ingest tick.

import { LINKEDIN_API_VERSION } from './ad-networks/linkedin';

const API = 'https://api.linkedin.com/rest';
const ORG_PREFIX = 'urn:li:organization:';

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'Linkedin-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
        ...extra,
    };
}

/** The two post URN kinds the statistics endpoint takes, each on its own parameter. Pure. */
export type PostUrnKind = 'share' | 'ugcPost';
export function postUrnKind(urn: string | null | undefined): PostUrnKind | null {
    if (typeof urn !== 'string') return null;
    if (/^urn:li:share:\d+$/.test(urn)) return 'share';
    if (/^urn:li:ugcPost:\d+$/.test(urn)) return 'ugcPost';
    return null;
}

/**
 * A URN as one Rest.li 2.0 value: percent-encoded INCLUDING parentheses, which encodeURIComponent
 * leaves alone but Rest.li 2.0 reads as structure — a comment URN, urn:li:comment:(<thread>,<id>),
 * sent with bare parentheses in a path is a "Syntax exception in path variables". Pure.
 */
export function restliEncode(urn: string): string {
    return encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** Rest.li 2.0 List(...) of URNs, each value encoded. Pure. */
export function restliList(urns: string[]): string {
    return `List(${urns.map(restliEncode).join(',')})`;
}

// ── Post statistics ────────────────────────────────────────────────────────────────────────────

export interface LinkedInPostStats {
    impressions: number | null;
    uniqueImpressions: number | null;
    clicks: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    engagement: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One element's totalShareStatistics → our counters. Pure. */
export function parseShareStatistics(totals: unknown): LinkedInPostStats {
    const t = (totals && typeof totals === 'object' ? totals : {}) as Record<string, unknown>;
    return {
        impressions: num(t.impressionCount),
        // The schema says uniqueImpressionsCount; one documented sample says uniqueImpressionsCounts.
        uniqueImpressions: num(t.uniqueImpressionsCount) ?? num(t.uniqueImpressionsCounts),
        clicks: num(t.clickCount),
        // likeCount "can go negative" (unlikes after a snapshot) — never show a negative.
        likes: num(t.likeCount) == null ? null : Math.max(0, num(t.likeCount)!),
        comments: num(t.commentCount),
        shares: num(t.shareCount),
        engagement: num(t.engagement),
    };
}

/** A post LinkedIn left out of a successful response had no activity yet — zeros, per the docs. */
export const ZERO_STATS: LinkedInPostStats = {
    impressions: 0, uniqueImpressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, engagement: 0,
};

/** A statistics response → URN → stats, keyed by whichever of `share` / `ugcPost` each element names. Pure. */
export function parseShareStatisticsResponse(body: unknown): Map<string, LinkedInPostStats> {
    const out = new Map<string, LinkedInPostStats>();
    const elements = (body as { elements?: unknown[] } | null)?.elements;
    if (!Array.isArray(elements)) return out;
    for (const el of elements) {
        const e = el as Record<string, unknown>;
        const urn = typeof e.share === 'string' ? e.share : typeof e.ugcPost === 'string' ? e.ugcPost : null;
        if (urn) out.set(urn, parseShareStatistics(e.totalShareStatistics));
    }
    return out;
}

/** At most this many posts per statistics call — keeps the URL well inside LinkedIn's limits. */
const STATS_CHUNK = 20;

/**
 * Lifetime organic statistics for the given posts of one Page. Returns URN → stats for every post
 * it could ask about (missing-from-response = zeros), and leaves out the posts whose call failed.
 * Never throws.
 */
export async function fetchPostStatistics(token: string, orgUrn: string, postUrns: string[]): Promise<Map<string, LinkedInPostStats>> {
    const out = new Map<string, LinkedInPostStats>();
    const byKind: Record<PostUrnKind, string[]> = { share: [], ugcPost: [] };
    for (const u of new Set(postUrns)) { const k = postUrnKind(u); if (k) byKind[k].push(u); }

    for (const kind of ['share', 'ugcPost'] as PostUrnKind[]) {
        const list = byKind[kind];
        for (let i = 0; i < list.length; i += STATS_CHUNK) {
            const chunk = list.slice(i, i + STATS_CHUNK);
            const param = kind === 'share' ? 'shares' : 'ugcPosts';
            const url = `${API}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${restliEncode(orgUrn)}&${param}=${restliList(chunk)}`;
            const body = await getJson(token, url);
            if (!body) continue;
            const got = parseShareStatisticsResponse(body);
            for (const u of chunk) out.set(u, got.get(u) ?? { ...ZERO_STATS });
        }
    }
    return out;
}

// ── Followers ──────────────────────────────────────────────────────────────────────────────────

/** The Page's total follower count (networkSizes firstDegreeSize), or null. Never throws. */
export async function fetchPageFollowerCount(token: string, orgUrn: string): Promise<number | null> {
    if (!orgUrn.startsWith(ORG_PREFIX)) return null;
    const body = await getJson(token, `${API}/networkSizes/${restliEncode(orgUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`);
    return num((body as { firstDegreeSize?: unknown } | null)?.firstDegreeSize);
}

// ── Comments ───────────────────────────────────────────────────────────────────────────────────

export interface LinkedInComment {
    /** urn:li:comment:(<thread>,<id>) — what a reply's parentComment and its path take. */
    commentUrn: string;
    /** The post (share / ugcPost / activity) the comment is on — a reply's `object`. */
    objectUrn: string | null;
    /** urn:li:person:… or urn:li:organization:… */
    actorUrn: string | null;
    text: string;
    createdAt: Date | null;
    /** Set on a reply to another comment. */
    parentCommentUrn: string | null;
    /** How many replies sit under it (commentsSummary), or null when LinkedIn didn't say. */
    replyCount: number | null;
}

/** One element of a comments list → LinkedInComment, or null when it has no usable URN or text. Pure. */
export function parseComment(el: unknown): LinkedInComment | null {
    const e = (el && typeof el === 'object' ? el : {}) as Record<string, any>;
    const commentUrn = typeof e.commentUrn === 'string' ? e.commentUrn : null;
    const text = typeof e.message?.text === 'string' ? e.message.text : '';
    if (!commentUrn || !text.trim()) return null;
    const actorUrn = typeof e.actor === 'string' ? e.actor : (typeof e.created?.actor === 'string' ? e.created.actor : null);
    const time = num(e.created?.time);
    return {
        commentUrn,
        objectUrn: typeof e.object === 'string' ? e.object : null,
        actorUrn,
        text: text.slice(0, 4000),
        createdAt: time != null ? new Date(time) : null,
        parentCommentUrn: typeof e.parentComment === 'string' ? e.parentComment : null,
        replyCount: num(e.commentsSummary?.aggregatedTotalComments) ?? num(e.commentsSummary?.totalFirstLevelComments),
    };
}

export function parseCommentsResponse(body: unknown): LinkedInComment[] {
    const elements = (body as { elements?: unknown[] } | null)?.elements;
    return Array.isArray(elements) ? elements.map(parseComment).filter((c): c is LinkedInComment => !!c) : [];
}

/** The people's names, asked for as a projection. LinkedIn may refuse it — then we ask without. */
const COMMENTS_PAGE = 50;

/** Why a comments read came back empty-handed — the caller reports it (the ingest's result carries
 *  these, since Netlify's function log drops the warnings). status 0 = network error or time-out. */
export type ReadFailure = { status: number; message: string };

/**
 * The newest comments on one Page post (up to 50). Null when LinkedIn refused the call — the
 * caller must not read null as "no comments" — and `onFail` then says why. A 404 means the post is
 * gone (deleted on LinkedIn): that is an empty list, not a failure, so a deleted post doesn't keep
 * the tab warning about a refused read. Never throws.
 *
 * One plain call, no `actor~` name projection: LinkedIn gives a Community Management app no
 * documented way to name a commenter (decoration is deprecated in the versioned APIs and the
 * People API is restricted), its terms bar storing other members' profile data, and the refused
 * projection cost a second call per post against the Development tier's 500 a day. The tab says
 * "Someone" and links to the comment on LinkedIn, where the Page admin can see who it was.
 */
export async function fetchPostComments(token: string, postUrn: string, deadline?: number, onFail?: (f: ReadFailure) => void): Promise<LinkedInComment[] | null> {
    const r = await getJsonResult(token, `${API}/socialActions/${restliEncode(postUrn)}/comments?start=0&count=${COMMENTS_PAGE}`, deadline);
    if (r.ok) return parseCommentsResponse(r.body);
    if (r.status === 404) return [];
    onFail?.({ status: r.status, message: r.message });
    return null;
}

/**
 * The replies under one comment. LinkedIn lists only TOP-LEVEL comments on a post; a reply — the
 * Page's own included — lives under its parent's comment URN, so this is how a reply the Page made
 * on LinkedIn itself is seen. No name projection: only the replying actor's URN is needed. Null when
 * refused. Never throws.
 */
export async function fetchCommentReplies(token: string, commentUrn: string, deadline?: number): Promise<LinkedInComment[] | null> {
    const body = await getJson(token, `${API}/socialActions/${restliEncode(commentUrn)}/comments?start=0&count=${COMMENTS_PAGE}`, deadline);
    if (!body) return null;
    // A reply element may leave parentComment out (it is implied by the path) — fill it in.
    return parseCommentsResponse(body).map((c) => ({ ...c, parentCommentUrn: c.parentCommentUrn ?? commentUrn }));
}

/** Comments LinkedIn's own UI can open: the post, scrolled to the comment. Pure. */
export function linkedInCommentUrl(postUrn: string | null, commentUrn: string): string | null {
    if (!postUrn) return null;
    return `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/?commentUrn=${encodeURIComponent(commentUrn)}`;
}

/**
 * `unconfirmed`: LinkedIn did not answer (timeout, network error) or answered 5xx — the reply MAY have
 * been posted. Only a 4xx is a definite refusal; the caller must never offer to post again otherwise.
 */
export type ReplyResult = { ok: true; commentUrn: string | null } | { ok: false; status: number | null; error: string; unconfirmed: boolean };

/** A refusal we can be sure posted nothing: LinkedIn answered, with a 4xx. Pure. */
export function replyDefinitelyRefused(status: number | null): boolean {
    return status != null && status >= 400 && status < 500;
}

/** The comment's thread URN, the first part of urn:li:comment:(<thread>,<id>). Pure. */
export function commentThreadUrn(commentUrn: string): string | null {
    const m = /^urn:li:comment:\((urn:li:[a-zA-Z]+:\d+),(\d+)\)$/.exec(commentUrn);
    return m ? m[1] : null;
}

/**
 * Post `text` as the Page, as a reply to `commentUrn` on the post `objectUrn`. The new comment's
 * URN is rebuilt from the x-restli-id header (its id) and the parent's thread. Never throws.
 */
export async function replyToComment(
    token: string,
    opts: { orgUrn: string; objectUrn: string; commentUrn: string; text: string },
): Promise<ReplyResult> {
    const text = opts.text.trim();
    if (!text) return { ok: false, status: null, error: 'The reply is empty.', unconfirmed: false };
    try {
        const res = await fetch(`${API}/socialActions/${restliEncode(opts.commentUrn)}/comments`, {
            method: 'POST',
            headers: headers(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                actor: opts.orgUrn,
                object: opts.objectUrn,
                parentComment: opts.commentUrn,
                message: { text: text.slice(0, 1250) },
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 201 || res.ok) {
            const data = await res.json().catch(() => ({})) as { commentUrn?: string; id?: string };
            const id = res.headers.get('x-restli-id') || data.id || null;
            const thread = commentThreadUrn(opts.commentUrn);
            return { ok: true, commentUrn: data.commentUrn || (id && thread ? `urn:li:comment:(${thread},${id})` : null) };
        }
        const data = await res.json().catch(() => ({})) as { message?: string };
        return { ok: false, status: res.status, error: replyErrorMessage(res.status, data.message), unconfirmed: !replyDefinitelyRefused(res.status) };
    } catch (err) {
        return { ok: false, status: null, error: err instanceof Error ? err.message : 'LinkedIn could not be reached.', unconfirmed: true };
    }
}

/** LinkedIn's refusal in words a Page owner can act on. Pure. */
export function replyErrorMessage(status: number | null, linkedInMessage?: string | null): string {
    if (status === 401) return 'LinkedIn says this connection has expired. Reconnect your Company Page in Connections and try again.';
    if (status === 403) return 'LinkedIn refused the reply. Only a Page admin can reply as the Page — reconnect LinkedIn as an admin of this Page.';
    if (status === 404) return 'That comment is no longer on LinkedIn — it may have been deleted.';
    if (status === 429) return 'LinkedIn is limiting how fast replies can be posted. Wait a few minutes and try again.';
    return linkedInMessage ? `LinkedIn refused the reply: ${linkedInMessage}` : `LinkedIn refused the reply (${status ?? 'no response'}).`;
}

// ── Shared ─────────────────────────────────────────────────────────────────────────────────────

/** The longest any one read waits. */
const CALL_TIMEOUT_MS = 10_000;
/** However late, a call is given at least this long — a near-zero abort would just waste the call. */
const MIN_CALL_MS = 500;

/**
 * How long one call may wait: CALL_TIMEOUT_MS, or the time left before `deadline` (at least
 * MIN_CALL_MS) — so a caller's time budget holds even when one LinkedIn call is slow. Pure.
 */
export function callTimeoutMs(deadline: number | undefined, now = Date.now()): number {
    if (!deadline) return CALL_TIMEOUT_MS;
    return Math.min(CALL_TIMEOUT_MS, Math.max(MIN_CALL_MS, deadline - now));
}

type JsonResult = { ok: true; body: unknown } | { ok: false; status: number; message: string };
async function getJsonResult(token: string, url: string, deadline?: number): Promise<JsonResult> {
    try {
        const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(callTimeoutMs(deadline)) });
        if (!res.ok) {
            const msg = (await res.text().catch(() => '')).slice(0, 200);
            console.warn(`[linkedin-page-api] ${res.status} ${url.split('?')[0]} ${msg}`);
            return { ok: false, status: res.status, message: msg };
        }
        return { ok: true, body: await res.json() };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[linkedin-page-api] fetch failed', url.split('?')[0], msg);
        return { ok: false, status: 0, message: msg.slice(0, 200) };
    }
}
async function getJson(token: string, url: string, deadline?: number): Promise<unknown | null> {
    const r = await getJsonResult(token, url, deadline);
    return r.ok ? r.body : null;
}
