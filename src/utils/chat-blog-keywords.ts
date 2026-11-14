// src/utils/chat-blog-keywords.ts
// The Blog Writer chat's card for a keyword on EVERY article: rename it (onto one the blog already
// uses = merge) or remove it. The blog-wide twin of Blog setup ▸ Keywords (blog-studio-modal.js) —
// the click calls netlify/functions/blog-keywords, the endpoint that list uses, so the two can't drift.
// One article's keywords are the blog_action_proposal "keywords" action (chat-blog-action.ts).
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is reachable from the GUI and from chat (owner rule). A customer whose blog moved
// from employee wellness to women approaching retirement asked how to change the keywords "for the
// blog as a whole" (2026-11-14); the chat could neither see keywords nor change them.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// The model proposes { type: 'blog_keyword_proposal', op, from, to }. This module cleans the words
// the same way every keyword writer does (blog-keywords.ts cleanKeyword) and rebuilds the card from
// listBlogKeywords: how many articles carry the keyword, how many are live, and whether `to` is
// already in use (then it is a merge). A keyword no article carries is blocked with the list of
// keywords that ARE used, so the user can pick one. Nothing here writes; the click does.
//
// ⚠️ Never throws.

import type { getDb } from '../../db/client';
import { cleanKeyword, listBlogKeywords, type BlogKeywordRow } from './blog-keywords';

type Db = ReturnType<typeof getDb>;

export const BLOG_KEYWORD_PROPOSAL_TYPE = 'blog_keyword_proposal';
export type BlogKeywordOp = 'rename' | 'remove';

export interface BlogKeywordRequest { op: BlogKeywordOp; from: string; to: string | null }

export interface BlogKeywordCard {
    type: typeof BLOG_KEYWORD_PROPOSAL_TYPE;
    op: BlogKeywordOp;
    from: string;
    to: string | null;
    /** Rename onto a keyword the blog already uses: the two become one. */
    merge: boolean;
    /** Read from blog_posts — never the model's numbers. Archived articles don't count. */
    articles: number;
    published: number;
    /** Set when it can't be done; the card says it and offers no button. */
    blocked: string | null;
    settled?: boolean;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function blogKeywordFromUiElement(uiElement: unknown): BlogKeywordRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== BLOG_KEYWORD_PROPOSAL_TYPE) return null;
    const op = ui.op === 'rename' || ui.op === 'remove' ? ui.op : null;
    const from = cleanKeyword(ui.from);
    if (!op || !from) return null;
    if (op === 'remove') return { op, from, to: null };
    const to = cleanKeyword(ui.to);
    // A rename to nothing, or to itself, is not a proposal.
    if (!to || to === from) return null;
    return { op, from, to };
}

/** “retirement”, “money” — the keywords a blocked card offers instead. Pure. */
function inUse(rows: BlogKeywordRow[]): string {
    return rows.slice(0, 12).map((r) => `“${r.keyword}”`).join(', ');
}

/** Build the card from the blog's real keywords. Pure given the rows (tests call it directly). */
export function blogKeywordCardFrom(req: BlogKeywordRequest, rows: BlogKeywordRow[]): BlogKeywordCard {
    const row = rows.find((r) => r.keyword === req.from);
    const merge = req.op === 'rename' && rows.some((r) => r.keyword === req.to);
    const card: BlogKeywordCard = {
        type: BLOG_KEYWORD_PROPOSAL_TYPE, op: req.op, from: req.from, to: req.to, merge,
        articles: row?.articles ?? 0, published: row?.published ?? 0, blocked: null,
    };
    if (!row) {
        card.blocked = rows.length
            ? `No article uses the keyword “${req.from}”. The keywords your blog uses are ${inUse(rows)}.`
            : 'Your blog has no keywords yet, so there is nothing to change.';
    }
    return card;
}

export async function resolveBlogKeywordProposal(db: Db, organisationId: number, req: BlogKeywordRequest): Promise<BlogKeywordCard | null> {
    try {
        return blogKeywordCardFrom(req, await listBlogKeywords(db, organisationId));
    } catch (err) {
        console.error('[chat-blog-keywords] could not read the keywords (non-fatal)', err);
        return null;
    }
}

/**
 * Reopening a conversation: once `from` is no longer on any article, the change was made (here, in
 * Blog setup, or by hand) and the old button would do nothing — the card says so instead.
 */
export async function refreshBlogKeywordCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, messages: M[],
): Promise<M[]> {
    if (!messages.some((m) => (m.uiElement as { type?: unknown } | null)?.type === BLOG_KEYWORD_PROPOSAL_TYPE)) return messages;
    let rows: BlogKeywordRow[];
    try { rows = await listBlogKeywords(db, organisationId); }
    catch (err) { console.error('[chat-blog-keywords] could not refresh stored cards (non-fatal)', err); return messages; }
    return messages.map((m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== BLOG_KEYWORD_PROPOSAL_TYPE || ui.settled) return m;
        const req = blogKeywordFromUiElement(ui);
        if (!req || rows.some((r) => r.keyword === req.from)) return m;
        return { ...m, uiElement: { ...ui, settled: true, blocked: `Done — no article uses “${req.from}” any more.` } };
    });
}

/** The blog's keywords for the chat's snapshot: one line, most-used first. Pure. */
export function renderBlogKeywordsForChat(rows: BlogKeywordRow[]): string {
    if (!rows.length) return 'YOUR BLOG\'S KEYWORDS: none yet.';
    const list = rows.slice(0, 30).map((r) => `"${r.keyword}" (${r.articles} article${r.articles === 1 ? '' : 's'}${r.published ? `, ${r.published} live` : ''})`).join(', ');
    const more = rows.length > 30 ? ` …and ${rows.length - 30} more` : '';
    return `YOUR BLOG'S KEYWORDS (across every article, archived ones left out): ${list}${more}.`;
}
