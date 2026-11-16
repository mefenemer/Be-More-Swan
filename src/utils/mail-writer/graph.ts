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

// ── Categories (plan §2.1, D4) ───────────────────────────────────────────────────────────────────
// Outlook category "Swan: <Category>" on the message, keeping the user's own categories. Adding it to
// the user's colour list would need MailboxSettings.ReadWrite, which we don't ask for: it shows without
// a colour until they pick one in Outlook.

export const GRAPH_CATEGORY_PREFIX = 'Swan: ';

/** Pure: the user's categories with ours replaced by `category` (or removed, for null). */
export function mergeOutlookCategories(existing: readonly string[], category: string | null): string[] {
    const theirs = existing.filter((c) => !c.startsWith(GRAPH_CATEGORY_PREFIX));
    return category ? [...theirs, `${GRAPH_CATEGORY_PREFIX}${category}`] : theirs;
}

export function graphLabeller(token: string) {
    return {
        async set(messageId: string, category: string | null): Promise<void> {
            const res = await fetch(`${GRAPH}/messages/${encodeURIComponent(messageId)}?$select=categories`, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw new GraphWriteError(res.status, `Graph ${res.status}`);
            const cur = ((await res.json()) as { categories?: string[] }).categories ?? [];
            const next = mergeOutlookCategories(cur, category);
            if (next.length === cur.length && next.every((c, i) => c === cur[i])) return;
            const patch = await fetch(`${GRAPH}/messages/${encodeURIComponent(messageId)}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ categories: next }),
            });
            if (!patch.ok) throw new GraphWriteError(patch.status, `Graph ${patch.status}`);
        },
    };
}
