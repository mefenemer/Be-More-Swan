// Meeting Note Taker: which inbox a meeting's follow-up email goes from (docs/meeting-note-taker-finish-plan.md
// step 7, owner decision 4). In order:
//   1. the workspace's connected Gmail      — the user's own inbox
//   2. the workspace's connected Outlook    — the user's own inbox (an Outlook-only workspace)
//   3. Resend, from Be More Swan's address  — only when no inbox is connected. The sender NAME is the
//      business, Reply-To is the person who approved the meeting (replies reach them, not us), and the
//      meeting is stamped so the Inbox can say "connect Gmail or Outlook to send from your own".
// A sender that is not connected throws IntegrationError and the next is tried; any other failure
// (the provider refused the send) stops here, so one email never goes out twice from two accounts.
// The senders are passed in, so tests/meeting-followup-send.test.ts can stub each one.

import { IntegrationError } from './workspace-integrations';

export type FollowupVia = 'gmail' | 'outlook' | 'resend' | 'dev';

export interface FollowupMessage {
    recipients: string[];
    subject: string;
    body: string;
    /** The workspace's business name: the From name on the Resend fallback. */
    businessName: string;
    /** The approving user's address: Reply-To on the Resend fallback. Null when unknown. */
    replyTo: string | null;
}

export interface FollowupSenders {
    gmail: (m: { to: string; subject: string; body: string }) => Promise<{ id?: string | null }>;
    outlook: (m: { to: string; subject: string; body: string }) => Promise<unknown>;
    /** Null when RESEND_API_KEY is not set (local dev): nothing is sent. */
    resend: ((m: { from: string; to: string[]; subject: string; text: string; replyTo?: string }) => Promise<{ id?: string | null; error?: string | null }>) | null;
    fromDomain: string;
}

export interface FollowupResult { via: FollowupVia; id: string | null }

/** The Resend From line: the business's name on our outbound address. Quotes and angle brackets removed. */
export function resendFromLine(businessName: string, fromDomain: string): string {
    const name = businessName.replace(/[\r\n"<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Your Be More Swan assistant';
    return `"${name}" <assistant@${fromDomain}>`;
}

const notConnected = (err: unknown) => err instanceof IntegrationError;

/**
 * Send the follow-up from the first connected inbox, else from Be More Swan's address.
 * @throws Error when a connected inbox, or Resend, refuses the send.
 */
export async function sendMeetingFollowup(msg: FollowupMessage, senders: FollowupSenders): Promise<FollowupResult> {
    // One message to all attendees — they were in the meeting together, so a shared To line is expected.
    const own = { to: msg.recipients.join(', '), subject: msg.subject, body: msg.body };
    try {
        const sent = await senders.gmail(own);
        return { via: 'gmail', id: sent?.id ?? null };
    } catch (err) {
        if (!notConnected(err)) throw err;
    }
    try {
        await senders.outlook(own);
        return { via: 'outlook', id: null }; // Graph's sendMail returns no message id
    } catch (err) {
        if (!notConnected(err)) throw err;
    }
    if (!senders.resend) return { via: 'dev', id: null };
    const result = await senders.resend({
        from: resendFromLine(msg.businessName, senders.fromDomain),
        to: msg.recipients,
        subject: msg.subject,
        text: msg.body,
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    if (result?.error) throw new Error(`The follow-up email could not be sent: ${result.error}`);
    return { via: 'resend', id: result?.id ?? null };
}

/** What the Inbox and the sync log say about a send. */
export function followupSentMessage(via: FollowupVia, count: number): string {
    const who = `${count} attendee${count === 1 ? '' : 's'}`;
    if (via === 'gmail') return `Follow-up sent to ${who} from your Gmail.`;
    if (via === 'outlook') return `Follow-up sent to ${who} from your Outlook.`;
    if (via === 'resend') return `Follow-up sent to ${who} from Be More Swan’s address because no inbox is connected — replies come to you. Connect Gmail or Outlook to send from your own.`;
    return `Follow-up prepared for ${who} (dev mode — not actually sent).`;
}
