// src/utils/mail-reader/types.ts — the provider-neutral shapes the mail reader returns (plan §4.1).
// Gmail (Phase 3) returns the same shapes, so the sorting and the Lead Generator's reply reading
// (outreach plan Part B) never care which provider a mailbox is on.

export interface MailMessageMeta {
    id: string;
    /** The message left the inbox (moved, deleted) since the last read. */
    removed: boolean;
    threadId: string | null;
    fromName: string | null;
    fromAddress: string | null;
    subject: string | null;
    receivedAt: Date | null;
    isRead: boolean;
    webLink: string | null;
    /** The provider's own split: Outlook Focused/Other, Gmail Primary/Promotions. A hint, not a rule. */
    providerFolderHint: 'focused' | 'other' | null;
}

export interface MailChanges {
    messages: MailMessageMeta[];
    /** Where the next read starts. */
    cursor: string;
    /** False when the run stopped early (time budget) and `cursor` is a page to resume from. */
    complete: boolean;
}
