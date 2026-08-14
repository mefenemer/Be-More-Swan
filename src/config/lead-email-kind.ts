// src/config/lead-email-kind.ts
// Is a lead's address a generic company inbox, or an identified individual?
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `emailKind` is not decoration. It decides:
//   • which chip the Leads tab shows — "Role inbox" (green) or "Named person" (amber)
//   • whether the Review Queue puts a personal-inbox caution on an outreach draft
// and it stands in for the GDPR footing: a role inbox is the defensible lane for B2B outreach
// under UK legitimate interests / PECR, while a named individual is the weakest footing this
// product has. Getting it wrong in the ROLE direction under-warns on exactly the addresses that
// most deserve a second look.
//
// ⚠️ THE DEFAULT IS THE HAZARD. `contactState()` reads `emailKind === 'personal' ? … : 'role'`, so
// an ABSENT kind renders as "Role inbox" — the less cautious of the two labels. That is why every
// path that writes `contactEmail` must also write `emailKind`, and why this vocabulary had to leave
// discovery-enrich.ts: the scraper was not the only writer any more. A hand-typed address arrived
// with no kind at all and was labelled a role inbox regardless of what it was.
//
// This module is the ONE vocabulary. The scraper imports it directly; the browser gets a generated
// mirror in src/generated/platform-constants.js (scripts/gen-client-constants.ts), which is why the
// classifier below is written in plain, portable JS with no dependencies — it is stringified into
// that file verbatim.

/**
 * Where an address came from. Drives the Review Queue's personal-inbox gate.
 *
 * - `scrape`   — read off the company's own public website.
 * - `manual`   — typed in by the user, who therefore already knows whose inbox it is.
 * - `provider` — BOUGHT from a paid enrichment vendor (src/lib/discovery-enrich-provider.ts).
 */
export type EmailSource = 'scrape' | 'manual' | 'provider';

export type EmailKind = 'role' | 'personal';

/**
 * How to describe an address's origin to the person about to email it.
 *
 * ⚠️ A PURCHASED address must say so. The Review Queue's recipient line originally read
 * `emailSource === 'scrape' ? ' · found on their website' : ''`, so a bought address rendered
 * with no origin at all — the one provenance a reviewer most needs before approving, since
 * "we paid a broker for this named individual's details" is the weakest GDPR/PECR footing in
 * the product and the strongest reason to hesitate.
 *
 * Empty string for 'manual': the user typed it, so telling them where it came from is noise.
 */
export const EMAIL_SOURCE_LABELS: Record<EmailSource, string> = {
    scrape: 'found on their website',
    provider: 'from a paid data provider',
    manual: '',
};

/** The origin phrase for an address, or '' when there is nothing worth saying. */
export function emailSourceLabel(source: unknown): string {
    return (EMAIL_SOURCE_LABELS as Record<string, string>)[String(source ?? '')] ?? '';
}

/**
 * Does this address need an explicit "yes, email this named person" before anything is sent?
 *
 * ⚠️ THE RULE IS "THE USER DID NOT TYPE IT", NOT "WE SCRAPED IT". Both gates used to test
 * `emailSource === 'scrape'` literally, which was correct while scraping was the only way an
 * address arrived unattended. It stopped being correct the moment addresses could be PURCHASED: a
 * bought address would carry a different source, match neither gate, and a named individual whose
 * details we paid a broker for would be emailed with no confirmation at all — a worse case than
 * the scraped one the gate was built for, not a lesser one.
 *
 * Written as "anything except manual" so the safe direction is the DEFAULT: a source added in
 * future is gated until someone deliberately exempts it here.
 *
 * The two enforcement points are netlify/functions/lead-generation.ts (`send_outreach`, the
 * server-side gate that actually blocks the send) and netlify/functions/signal-inbox.ts (the
 * warning shown before approval). They must agree, which is why this predicate exists rather
 * than the condition being written out twice.
 */
export function needsPersonalInboxConfirmation(kind: unknown, source: unknown): boolean {
    return kind === 'personal' && source !== 'manual' && !!source;
}

/**
 * Generic inbox prefixes — corporate role addresses, not identified individuals.
 *
 * Kept deliberately broad. Misclassifying role→personal only over-warns, which is the safe
 * direction; the reverse quietly removes a caution from a real person's inbox.
 */
export const ROLE_EMAIL_PREFIXES: ReadonlySet<string> = new Set([
    'info', 'hello', 'hi', 'contact', 'contactus', 'enquiries', 'enquiry', 'inquiries',
    'sales', 'admin', 'office', 'team', 'mail', 'general', 'reception', 'bookings',
    'support', 'help', 'ask', 'talk', 'connect', 'business',
    // Hospitality/venue desks — a live staging run classified reservations@ as 'personal'
    // and warned on it. Misclassifying role→personal only over-warns (the safe direction),
    // but it puts needless friction on the reviewer, so keep this list current.
    'reservations', 'reservation', 'booking', 'events', 'event', 'enquires', 'frontdesk',
    'stay', 'guestservices', 'concierge', 'hire', 'orders', 'shop', 'studio', 'welcome',
]);

/**
 * Classify a local part (everything before the @).
 *
 * The separator strip is what catches `contact.us@` and `front-desk@` — real formats on real SMB
 * sites that would otherwise read as a person's name.
 *
 * Byte-for-byte the rule discovery-enrich.ts has always applied, moved rather than rewritten: it
 * has been classifying live leads for weeks, and a "tidy-up" here would silently reclassify them.
 */
export function roleOrPersonal(localPart: string): EmailKind {
    const prefix = localPart.trim().toLowerCase();
    const bare = prefix.replace(/[._-]/g, '');
    return ROLE_EMAIL_PREFIXES.has(prefix) || ROLE_EMAIL_PREFIXES.has(bare) ? 'role' : 'personal';
}

/**
 * Classify a whole address, or null if it is not one.
 *
 * ⚠️ Deliberately does NOT check the address against the lead's own domain, unlike the scraper's
 * `classify()`. The scraper needs that check because it is reading a page full of other people's
 * addresses — the site builder's, the agency's — and must not return one. A human typing into the
 * Edit lead form is doing the opposite: they have gone and FOUND an address, quite possibly on a
 * directory or a LinkedIn page, and it is legitimately allowed to sit on another domain. Rejecting
 * it would refuse the one remedy the "None found" chip offers.
 */
export function classifyEmailKind(email: string): EmailKind | null {
    const value = String(email ?? '').trim().toLowerCase();
    if (!value || (value.match(/@/g) || []).length !== 1) return null;
    const [local, domain] = value.split('@');
    if (!local || !domain || !domain.includes('.')) return null;
    return roleOrPersonal(local);
}
