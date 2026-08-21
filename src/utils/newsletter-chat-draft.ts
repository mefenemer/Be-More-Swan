// src/utils/newsletter-chat-draft.ts
// Normalise the `newsletter_issue_draft` uiElement the chat route emits, before anything renders it
// or writes it to newsletter_issues. Mirrors src/utils/blog-chat-draft.ts.
//
// ⚠️ WHY A NORMALISER AND NOT A DIRECT WRITE. The card holds the ONLY copy of an issue a user may
// have iterated on for several turns, and the model's output reaches it unvalidated. Two failures
// this closes:
//   • A merge tag the send worker cannot resolve. The model is told the closed vocabulary, but a
//     draft that reaches the Studio carrying {{first_name}} would render "Hi ," in every inbox —
//     so the same scrub the autopilot applies runs here too, rather than trusting the prompt.
//   • An unbounded body. A model that runs away produces a row that breaks the editor rather than
//     an issue anyone can send.

import { scrubMergeTags, MAX_SUBJECT_CHARS, MAX_PREHEADER_CHARS } from './newsletter-generate';

export const NEWSLETTER_ISSUE_DRAFT_TYPE = 'newsletter_issue_draft';

/** Generous, but finite — an email nobody will read is still better than a row nothing can open. */
export const MAX_ISSUE_BODY_CHARS = 40_000;

export interface NewsletterChatDraft {
    subject: string;
    preheader: string;
    bodyMarkdown: string;
    /** Tags the scrub removed, so the card can say what it changed rather than silently editing. */
    warnings: string[];
    /**
     * A send time the assistant is PROPOSING, as a bare wall-clock string ('2026-09-01T09:00').
     *
     * ⚠️ A PROPOSAL, NOT A SCHEDULE. Nothing here schedules anything: it turns the card's one button
     * into two, and the second one — which a human presses, having just read the whole issue above
     * it — is what approves and schedules. The server still enforces that only an owner or admin
     * may approve, so the model cannot arrange a send that the person in front of it could not.
     *
     * ⚠️ Deliberately zone-LESS. It is read in the business's own timezone at the moment it is
     * approved, exactly like the Studio's date field, and stamped onto the issue there. A model
     * inventing a UTC offset is how "nine in the morning" becomes ten.
     */
    sendAt: string | null;
}

/**
 * 'YYYY-MM-DDTHH:mm' and nothing else.
 *
 * ⚠️ Rejected rather than coerced. A half-parsed date is how an issue goes out at the wrong hour on
 * the wrong day, and the cost of refusing is that the card shows no schedule button — which is the
 * state it was in yesterday, and which the user can fix in the Studio in four seconds.
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function normaliseSendAt(value: unknown): string | null {
    // ⚠️ NOT slice(0, 16) first. Truncating '2026-09-01T09:00:00Z' to '2026-09-01T09:00' would
    // silently discard a timezone the model had attached — turning "9am UTC" into "9am wherever the
    // business is" with nothing anywhere saying so. The whole string has to be the wall clock.
    const s = typeof value === 'string' ? value.trim() : '';
    if (!WALL_CLOCK.test(s)) return null;
    // Real calendar date, not just the right shape: '2026-02-31T09:00' matches the pattern.
    const [date, time] = s.split('T');
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d, hh, mm));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    if (hh > 23 || mm > 59) return null;
    return s;
}

/** First non-empty line, stripped of Markdown heading marks — the fallback when no subject came back. */
function deriveSubject(bodyMarkdown: string): string {
    const line = bodyMarkdown.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return line.replace(/^#+\s*/, '').slice(0, MAX_SUBJECT_CHARS) || 'Untitled issue';
}

export function newsletterDraftFromUiElement(uiElement: unknown): NewsletterChatDraft | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== NEWSLETTER_ISSUE_DRAFT_TYPE) return null;

    const rawBody = typeof ui.bodyMarkdown === 'string' ? ui.bodyMarkdown.trim().slice(0, MAX_ISSUE_BODY_CHARS) : '';
    if (!rawBody) return null;   // nothing written — the caller falls back to text-only

    const body = scrubMergeTags(rawBody);
    const rawSubject = typeof ui.subject === 'string' ? ui.subject.trim().slice(0, MAX_SUBJECT_CHARS) : '';
    const subject = scrubMergeTags(rawSubject || deriveSubject(body.text));
    const preheader = scrubMergeTags(
        typeof ui.preheader === 'string' ? ui.preheader.trim().slice(0, MAX_PREHEADER_CHARS) : '',
    );

    return {
        subject: subject.text || 'Untitled issue',
        preheader: preheader.text,
        bodyMarkdown: body.text,
        warnings: [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings])],
        sendAt: normaliseSendAt(ui.sendAt),
    };
}
