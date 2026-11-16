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
