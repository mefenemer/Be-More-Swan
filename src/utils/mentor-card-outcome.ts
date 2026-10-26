// src/utils/mentor-card-outcome.ts
// What the user did with a card the Business Mentor drew, so its next turn knows. The model is sent the
// TEXT of its earlier replies, never the card under them, so on staging (2026-10-26) it saw an empty
// Products & Services list after the user clicked "Remove this" and "corrected" itself: "there was no
// product for me to remove". Now the card's click (applied / failed / Not now / dismissed) is saved on
// the chat message (mentor.ts card_outcome) and the chat route adds one line under that reply.

import { sql } from 'drizzle-orm';

export const CARD_OUTCOMES = ['applied', 'failed', 'not_now', 'dismissed'] as const;
export type CardOutcome = typeof CARD_OUTCOMES[number];

export interface CardOutcomeRecord { status: CardOutcome; note: string | null; at?: string }

const NOTE_MAX = 300;

/** Pure: the request body checked. */
export function cleanCardOutcome(body: Record<string, unknown>): { ok: true; messageId: number; status: CardOutcome; note: string | null } | { ok: false; error: string } {
    const messageId = Number(body.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) return { ok: false, error: 'Which message?' };
    if (!(CARD_OUTCOMES as readonly string[]).includes(String(body.outcome))) return { ok: false, error: 'What happened to the card?' };
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, NOTE_MAX) : null;
    return { ok: true, messageId, status: body.outcome as CardOutcome, note };
}

/**
 * Save the outcome on the card's message: this user's own chat in this workspace, an assistant reply
 * that carries a card. A later click (a retry after a failure) replaces it. False when no such message.
 */
export async function recordCardOutcome(db: any, orgId: number, userId: number, o: { messageId: number; status: CardOutcome; note: string | null }): Promise<boolean> {
    const outcome = JSON.stringify({ status: o.status, note: o.note });
    const res = await db.execute(sql`
        UPDATE chat_messages m
           SET ui_element_json = m.ui_element_json || jsonb_build_object('outcome', ${outcome}::jsonb || jsonb_build_object('at', now()))
          FROM chat_sessions s
         WHERE m.id = ${o.messageId}
           AND m.chat_session_id = s.id
           AND s.organisation_id = ${orgId}
           AND s.user_id = ${userId}
           AND m.role = 'assistant'
           AND jsonb_typeof(m.ui_element_json) = 'object'
     RETURNING m.id`);
    const rows = Array.isArray(res) ? res : res?.rows ?? [];
    return rows.length > 0;
}

/** Pure: the line the model reads under an earlier reply that carried a card; null when it carried none. */
export function cardOutcomeLine(uiElement: unknown): string | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as { type?: unknown; summary?: unknown; outcome?: CardOutcomeRecord; answered?: unknown };
    if (typeof ui.type !== 'string') return null;
    const what = typeof ui.summary === 'string' && ui.summary.trim() ? `"${ui.summary.trim().slice(0, 200)}"` : `a ${ui.type} card`;
    const note = ui.outcome?.note ? ` (${ui.outcome.note})` : '';
    const status = ui.outcome?.status ?? (ui.answered === 'accepted' ? 'applied' : ui.answered === 'dismissed' ? 'dismissed' : null);
    const said = status === 'applied' ? `the user clicked it and it was saved${note}. That change has been made.`
        : status === 'failed' ? `the user clicked it but it failed${note}, so nothing changed.`
            : status === 'not_now' ? 'the user chose "Not now", so nothing changed.'
                : status === 'dismissed' ? 'the user dismissed it, so nothing changed.'
                    : 'the user has not answered it yet, so nothing has changed.';
    return `[Card under this reply: ${what} — ${said} Trust this over your own guess about what happened.]`;
}
