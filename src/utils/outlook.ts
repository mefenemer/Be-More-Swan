// src/utils/outlook.ts
// Send a plain-text email from the workspace's connected Outlook / Microsoft 365 account.
// The Microsoft counterpart to gmail.ts — used by the Lead Generator's auto-send-on-approval
// flow (lead-generation.ts) when the assistant's outreachEmailProvider is 'microsoft'.
//
// Graph takes a JSON message rather than Gmail's base64url MIME blob, so there is no MIME
// assembly here — but the same header-injection guard applies to the recipient and subject.
//
// getFreshAccessToken throws IntegrationError when Outlook isn't connected (or its refresh
// grant has been revoked); callers catch that to show a "connect your account" state rather
// than a hard error. Microsoft ROTATES refresh tokens on every use — that is handled inside
// workspace-integrations.ts, not here.

import { getFreshAccessToken } from './workspace-integrations';

type Db = Parameters<typeof getFreshAccessToken>[0];

export interface OutlookSendResult {
    /** Graph's sendMail returns 202 with no body, so there is no message id to surface. */
    accepted: true;
}

/**
 * Send an email via the org's connected Outlook account.
 * @throws IntegrationError when Outlook isn't connected (from getFreshAccessToken)
 * @throws Error when Graph rejects the send
 */
export async function sendOutlookMessage(
    db: Db,
    organisationId: number,
    msg: { to: string; subject: string; body: string; replyTo?: string; listUnsubscribe?: string },
): Promise<OutlookSendResult> {
    // Strip CR/LF for parity with the Gmail path — Graph is JSON so header smuggling isn't
    // possible the same way, but a newline in a recipient is malformed input regardless.
    const to = msg.to.replace(/[\r\n]+/g, ' ').trim();
    const subject = (msg.subject || '(no subject)').replace(/[\r\n]+/g, ' ').trim();
    const body = msg.body ?? '';
    if (!to) throw new Error('A recipient address is required to send.');

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'outlook');

    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject,
                body: { contentType: 'Text', content: body },
                toRecipients: [{ emailAddress: { address: to } }],
                // Per-thread inbound alias, so a reply routes back to THIS conversation rather
                // than to the sender's own mailbox where nothing would observe it.
                ...(msg.replyTo ? { replyTo: [{ emailAddress: { address: msg.replyTo.replace(/[\r\n]+/g, ' ').trim() } }] } : {}),
                // RFC 2369/8058. Graph exposes custom headers only through internetMessageHeaders,
                // and ONLY for names beginning `x-` or listed as allowed — List-Unsubscribe and
                // List-Unsubscribe-Post are both accepted. Values are CR/LF-stripped for parity
                // with the Gmail path even though Graph is JSON: a newline here is malformed input
                // regardless of whether this particular transport could be injected through.
                ...(msg.listUnsubscribe ? {
                    internetMessageHeaders: [
                        { name: 'List-Unsubscribe', value: msg.listUnsubscribe.replace(/[\r\n]+/g, ' ').trim() },
                        { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
                    ],
                } : {}),
            },
            // Keep a copy in the user's Sent Items — outreach should be visible in their own
            // mailbox, both so they can follow up in context and so nothing we send is hidden.
            saveToSentItems: true,
        }),
    });

    // Graph returns 202 Accepted with an EMPTY body on success — don't try to parse it.
    if (!res.ok) {
        const err: { error?: { code?: string; message?: string } } = await res.json().catch(() => ({}));
        const detail = err.error?.message || err.error?.code;
        throw new Error(`Outlook rejected the send${detail ? `: ${detail}` : '.'}`);
    }
    return { accepted: true };
}
