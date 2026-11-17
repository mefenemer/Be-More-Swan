// Meeting Note Taker: which inbox a meeting's follow-up email goes from (docs/meeting-note-taker-finish-plan.md
// step 7). In order:
//   1. the workspace's connected Gmail      — the user's own inbox
//   2. the workspace's connected Outlook    — the user's own inbox (an Outlook-only workspace)
// and NOTHING else (owner, 2026-11-17): with neither connected the follow-up is not sent, the meeting is
// stamped `followupNotSent`, and the Inbox offers "Send the follow-up now" once a mailbox is connected.
// Be More Swan never sends a customer's email from its own domain — the attendees get it from the person
// they met, replies land in that person's inbox, and our sending domain is never at risk from a customer.
// A sender that is not connected throws IntegrationError and the next is tried; any other failure
// (the provider refused the send) stops here, so one email never goes out twice from two accounts.
// The senders are passed in, so tests/meeting-followup-send.test.ts can stub each one.

import { IntegrationError } from './workspace-integrations';

export type FollowupVia = 'gmail' | 'outlook';

export interface FollowupMessage {
    recipients: string[];
    subject: string;
    body: string;
}

export interface FollowupSenders {
    gmail: (m: { to: string; subject: string; body: string }) => Promise<{ id?: string | null }>;
    outlook: (m: { to: string; subject: string; body: string }) => Promise<unknown>;
}

export interface FollowupResult { via: FollowupVia; id: string | null }

/** Thrown when neither Gmail nor Outlook is connected: nothing was sent. */
/**
 * A follow-up refused because no Gmail or Outlook is connected — sync-action.ts answers 409 with
 * code 'no_mailbox'. Final, not retryable: process-scenario-jobs.ts must not re-queue the job for it.
 * Pure.
 */
export function isNoMailboxResult(statusCode: number, body: unknown): boolean {
    return statusCode === 409 && !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'no_mailbox';
}

export class NoMailboxError extends Error {
    readonly code = 'no_mailbox';
    constructor() {
        super('Not sent — no Gmail or Outlook is connected. Connect one in Connections, then send the follow-up from the Inbox.');
        this.name = 'NoMailboxError';
    }
}

const notConnected = (err: unknown) => err instanceof IntegrationError;

/**
 * Send the follow-up from the first connected inbox.
 * @throws NoMailboxError when neither is connected; Error when a connected inbox refuses the send.
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
    throw new NoMailboxError();
}

/** What the Inbox and the sync log say about a send. */
export function followupSentMessage(via: FollowupVia, count: number): string {
    const who = `${count} attendee${count === 1 ? '' : 's'}`;
    return via === 'gmail' ? `Follow-up sent to ${who} from your Gmail.` : `Follow-up sent to ${who} from your Outlook.`;
}
