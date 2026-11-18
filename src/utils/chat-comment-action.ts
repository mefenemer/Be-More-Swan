// src/utils/chat-comment-action.ts
// The Social Media chat's hands on its Comments tab: draft a reply to a LinkedIn Page comment, post
// the reply as the Page, or dismiss the comment. The comments twin of chat-discussion-action.ts.
//
// The model never acts. It proposes a `comment_action_proposal`; this module checks it against the
// page_comments row — this assistant's, this organisation's — and rebuilds the card from it. The
// click calls netlify/functions/page-comments.ts, the same endpoint as the tab's buttons, so the GUI
// and chat share one path. A card always shows the STORED comment and draft, never the model's words.
//
// ⚠️ Never throws.

import type { getDb } from '../../db/client';
import { commentView, loadComment, MAX_REPLY_CHARS } from './page-comments';

type Db = ReturnType<typeof getDb>;

export const COMMENT_ACTION_PROPOSAL_TYPE = 'comment_action_proposal';
export const COMMENT_ACTIONS = ['draft', 'post_reply', 'dismiss'] as const;
export type CommentAction = typeof COMMENT_ACTIONS[number];

export interface CommentActionRequest {
    action: CommentAction;
    commentId: number;
    instruction: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function commentActionFromUiElement(uiElement: unknown): CommentActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== COMMENT_ACTION_PROPOSAL_TYPE) return null;
    const action = COMMENT_ACTIONS.find((a) => a === ui.action);
    if (!action) return null;
    const id = Number(String(ui.commentId ?? ui.id ?? '').replace(/^#/, ''));
    if (!Number.isInteger(id) || id <= 0) return null;
    const instruction = action === 'draft' && typeof ui.instruction === 'string' && ui.instruction.trim()
        ? ui.instruction.trim().slice(0, 600) : null;
    return { action, commentId: id, instruction };
}

export interface CommentActionCard {
    type: typeof COMMENT_ACTION_PROPOSAL_TYPE;
    action: CommentAction;
    assistantId: number;
    commentId: number;
    authorName: string;
    body: string;
    postExcerpt: string | null;
    linkedInUrl: string | null;
    draftReply: string | null;
    instruction: string | null;
    maxReplyChars: number;
    blocked: string | null;
    settled?: boolean;
}

/** Rebuild the card from the row. Null when the comment is not this assistant's. Never throws. */
export async function resolveCommentActionProposal(
    db: Db, organisationId: number, assistantId: number, req: CommentActionRequest,
): Promise<CommentActionCard | null> {
    try {
        const row = await loadComment(db, organisationId, assistantId, req.commentId);
        if (!row) return null;
        const c = commentView(row.c, row.caption);
        let blocked: string | null = null;
        if (c.status === 'replied') blocked = 'This comment already has a reply.';
        else if (req.action === 'dismiss' && c.status === 'dismissed') blocked = 'It’s already dismissed.';
        else if (req.action === 'post_reply' && !c.draftReply) blocked = 'There’s no reply to post yet — ask me to draft one first.';
        return {
            type: COMMENT_ACTION_PROPOSAL_TYPE, action: req.action, assistantId, commentId: c.id,
            authorName: c.authorName, body: c.body, postExcerpt: c.postExcerpt, linkedInUrl: c.linkedInUrl,
            draftReply: c.draftReply, instruction: req.instruction, maxReplyChars: MAX_REPLY_CHARS, blocked,
        };
    } catch (err) {
        console.error('[chat-comment-action] could not resolve', err instanceof Error ? err.message : err);
        return null;
    }
}
