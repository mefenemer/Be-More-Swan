// src/utils/mail-writer/gmail.ts — Gmail writes for approved Email Assistant actions (see index.ts).
// Scope: gmail.modify covers send, drafts, labels and trash. Permanent delete is never called.

import type { ReplyTarget } from './index';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailWriteError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

async function gmailPost(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${GMAIL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new GmailWriteError(res.status, `Gmail ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/** RFC 2047 for a header with non-ASCII text (a subject with "£" or an accent). Pure. */
function encodeHeader(value: string): string {
    // eslint-disable-next-line no-control-regex
    return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Strip CR/LF so nothing in a value can start a new header (header injection). Pure. */
function oneLine(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * The raw RFC 2822 reply, base64url, threaded with In-Reply-To / References. Pure.
 * Plain text, UTF-8, base64 body — so any character the user typed survives.
 */
export function buildRawReply(target: ReplyTarget, body: string): string {
    const refs = [target.references, target.inReplyTo].filter(Boolean).join(' ').trim();
    const headers = [
        `From: ${oneLine(target.from)}`,
        `To: ${oneLine(target.to)}`,
        `Subject: ${encodeHeader(oneLine(target.subject))}`,
        ...(target.inReplyTo ? [`In-Reply-To: ${oneLine(target.inReplyTo)}`] : []),
        ...(refs ? [`References: ${oneLine(refs)}`] : []),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
    ];
    const encodedBody = Buffer.from(body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${encodedBody}`, 'utf8').toString('base64url');
}

export async function gmailSendReply(token: string, target: ReplyTarget, body: string): Promise<{ providerMessageId: string | null }> {
    const out = await gmailPost('/messages/send', token, { raw: buildRawReply(target, body), ...(target.threadId ? { threadId: target.threadId } : {}) });
    return { providerMessageId: typeof out.id === 'string' ? out.id : null };
}

export async function gmailSaveReplyDraft(token: string, target: ReplyTarget, body: string): Promise<{ draftId: string | null }> {
    const out = await gmailPost('/drafts', token, { message: { raw: buildRawReply(target, body), ...(target.threadId ? { threadId: target.threadId } : {}) } });
    return { draftId: typeof out.id === 'string' ? out.id : null };
}

/** Archive = take the INBOX label off. The message stays in All Mail; its id doesn't change. */
export async function gmailArchive(token: string, id: string): Promise<{ movedProviderId: string }> {
    await gmailPost(`/messages/${encodeURIComponent(id)}/modify`, token, { removeLabelIds: ['INBOX'] });
    return { movedProviderId: id };
}

/** Trash (Gmail empties it after 30 days). Never messages.delete. */
export async function gmailTrash(token: string, id: string): Promise<{ movedProviderId: string }> {
    await gmailPost(`/messages/${encodeURIComponent(id)}/trash`, token, undefined);
    return { movedProviderId: id };
}

/** Back into the inbox: out of trash first when it was trashed, then the INBOX label back on. */
export async function gmailRestore(token: string, id: string, from: 'archive' | 'trash'): Promise<{ providerMessageId: string }> {
    if (from === 'trash') await gmailPost(`/messages/${encodeURIComponent(id)}/untrash`, token, undefined);
    await gmailPost(`/messages/${encodeURIComponent(id)}/modify`, token, { addLabelIds: ['INBOX'] });
    return { providerMessageId: id };
}

// ── Categories as labels (plan §2.1, D4) ─────────────────────────────────────────────────────────
// Each category is a nested label under "Swan/" (e.g. "Swan/Needs a reply"), created on first use. A
// label never moves or removes an email, so it needs no per-email approval; the owner can turn it off.

export const GMAIL_LABEL_PREFIX = 'Swan/';

async function gmailGet(path: string, token: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new GmailWriteError(res.status, `Gmail ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
}

/** A labeller for one run: looks the Swan labels up once, creates any missing, then sets one per email. */
export function gmailLabeller(token: string) {
    let byName: Map<string, string> | null = null;
    const load = async () => {
        if (byName) return byName;
        const out = await gmailGet('/labels', token);
        byName = new Map(((out.labels as { id: string; name: string }[] | undefined) ?? []).map((l) => [l.name, l.id]));
        return byName;
    };
    const idFor = async (name: string): Promise<string> => {
        const map = await load();
        const have = map.get(name);
        if (have) return have;
        const created = await gmailPost('/labels', token, { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
        const id = String(created.id ?? '');
        if (!id) throw new GmailWriteError(502, 'Gmail returned no label id.');
        map.set(name, id);
        return id;
    };
    return {
        /** Put exactly one Swan label on the email (or none, for null), leaving every other label alone. */
        async set(messageId: string, category: string | null): Promise<void> {
            const map = await load();
            const ours = [...map.entries()].filter(([n]) => n.startsWith(GMAIL_LABEL_PREFIX));
            const add = category ? await idFor(`${GMAIL_LABEL_PREFIX}${category}`) : null;
            const remove = ours.map(([, id]) => id).filter((id) => id !== add);
            await gmailPost(`/messages/${encodeURIComponent(messageId)}/modify`, token, { ...(add ? { addLabelIds: [add] } : {}), removeLabelIds: remove });
        },
    };
}
