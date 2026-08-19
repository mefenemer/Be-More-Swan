// src/utils/audience-contacts.ts
// Normalisation and validation for the shared audience layer (db/audience.sql).
//
// The grain of audience_contacts is (organisation_id, email), enforced by a UNIQUE constraint. That
// constraint is only as good as the normalisation in front of it: "Jane@Acme.com " and
// "jane@acme.com" are the same person, and letting both in produces two contacts, two consent
// histories and — the part that actually costs something — TWO COPIES OF EVERY ISSUE landing in
// one inbox, which is the fastest route to a spam complaint.
//
// So every write path (public form, CSV import, manual add, lead promotion) normalises here, and
// nowhere else does its own trimming.

/** The maximum we will store. RFC 5321 caps a path at 254 characters; anything longer is junk. */
export const MAX_EMAIL_CHARS = 254;
export const MAX_NAME_CHARS = 120;

/**
 * Lowercase and trimmed. The single normalisation used by every writer AND by every lookup — a
 * reader that normalises differently from the writer silently misses rows.
 *
 * ⚠️ Trims the ENDS only. Stripping whitespace throughout would quietly turn "a b@acme.com" into
 * a different, deliverable address ("ab@acme.com") and subscribe a stranger; looksLikeEmail
 * rejects the internal-space case instead, which is the honest answer to a typo.
 *
 * Deliberately does NOT strip gmail-style dots or +tags. They are the same mailbox at Google and a
 * different mailbox almost everywhere else, and a subscriber who signed up as jane+news@ expects
 * mail at jane+news@. Getting clever here loses more than it wins.
 */
export function normaliseEmail(raw: string | null | undefined): string {
    return String(raw ?? '').trim().toLowerCase();
}

/**
 * Is this plausibly an address we can send to?
 *
 * Deliberately permissive: full RFC 5322 validation rejects addresses that work in practice, and
 * the only authoritative test is whether mail is accepted. This catches the things that are
 * definitely broken — no @, no dot in the domain, spaces, control characters, over-length — so the
 * send ledger never carries a row that can only ever fail.
 */
export function looksLikeEmail(email: string | null | undefined): boolean {
    const e = normaliseEmail(email);
    if (!e || e.length > MAX_EMAIL_CHARS) return false;
    // Whitespace anywhere, control characters, and the punctuation that only appears in a
    // display-name form ("Jane <jane@acme.com>") — none of which we can deliver to.
    // eslint-disable-next-line no-control-regex
    if (/[\s\x00-\x1f<>()[\]\\,;:"]/.test(e)) return false;
    const at = e.lastIndexOf('@');
    if (at <= 0 || at === e.length - 1) return false;
    const domain = e.slice(at + 1);
    return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..');
}

/** Trim a free-text name field to something storable, or null. Never throws on odd input. */
export function cleanName(raw: string | null | undefined): string | null {
    const v = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS);
    return v || null;
}

/**
 * The greeting a merge var falls back to when a contact has no first name.
 *
 * ⚠️ Not cosmetic. "Hi ," is the single most recognisable tell of a broken bulk mailing, and a
 * blank fallback is what produces it. Every merge var needs a fallback; this is the one for names.
 */
export const NAME_FALLBACK = 'there';

/** Display name for a contact row, for UI lists and merge vars. */
export function contactDisplayName(c: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    return name || String(c.email ?? '').trim() || 'Unknown';
}
