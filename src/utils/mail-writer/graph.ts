// src/utils/mail-writer/graph.ts — Outlook (Microsoft Graph) writes for approved Email Assistant actions.
// Delegated Mail.ReadWrite + Mail.Send. permanentDelete is never called.
//
// ⚠️ Graph gives a MOVED message a new id. archive/trash return it, and Undo moves that id back.

import type { ReplyTarget } from './index';

const GRAPH = 'https://graph.microsoft.com/v1.0/me';

export class GraphWriteError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

async function graphPost(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${GRAPH}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new GraphWriteError(res.status, `Graph ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/**
 * Reply in the thread. Graph's own reply endpoint picks the recipient (Reply-To, else From) — the same
 * address shown to the user — and quotes the original under the text.
 */
export async function graphSendReply(token: string, target: ReplyTarget, body: string): Promise<{ providerMessageId: string | null }> {
    await graphPost(`/messages/${encodeURIComponent(target.providerMessageId)}/reply`, token, { comment: body });
    return { providerMessageId: null }; // 202, no id
}

/** The same reply, left in Drafts for the user to finish in Outlook. */
export async function graphSaveReplyDraft(token: string, target: ReplyTarget, body: string): Promise<{ draftId: string | null }> {
    const out = await graphPost(`/messages/${encodeURIComponent(target.providerMessageId)}/createReply`, token, { comment: body });
    return { draftId: typeof out.id === 'string' ? out.id : null };
}

async function move(token: string, id: string, destinationId: string): Promise<{ movedProviderId: string }> {
    const out = await graphPost(`/messages/${encodeURIComponent(id)}/move`, token, { destinationId });
    if (typeof out.id !== 'string') throw new GraphWriteError(502, 'Graph returned no id for the moved message.');
    return { movedProviderId: out.id };
}

/** Archive = the mailbox's Archive folder (a well-known folder in Microsoft 365 and Outlook.com). */
export function graphArchive(token: string, id: string) { return move(token, id, 'archive'); }
/** Trash = Deleted Items (kept by the mailbox's own retention). */
export function graphTrash(token: string, id: string) { return move(token, id, 'deleteditems'); }

export async function graphRestore(token: string, movedProviderId: string, _from: 'archive' | 'trash'): Promise<{ providerMessageId: string }> {
    const { movedProviderId: back } = await move(token, movedProviderId, 'inbox');
    return { providerMessageId: back };
}
