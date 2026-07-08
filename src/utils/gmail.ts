// src/utils/gmail.ts
// Send a plain-text email from the workspace's connected Gmail account. Mirrors the MIME
// assembly in sync-action.ts's handleGmailCreateDraft, but hits messages/send instead of
// drafts — used by the Lead Generator's auto-send-on-approval flow (lead-generation.ts).
//
// The existing 'gmail' OAuth grant uses the gmail.compose scope, which Google documents as
// covering "send messages and drafts" — so sending needs no extra scope or re-consent.
// getFreshAccessToken throws IntegrationError when Gmail isn't connected; callers catch that
// to surface a "connect your account" state rather than a hard error.

import { getFreshAccessToken } from './workspace-integrations';

type Db = Parameters<typeof getFreshAccessToken>[0];

/** RFC 2047 B-encode a header value so non-ASCII subjects survive the MIME round trip. */
function encodeMimeHeader(value: string): string {
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface GmailSendResult { id: string; threadId?: string }

/**
 * Send an email via the org's connected Gmail account.
 * @throws IntegrationError when Gmail isn't connected (from getFreshAccessToken)
 * @throws Error when the Gmail API rejects the send
 */
export async function sendGmailMessage(
    db: Db,
    organisationId: number,
    msg: { to: string; subject: string; body: string },
): Promise<GmailSendResult> {
    // Strip CR/LF so field values can never smuggle extra MIME headers.
    const to = msg.to.replace(/[\r\n]+/g, ' ').trim();
    const subject = (msg.subject || '(no subject)').replace(/[\r\n]+/g, ' ').trim();
    const body = msg.body ?? '';
    if (!to) throw new Error('A recipient address is required to send.');

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'gmail');

    const mime = [
        `To: ${to}`,
        `Subject: ${encodeMimeHeader(subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(body, 'utf8').toString('base64'),
    ].join('\r\n');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
    });
    if (!res.ok) {
        const err: { error?: { message?: string } } = await res.json().catch(() => ({}));
        throw new Error(`Gmail rejected the send${err.error?.message ? `: ${err.error.message}` : '.'}`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
    return { id: data.id ?? '', threadId: data.threadId };
}
