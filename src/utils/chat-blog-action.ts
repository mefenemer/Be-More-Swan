// src/utils/chat-blog-action.ts
// The Blog Writer chat's hands on articles that ALREADY exist: approve one (the assistant picks the
// time), book one for a time the user names, take one off the schedule, reject one with a reason,
// remove one nobody wants (archived, as the Blogs tab's Remove does), and make one shorter or longer
// (Blog Studio's two buttons — generate-blog { resize }, src/utils/blog-resize.ts).
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The blog chat could write drafts and read its whole list (content-snapshot.ts), but was
// told "you cannot schedule or publish from this chat" — Blog Studio was the only way. The home page
// promises "you just approve before anything goes out"; the chat could not approve. This is the blog
// twin of chat-post-action.ts (the Social chat's).
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// The model never acts. It proposes a `blog_action_proposal` naming an article by the "#id" its
// list shows. This module checks the proposal against the database — the article must be this
// assistant's, in this organisation, and in a state the action applies to — and replaces whatever
// the model said with what is true (title, status, current time). For "schedule" it also works out
// the exact time from the user's words NOW, so the card shows the instant the user is agreeing to.
// The card (disruptive-ui-registry.js) acts only on a click, and the click calls the SAME endpoints
// Blog Studio does (schedule-blog, reject-blog-post; blog-posts DELETE for remove), so their gates apply here too. Nothing here
// writes.
//
// There is no "publish now" action, deliberately: going live at once is the one step the chat
// leaves to Blog Studio, where the user is looking at the article.
//
// ⚠️ Never throws.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const BLOG_ACTION_PROPOSAL_TYPE = 'blog_action_proposal';
export const BLOG_ACTIONS = ['approve', 'schedule', 'unschedule', 'reject', 'remove', 'shorter', 'longer'] as const;
export type BlogAction = typeof BLOG_ACTIONS[number];

/** Which statuses each action applies to. Mirrors the Blogs tab's columns (assistants.js). */
const ACTIONABLE: Record<BlogAction, readonly string[]> = {
    // schedule-blog action:'approve' — an article in Review, or approved but never booked.
    approve: ['draft', 'pending_approval', 'in_review', 'approved'],
    // schedule-blog publishDate — Review, a move within Scheduled, and "Pick a new time" in Needs
    // attention. Never 'publishing' (it would race the publisher) or 'published'.
    schedule: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'failed', 'paused'],
    // schedule-blog action:'unschedule'.
    unschedule: ['scheduled'],
    // reject-blog-post's REJECTABLE.
    reject: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'],
    // blog-posts DELETE (archive): anything not live. Never 'publishing' — the bulk path refuses it.
    remove: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'failed', 'paused', 'rejected'],
    // generate-blog { resize } refuses a live or publishing article (the published copy would not
    // change) — so does the card.
    shorter: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'failed', 'paused'],
    longer: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'failed', 'paused'],
};

/** Said on the card when the article is not in a state the action applies to. */
const NOT_NOW: Record<BlogAction, string> = {
    approve: 'This article is not waiting for approval, so there is nothing to approve.',
    schedule: 'This article can’t be given a new time: it is live, publishing right now, or was turned down.',
    unschedule: 'This article isn’t booked to publish, so there is no schedule to clear.',
    reject: 'This article can no longer be rejected — it has already gone out, or was already turned down or archived.',
    remove: 'This article can’t be removed: it is live, publishing right now, or already archived.',
    shorter: 'This article can’t be rewritten now: it is live or publishing (unpublish it first), or it was turned down or archived.',
    longer: 'This article can’t be rewritten now: it is live or publishing (unpublish it first), or it was turned down or archived.',
};

const TITLE_MAX = 200;
const REASON_MAX = 500;
const WHEN_MAX = 300;

export interface BlogActionRequest {
    action: BlogAction;
    postId: number;
    /** Reject: what is wrong, in the user's terms. */
    reason: string | null;
    /** Schedule: the time in the user's own words. */
    when: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function blogActionFromUiElement(uiElement: unknown): BlogActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== BLOG_ACTION_PROPOSAL_TYPE) return null;
    const action = BLOG_ACTIONS.find((a) => a === ui.action);
    const postId = Number(String(ui.postId ?? '').replace(/^#/, ''));
    if (!action || !Number.isInteger(postId) || postId <= 0) return null;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const when = str(ui.when, WHEN_MAX);
    // A schedule with no time is not a proposal.
    if (action === 'schedule' && !when) return null;
    return {
        action,
        postId,
        reason: action === 'reject' ? str(ui.reason, REASON_MAX) : null,
        when: action === 'schedule' ? when : null,
    };
}

export interface BlogActionCard {
    type: typeof BLOG_ACTION_PROPOSAL_TYPE;
    action: BlogAction;
    postId: number;
    title: string;
    status: string;
    /** ISO — when it is booked for now, if it is. */
    publishDate: string | null;
    /** Schedule: the ISO instant the click books it for, worked out from `when`. */
    scheduleAt: string | null;
    timezone: string | null;
    reason: string | null;
    when: string | null;
    /** Set when the action does not apply; the card says it and offers no button. */
    blocked: string | null;
    settled?: boolean;
}

/** Reads the user's words as a time in `timezone`. Injected so tests never call the AI service. */
export type ParseWhen = (when: string, now: Date, timezone: string) => Promise<Date | null>;

/**
 * Check a proposal against the database and return the card the user confirms — built only from
 * rows, never from the model's description. Null when the article is not this assistant's.
 */
export async function resolveBlogActionProposal(
    db: Db, organisationId: number, aiAssistantId: number, req: BlogActionRequest,
    timezone: string | null | undefined, parseWhen: ParseWhen, now: Date = new Date(),
): Promise<BlogActionCard | null> {
    try {
        const [post] = await db.select({
            id: blogPosts.id, status: blogPosts.status, title: blogPosts.title, publishDate: blogPosts.publishDate,
        })
            .from(blogPosts)
            .where(and(eq(blogPosts.id, req.postId), eq(blogPosts.organisationId, organisationId), eq(blogPosts.assistantId, aiAssistantId)))
            .limit(1);
        if (!post) return null;

        const title = String(post.title ?? '').replace(/\s+/g, ' ').trim();
        const card: BlogActionCard = {
            type: BLOG_ACTION_PROPOSAL_TYPE,
            action: req.action,
            postId: post.id,
            title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
            status: post.status,
            publishDate: post.publishDate ? new Date(post.publishDate).toISOString() : null,
            scheduleAt: null,
            timezone: timezone ?? null,
            reason: req.reason,
            when: req.when,
            blocked: ACTIONABLE[req.action].includes(post.status) ? null : NOT_NOW[req.action],
        };

        if (!card.blocked && req.action === 'schedule' && req.when) {
            let at: Date | null = null;
            try { at = await parseWhen(req.when, now, timezone || 'Europe/London'); }
            catch (err) {
                console.error('[chat-blog-action] could not read the time (non-fatal)', err);
                card.blocked = 'I couldn’t work out the time just now. Try again, or pick it in Blog Studio.';
                return card;
            }
            if (!at) card.blocked = `I couldn’t work out a time from “${req.when}”. Say a day and a time, e.g. “Friday at 9am”.`;
            else if (at.getTime() <= now.getTime()) card.blocked = 'That time has already passed. Pick one in the future.';
            else card.scheduleAt = at.toISOString();
        }
        return card;
    } catch (err) {
        console.error('[chat-blog-action] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

// ── Reopening a conversation ─────────────────────────────────────────────────────────────────────
// A stored card comes back on every reload. Once its article has been dealt with, the old button
// would be refused by the endpoint and read like an error — so a stored card is checked again and,
// when it no longer applies, says what happened instead. Never re-reads the time: the card keeps the
// instant the user was shown, and one that has since passed is closed rather than silently moved.

const NOW_WORDS: Record<string, string> = {
    draft: 'waiting for approval', pending_approval: 'waiting for approval', in_review: 'waiting for approval',
    approved: 'approved but not booked', scheduled: 'booked to publish', publishing: 'publishing right now',
    paused: 'paused', published: 'published', failed: 'failed to publish', rejected: 'turned down', archived: 'archived',
};

/** Re-check every stored blog_action_proposal in a transcript. Mutates nothing it is given. */
export async function refreshBlogActionCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[], now: Date = new Date(),
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== BLOG_ACTION_PROPOSAL_TYPE) return m;
        const req = blogActionFromUiElement(ui);
        if (!req) return m;
        try {
            const [post] = await db.select({ id: blogPosts.id, status: blogPosts.status })
                .from(blogPosts)
                .where(and(eq(blogPosts.id, req.postId), eq(blogPosts.organisationId, organisationId), eq(blogPosts.assistantId, aiAssistantId)))
                .limit(1);
            if (!post) return { ...m, uiElement: { ...ui, settled: true, blocked: 'This article no longer exists.' } };
            if (!ACTIONABLE[req.action].includes(post.status)) {
                return { ...m, uiElement: { ...ui, status: post.status, settled: true, blocked: `Already dealt with — this article is now ${NOW_WORDS[post.status] ?? post.status}.` } };
            }
            const at = typeof ui.scheduleAt === 'string' ? new Date(ui.scheduleAt) : null;
            if (req.action === 'schedule' && at && at.getTime() <= now.getTime()) {
                return { ...m, uiElement: { ...ui, status: post.status, settled: true, blocked: 'That time has passed. Ask again with a new one.' } };
            }
            return { ...m, uiElement: { ...ui, status: post.status } };
        } catch (err) {
            console.error('[chat-blog-action] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
