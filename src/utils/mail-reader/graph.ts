// src/utils/mail-reader/graph.ts — reading an Outlook inbox through Microsoft Graph (plan §4.1, §4.3).
//
// Phase 1 polls with a DELTA QUERY on the Inbox (change notifications come in Phase 3). The first call
// asks for the last FIRST_SORT_DAYS days only; every later call starts from the saved delta link and
// gets only what changed. A run that hits its time budget saves the page link it reached and the next
// run resumes from there.
//
// What this reads: headers (sender, subject, date, read flag, link, conversation) for every inbox email,
// and the body ONLY of an email being sorted by AI or opened by its owner — returned to the caller,
// never stored (mailbox_messages has no body column).

import type { MailMessageMeta, MailChanges } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Plan D6: the first sort covers the last 14 days, no older. */
export const FIRST_SORT_DAYS = 14;
const SELECT = 'subject,from,receivedDateTime,isRead,webLink,conversationId,inferenceClassification';

export class GraphError extends Error {
    constructor(public status: number, message: string, public retryAfterSec: number | null = null) { super(message); }
}

async function graphGet(url: string, accessToken: string, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders } });
    if (!res.ok) {
        const retry = Number(res.headers.get('retry-after'));
        throw new GraphError(res.status, `Graph ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return res.json() as Promise<Record<string, unknown>>;
}

/** The first delta URL: the Inbox, newest first, from FIRST_SORT_DAYS ago. Pure. */
export function initialDeltaUrl(now: Date = new Date()): string {
    const since = new Date(now.getTime() - FIRST_SORT_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
    return `${GRAPH}/me/mailFolders('inbox')/messages/delta?$select=${SELECT}&$filter=${filter}&$orderby=${encodeURIComponent('receivedDateTime desc')}`;
}

/** One Graph message as our shape. A delta "@removed" entry becomes { removed: true }. Pure. */
export function normaliseGraphMessage(m: Record<string, unknown>): MailMessageMeta {
    const from = (m.from as { emailAddress?: { name?: string; address?: string } } | undefined)?.emailAddress;
    return {
        id: String(m.id ?? ''),
        removed: Boolean(m['@removed']),
        threadId: typeof m.conversationId === 'string' ? m.conversationId : null,
        fromName: typeof from?.name === 'string' ? from.name.slice(0, 200) : null,
        fromAddress: typeof from?.address === 'string' ? from.address.toLowerCase().slice(0, 320) : null,
        subject: typeof m.subject === 'string' ? m.subject.slice(0, 500) : null,
        receivedAt: typeof m.receivedDateTime === 'string' ? new Date(m.receivedDateTime) : null,
        isRead: m.isRead === true,
        webLink: typeof m.webLink === 'string' ? m.webLink : null,
        providerFolderHint: m.inferenceClassification === 'other' ? 'other' : m.inferenceClassification === 'focused' ? 'focused' : null,
    };
}

/**
 * Read the inbox's changes from `cursor` (a saved delta or next link; null = first sort).
 * Stops when it reaches the delta link, or when `deadline` passes — then `cursor` is the page to
 * resume from and `complete` is false.
 */
export async function listGraphChanges(accessToken: string, cursor: string | null, deadline: number): Promise<MailChanges> {
    let url = cursor && cursor.startsWith(GRAPH) ? cursor : initialDeltaUrl();
    const messages: MailMessageMeta[] = [];
    for (;;) {
        const page = await graphGet(url, accessToken, { Prefer: 'odata.maxpagesize=50' });
        for (const m of (page.value as Record<string, unknown>[] | undefined) ?? []) {
            const n = normaliseGraphMessage(m);
            if (n.id) messages.push(n);
        }
        const next = page['@odata.nextLink'];
        const delta = page['@odata.deltaLink'];
        if (typeof delta === 'string') return { messages, cursor: delta, complete: true };
        if (typeof next !== 'string') return { messages, cursor: url, complete: true };
        url = next;
        if (Date.now() > deadline) return { messages, cursor: url, complete: false };
    }
}

/** The headers that tell bulk mail and automatic replies apart, for one message (lower-cased names). */
export async function getGraphHeaders(accessToken: string, messageId: string): Promise<Record<string, string>> {
    const data = await graphGet(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=internetMessageHeaders`, accessToken);
    const out: Record<string, string> = {};
    for (const h of (data.internetMessageHeaders as { name?: string; value?: string }[] | undefined) ?? []) {
        if (h.name && typeof h.value === 'string') out[h.name.toLowerCase()] = h.value.slice(0, 500);
    }
    return out;
}

/** An email's text, for AI sorting or for its owner to read. Returned, never stored. */
export async function getGraphBodyText(accessToken: string, messageId: string): Promise<{ text: string; to: string[] }> {
    const data = await graphGet(
        `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=body,toRecipients`,
        accessToken,
        { Prefer: 'outlook.body-content-type="text"' },
    );
    const body = (data.body as { content?: string } | undefined)?.content ?? '';
    const to = ((data.toRecipients as { emailAddress?: { address?: string } }[] | undefined) ?? [])
        .map((r) => r.emailAddress?.address ?? '').filter(Boolean);
    return { text: body, to };
}
