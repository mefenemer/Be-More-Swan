// src/utils/support-priority.ts — the direct route for security and billing (2026-11-12).
//
// Some requests should never wait in the ordinary queue or be answered by an article: a possible
// security or privacy problem, and anything about money. Contact us offers both as topics, and the
// chat support card can mark a request with them. support-tickets.ts uses this to set the priority,
// word the business-inbox alert so it stands out, and tell the customer a person picks it up first.
// The Contact us form skips the "these articles might help" step for them (help.js).

export const DIRECT_TOPICS = ['security', 'billing'] as const;
export type DirectTopic = (typeof DIRECT_TOPICS)[number];

export function isDirectTopic(category: unknown): category is DirectTopic {
    return typeof category === 'string' && (DIRECT_TOPICS as readonly string[]).includes(category);
}

/** The ticket priority for a category: security → urgent, billing → high, otherwise null (default). */
export function topicPriority(category: unknown): 'urgent' | 'high' | null {
    if (category === 'security') return 'urgent';
    if (category === 'billing') return 'high';
    return null;
}

/** The business-inbox subject line, so the two direct topics stand out in a mail client. */
export function inboxSubject(ticketId: number, category: string, subject: string): string {
    if (category === 'security') return `[Ticket #${ticketId}] 🚨 SECURITY / PRIVACY — ${subject}`;
    if (category === 'billing') return `[Ticket #${ticketId}] 💳 Billing — ${subject}`;
    return `[Ticket #${ticketId}] New ${category} ticket: ${subject}`;
}

/** The line in the customer's confirmation email about who picks it up. */
export function confirmationLine(category: string): string {
    if (isDirectTopic(category)) {
        return `This goes straight to a person on our team, ahead of the usual queue. We aim to reply <strong>within one business day</strong>.`;
    }
    return 'Your support ticket has been created. Our team typically responds within <strong>1–2 business days</strong>.';
}
