// src/utils/chat-message-action.ts
// The Social Media chat's hands on its Messages tab (Facebook Page + Instagram messages): draft a
// reply, send it as the business, or dismiss the conversation. The messages twin of
// chat-comment-action.ts. docs/meta-messages-plan.md, Phase 2.
//
// The model never acts. It proposes a `message_action_proposal`; this module checks it against the
// social_conversations row — this assistant's, this organisation's — and rebuilds the card from it.
// The click calls netlify/functions/social-messages.ts, the same endpoint as the tab's buttons, so
// the GUI and chat share one path. A card always shows the STORED messages and draft, never the
// model's words.
//
// ⚠️ Never throws.

import type { getDb } from '../../db/client';
import { conversationView, loadConversation, PLATFORM_LABEL, THREAD_MESSAGES } from './social-messages';
import { socialMessages } from '../../db/schema';
import { desc, eq } from 'drizzle-orm';

type Db = ReturnType<typeof getDb>;

export const MESSAGE_ACTION_PROPOSAL_TYPE = 'message_action_proposal';
export const MESSAGE_ACTIONS = ['draft', 'send', 'dismiss'] as const;
export type MessageAction = typeof MESSAGE_ACTIONS[number];

export interface MessageActionRequest {
    action: MessageAction;
    conversationId: number;
    instruction: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function messageActionFromUiElement(uiElement: unknown): MessageActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== MESSAGE_ACTION_PROPOSAL_TYPE) return null;
    const action = MESSAGE_ACTIONS.find((a) => a === ui.action);
    if (!action) return null;
    const id = Number(String(ui.conversationId ?? ui.id ?? '').replace(/^#/, ''));
    if (!Number.isInteger(id) || id <= 0) return null;
    const instruction = action === 'draft' && typeof ui.instruction === 'string' && ui.instruction.trim()
        ? ui.instruction.trim().slice(0, 600) : null;
    return { action, conversationId: id, instruction };
}

export interface MessageActionCard {
    type: typeof MESSAGE_ACTION_PROPOSAL_TYPE;
    action: MessageAction;
    assistantId: number;
    conversationId: number;
    platform: string;
    personLabel: string;
    /** The last few messages, oldest first, so the card shows what is being answered. */
    messages: { direction: 'in' | 'out'; body: string | null; attachmentType: string | null }[];
    windowClosesAt: string | null;
    draftReply: string | null;
    instruction: string | null;
    maxReplyChars: number;
    blocked: string | null;
    settled?: boolean;
}

/** Rebuild the card from the rows. Null when the conversation is not this assistant's. Never throws. */
export async function resolveMessageActionProposal(
    db: Db, organisationId: number, assistantId: number, req: MessageActionRequest,
): Promise<MessageActionCard | null> {
    try {
        const row = await loadConversation(db, organisationId, assistantId, req.conversationId);
        if (!row) return null;
        const msgs = await db.select().from(socialMessages).where(eq(socialMessages.conversationId, row.id))
            .orderBy(desc(socialMessages.sentAt)).limit(THREAD_MESSAGES);
        const c = conversationView(row, msgs);
        let blocked: string | null = null;
        if (req.action !== 'dismiss' && !c.windowOpen) blocked = `Meta only lets you reply within 24 hours of their last message, and that has passed — answer in the ${PLATFORM_LABEL[c.platform]} app instead.`;
        else if (req.action === 'dismiss' && c.status === 'dismissed') blocked = 'It’s already dismissed.';
        else if (req.action === 'send' && !c.draftReply) blocked = 'There’s no reply to send yet — ask me to draft one first.';
        return {
            type: MESSAGE_ACTION_PROPOSAL_TYPE, action: req.action, assistantId, conversationId: c.id,
            platform: PLATFORM_LABEL[c.platform], personLabel: c.personLabel,
            messages: c.messages.slice(-4).map((m) => ({ direction: m.direction, body: m.body, attachmentType: m.attachmentType })),
            windowClosesAt: c.windowClosesAt, draftReply: c.draftReply, instruction: req.instruction,
            maxReplyChars: c.maxReplyChars, blocked,
        };
    } catch (err) {
        console.error('[chat-message-action] could not resolve', err instanceof Error ? err.message : err);
        return null;
    }
}
