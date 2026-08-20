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
    };
}
