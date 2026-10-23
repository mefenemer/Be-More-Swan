// src/utils/chat-post-action.ts
// The Social Media chat's hands on posts that ALREADY exist: approve, reject, try a failed one
// again, move one to another time, and remove one nobody wants.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The chat could draft new posts and read its whole queue (content-snapshot.ts), but told
// the user it could not approve, reject, retry or reschedule any of them — the Posts tab was the
// only way, so "approve Thursday's post" got a refusal and directions.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// The model never acts. It proposes a `post_action_proposal` naming a post by the "#id" its post
// list shows. This module checks that proposal against the database — the post must be this
// assistant's, in this organisation, and in a state the action applies to — and replaces whatever
// the model said about the post with what is actually true (its platforms, status, time, wording).
// The card in disruptive-ui-registry.js shows those facts; only the user's click acts, and the click
// calls the SAME endpoints the Posts tab does (approve-post, reject-post, retry-failed-post,
// reschedule-post-chat, scheduled-posts DELETE for remove), so every gate those apply — a disconnected account, an open compliance
// warning, a time in the past — applies here too. Nothing here writes.
//
// A cross-post is one post on several platforms, one row each. The Posts tab acts on the whole
// group, so the card does too: `postIds` are the rows of the group that the action applies to.
//
// ⚠️ Never throws.

import { and, eq, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const POST_ACTION_PROPOSAL_TYPE = 'post_action_proposal';
export const POST_ACTIONS = ['approve', 'reject', 'retry', 'reschedule', 'remove'] as const;
export type PostAction = typeof POST_ACTIONS[number];

/** Which rows each action applies to — the statuses its endpoint accepts. */
const ACTIONABLE: Record<PostAction, readonly string[]> = {
    // approve-post: draft / in_review / pending_approval only.
    approve: ['draft', 'pending_approval', 'in_review'],
    // reject-post refuses rejected / published / cancelled and takes the group itself; listed
    // positively here so a publishing or failed row is never offered for rejection from chat.
    reject: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'paused', 'paused_credits'],
    // retry-failed-post: 'failed' only.
    retry: ['failed'],
    // reschedule-post-chat: RESCHEDULABLE.
    reschedule: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'],
    // scheduled-posts DELETE (the Review tab's Remove): anything not yet out. 'publishing' is left
    // off — it is mid-send, and the bulk path refuses it too.
    remove: ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'paused', 'paused_credits', 'failed'],
};

/** Said on the card when the post is not in a state the action applies to. */
const NOT_NOW: Record<PostAction, string> = {
    approve: 'This post is not waiting for approval, so there is nothing to approve.',
    reject: 'This post can no longer be rejected — it has already gone out, or was already turned down.',
    retry: 'Only a post that failed to publish can be tried again.',
    reschedule: 'This post can’t be moved: it has gone out, failed, or is publishing right now. A failed post is tried again instead — ask to try it again at the time you want.',
    remove: 'This post can’t be removed: it has already gone out, is publishing right now, or was already removed or rejected.',
};

const TEXT_MAX = 200;
const REASON_MAX = 500;
const WHEN_MAX = 300; // reschedule-post-chat's own instruction limit

export interface PostActionRequest {
    action: PostAction;
    postId: number;
    /** Reject: what is wrong, in the user's terms. Becomes the redraft's steer (and a rule, if kept). */
    reason: string | null;
    /** Reschedule (required) or retry (optional): the time in the user's own words. reschedule-post-chat
     *  or retry-failed-post reads it; a retry without one goes out on the next run. */
    when: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function postActionFromUiElement(uiElement: unknown): PostActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== POST_ACTION_PROPOSAL_TYPE) return null;
    const action = POST_ACTIONS.find((a) => a === ui.action);
    const postId = Number(String(ui.postId ?? '').replace(/^#/, ''));
    if (!action || !Number.isInteger(postId) || postId <= 0) return null;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const reason = str(ui.reason, REASON_MAX);
    const when = str(ui.when, WHEN_MAX);
    // An action that cannot be carried out without its input is not a proposal.
    if (action === 'reschedule' && !when) return null;
    return { action, postId, reason: action === 'reject' ? reason : null, when: action === 'reschedule' || action === 'retry' ? when : null };
}

export interface PostActionCard {
    type: typeof POST_ACTION_PROPOSAL_TYPE;
    action: PostAction;
    /** The row the card opens in the Posts tab, and the one reject-post is called with. */
    postId: number;
    /** Rows of the group the action applies to. Empty when `blocked`. */
    postIds: number[];
    platforms: string[];
    status: string;
    /** ISO. */
    publishDate: string | null;
    timezone: string | null;
    text: string;
    reason: string | null;
    when: string | null;
    /** Set when the action does not apply to this post; the card says it and offers no button. */
    blocked: string | null;
}

/**
 * Check a proposal against the database and return the card the user confirms — built only from
 * rows, never from the model's description. Null when the post is not this assistant's (or does
 * not exist): the card would otherwise offer to act on something the user cannot see.
 */
export async function resolvePostActionProposal(
    db: Db, organisationId: number, aiAssistantId: number, req: PostActionRequest, timezone?: string | null,
): Promise<PostActionCard | null> {
    try {
        const [post] = await db.select({
            id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform,
            publishDate: scheduledPosts.publishDate, caption: scheduledPosts.caption, crosspostGroupId: scheduledPosts.crosspostGroupId,
        })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, req.postId), eq(scheduledPosts.organisationId, organisationId), eq(scheduledPosts.assistantId, aiAssistantId)))
            .limit(1);
        if (!post) return null;

        const group = post.crosspostGroupId
            ? await db.select({ id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform })
                .from(scheduledPosts)
                .where(and(
                    eq(scheduledPosts.organisationId, organisationId),
                    eq(scheduledPosts.assistantId, aiAssistantId),
                    or(eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId), eq(scheduledPosts.id, post.id)),
                ))
            : [{ id: post.id, status: post.status, platform: post.platform }];

        const allowed = ACTIONABLE[req.action];
        const rows = group.filter((r) => allowed.includes(r.status));
        // Named row first: it is the one reschedule-post-chat reads the user's words for, and the
        // others are aligned to the time it resolves (as the review modal does).
        rows.sort((a, b) => (a.id === post.id ? -1 : b.id === post.id ? 1 : a.id - b.id));
        const gist = String(post.caption ?? '').replace(/\s+/g, ' ').trim();

        return {
            type: POST_ACTION_PROPOSAL_TYPE,
            action: req.action,
            postId: rows[0]?.id ?? post.id,
            postIds: rows.map((r) => r.id),
            platforms: [...new Set((rows.length ? rows : [post]).map((r) => r.platform))],
            status: post.status,
            publishDate: post.publishDate ? new Date(post.publishDate).toISOString() : null,
            timezone: timezone ?? null,
            text: gist.length > TEXT_MAX ? `${gist.slice(0, TEXT_MAX)}…` : gist,
            reason: req.reason,
            when: req.when,
            blocked: rows.length ? null : NOT_NOW[req.action],
        };
    } catch (err) {
        console.error('[chat-post-action] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

// ── Reopening a conversation ─────────────────────────────────────────────────────────────────────
// A card is stored with the message and comes back on every reload. Once its post has been dealt
// with — approved, rejected, moved, published — pressing the old button was refused by the endpoint
// and read like an error. So a stored card is checked again when the conversation is loaded, and one
// that no longer applies says what happened to the post instead of offering a button.

const NOW_WORDS: Record<string, string> = {
    draft: 'waiting for approval', pending_approval: 'waiting for approval', in_review: 'waiting for approval',
    approved: 'booked to publish', scheduled: 'booked to publish', publishing: 'publishing right now',
    paused: 'paused', paused_credits: 'paused', published: 'published', failed: 'failed to publish',
    rejected: 'rejected', cancelled: 'withdrawn',
};

/** Re-check every stored post_action_proposal in a transcript. Mutates nothing it is given. */
export async function refreshPostActionCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== POST_ACTION_PROPOSAL_TYPE) return m;
        const req = postActionFromUiElement(ui);
        if (!req) return m;
        const tz = typeof ui.timezone === 'string' ? ui.timezone : null;
        const now = await resolvePostActionProposal(db, organisationId, aiAssistantId, req, tz);
        // `settled` tells the card this is history, not a refusal: its header says so.
        if (!now) return { ...m, uiElement: { ...ui, postIds: [], settled: true, blocked: 'This post no longer exists.' } };
        if (now.blocked) {
            return { ...m, uiElement: { ...now, settled: true, blocked: `Already dealt with — this post is now ${NOW_WORDS[now.status] ?? now.status}.` } };
        }
        return { ...m, uiElement: now };
    }));
}
