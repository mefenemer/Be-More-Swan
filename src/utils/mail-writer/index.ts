// src/utils/mail-writer/index.ts — what the Email Assistant may do to a mailbox, per provider
// (docs/email-assistant-plan.md §2.4–2.5, Phase 2a). Called ONLY by an approved action in
// src/utils/mailbox-actions.ts — never by sorting, never by chat on its own.
//
// What exists: reply in the same thread, save a reply to the mailbox's own Drafts, archive (out of the
// inbox, kept), move to trash, and put either back. What does NOT exist, on purpose: permanent delete
// (Gmail would need https://mail.google.com/; D3 = never), forwarding, sending to anyone but the
// person being replied to, changing mailbox settings or filters.

import { GraphWriteError, graphArchive, graphRestore, graphSaveReplyDraft, graphSendReply, graphTrash } from './graph';
import { GmailWriteError, gmailArchive, gmailRestore, gmailSaveReplyDraft, gmailSendReply, gmailTrash } from './gmail';

/** Everything a reply needs about the email it answers. */
export interface ReplyTarget {
    providerMessageId: string;
    threadId: string | null;
    /** The mailbox's own address (the From of the reply). */
    from: string;
    /** Who the reply goes to: the email's Reply-To, else its From. Shown to the user before Send. */
    to: string;
    subject: string;
    /** Message-ID and References of the email answered (Gmail threading). */
    inReplyTo: string | null;
    references: string | null;
}

/** Where a message was before clean-up moved it, so Undo can put it back. */
export interface MovedItem {
    /** Our mailbox_messages.id. */
    messageId: number;
    /** The provider's id BEFORE the move. */
    providerMessageId: string;
    /** The provider's id AFTER the move (Outlook gives a moved message a new id; Gmail keeps it). */
    movedProviderId: string;
}

export interface MailWriter {
    sendReply(token: string, target: ReplyTarget, body: string): Promise<{ providerMessageId: string | null }>;
    saveReplyDraft(token: string, target: ReplyTarget, body: string): Promise<{ draftId: string | null }>;
    archive(token: string, providerMessageId: string): Promise<{ movedProviderId: string }>;
    trash(token: string, providerMessageId: string): Promise<{ movedProviderId: string }>;
    /** Back into the inbox, from archive or trash. */
    restore(token: string, movedProviderId: string, from: 'archive' | 'trash'): Promise<{ providerMessageId: string }>;
}

const WRITERS: Record<string, MailWriter> = {
    gmail: { sendReply: gmailSendReply, saveReplyDraft: gmailSaveReplyDraft, archive: gmailArchive, trash: gmailTrash, restore: gmailRestore },
    outlook: { sendReply: graphSendReply, saveReplyDraft: graphSaveReplyDraft, archive: graphArchive, trash: graphTrash, restore: graphRestore },
};

export function writerFor(provider: string): MailWriter | null {
    return WRITERS[provider] ?? null;
}

/** A provider's HTTP refusal, as a status. Null for anything else. Pure. */
export function writeHttpError(err: unknown): number | null {
    return err instanceof GmailWriteError || err instanceof GraphWriteError ? err.status : null;
}

/** "Re: " once, never "Re: Re:". Pure. */
export function replySubject(subject: string | null | undefined): string {
    const s = (subject ?? '').trim() || '(no subject)';
    return /^re:/i.test(s) ? s : `Re: ${s}`;
}
