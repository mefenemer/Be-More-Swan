// src/config/audience-import-status.ts
// Reading the subscription state out of somebody else's CSV export.
//
// ⚠️ THE BUG THIS EXISTS TO CLOSE. Until 2026-08-20 the importer wrote `status: 'subscribed'` for
// every row. A tenant migrating from Mailchimp or Kit would export their audience — which includes
// the people who UNSUBSCRIBED — import it here, and those people would come back as subscribed and
// be emailed again, from the tenant's own domain, on the tenant's own reputation. A compliance
// breach reachable through our own UI, in three clicks, with a success toast at the end of it.
//
// ── Why the mapping lives on the SERVER and only the column choice on the client ────────────────
// The values are the dangerous part. "cleaned" is Mailchimp for a hard bounce, not for a healthy
// subscriber; "pending" means they never confirmed. A client-side copy of this table would be a
// second source of truth for a consent decision, and the one that drifts is the one that emails
// somebody. The browser decides WHICH column looks like a status; this decides what it MEANS.
//
// ⚠️ An unrecognised value is NOT assumed to be subscribed. See resolveImportStatus.

export type ImportedStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'pending';

/** Header names that carry a subscription state, lowercased. Used by the client's column matcher. */
export const STATUS_HEADER_ALIASES: readonly string[] = [
    'status', 'state', 'subscription status', 'subscriber status', 'member status',
    'unsubscribed', 'opted out', 'opt out', 'do not email', 'email marketing consent',
];

/**
 * Value → state. Keys are lowercased and trimmed by the resolver.
 *
 * Sources these came from: Mailchimp (subscribed/unsubscribed/cleaned/pending), Kit
 * (active/unsubscribed/bounced/complained), Shopify (subscribed/not_subscribed), and the
 * boolean-ish columns a spreadsheet produces when somebody keeps this by hand.
 */
const VALUE_MAP: Record<string, ImportedStatus> = {
    // Mailable
    subscribed: 'subscribed',
    subscriber: 'subscribed',
    active: 'subscribed',
    confirmed: 'subscribed',
    'opted in': 'subscribed',
    'opted-in': 'subscribed',
    yes: 'subscribed',
    true: 'subscribed',
    '1': 'subscribed',

    // Not mailable — they left
    unsubscribed: 'unsubscribed',
    unsubscribe: 'unsubscribed',
    unsub: 'unsubscribed',
    'opted out': 'unsubscribed',
    'opted-out': 'unsubscribed',
    'not_subscribed': 'unsubscribed',
    'not subscribed': 'unsubscribed',
    inactive: 'unsubscribed',
    cancelled: 'unsubscribed',
    canceled: 'unsubscribed',
    no: 'unsubscribed',
    false: 'unsubscribed',
    '0': 'unsubscribed',

    // Not mailable — the address is dead. ⚠️ "cleaned" is Mailchimp's word for this, and reading
    // it as a healthy subscriber is the single most likely way to import a bounce as a contact.
    cleaned: 'bounced',
    bounced: 'bounced',
    bounce: 'bounced',
    'hard bounce': 'bounced',
    undeliverable: 'bounced',

    // Not mailable — they reported it
    complained: 'complained',
    complaint: 'complained',
    spam: 'complained',
    'marked as spam': 'complained',
    abuse: 'complained',

    // Never confirmed. Imported as pending, which is unmailable until they confirm — the honest
    // reading of "this person started signing up somewhere else and never finished".
    pending: 'pending',
    unconfirmed: 'unconfirmed' as ImportedStatus,
};
VALUE_MAP.unconfirmed = 'pending';

export interface ImportStatusVerdict {
    status: ImportedStatus | null;
    /** True when a value was present but means nothing we recognise. */
    unrecognised: boolean;
}

/**
 * Resolve one cell.
 *
 * Three outcomes, and the third is the important one:
 *   • no status column / empty cell → `null`, and the caller applies the import's default. A file
 *     with no status column is the ordinary case: a plain list of people to add.
 *   • a value we know            → that state.
 *   • a value we do NOT know     → `unrecognised`. The caller SKIPS the row rather than guessing.
 *
 * ⚠️ Guessing "subscribed" for an unknown value would reintroduce the exact bug this file closes,
 * just further down the funnel. Guessing "unsubscribed" would be safe but would silently discard a
 * whole import over an unexpected header match. Refusing the row and reporting it is the only
 * option that neither emails somebody who opted out nor throws away work without saying so.
 */
export function resolveImportStatus(raw: unknown): ImportStatusVerdict {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!v) return { status: null, unrecognised: false };
    const mapped = VALUE_MAP[v];
    if (mapped) return { status: mapped, unrecognised: false };
    return { status: null, unrecognised: true };
}

/** Which imported states may be emailed. Exactly one of them. */
export function isMailable(status: ImportedStatus): boolean {
    return status === 'subscribed';
}
