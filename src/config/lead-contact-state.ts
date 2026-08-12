// src/config/lead-contact-state.ts
// How many of a search's companies can actually be reached — the four buckets behind the
// Searches tab's aggregate line (Phase 2 item 8 of docs/lead-triage-review-split-plan.md).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Tier-1 enrichment hits roughly one SMB site in three, so most discovered leads have no address
// and the Review Queue — which requires one — is nearly empty by design. A prod run found 65
// companies and stocked Review with 4. Without a sentence saying so, an empty queue reads as a
// broken assistant rather than an honest result, which is the risk the plan calls out explicitly:
// shipping the triage/review split WITHOUT this makes the product look like it does less.
//
// ⚠️ THE COUPLING THAT MATTERS. The Leads tab already answers this per lead, in `contactState()`
// (src/components/assistant-data-hub.js). If the aggregate and the column disagree — "20 publish
// none" over a table showing 18 "None found" — the number is worse than no number, because it
// teaches the user not to trust either. The column is a browser IIFE with no exports and this is
// server-side SQL, so they cannot share a call; they share these definitions instead, and
// tests/lead-contact-aggregate.test.ts runs the real `contactState()` against `contactBucketOf`
// over a fixture matrix to prove they still agree.
//
// Derived entirely from fields the pipeline already writes. No new storage, no migration.

/**
 * The four states, as a user would say them.
 *
 * Collapsing `nonePublished` and `notAttempted` into one "no" would destroy the only useful
 * distinction here: the first means the site was read and publishes nothing (go and find an
 * address by hand), the second means the lead scored cold and was never eligible for a scrape
 * (the fix is TARGETING, not the scraper). Same reasoning as the Contact column's five chips.
 */
export const CONTACT_BUCKETS = ['reachable', 'nonePublished', 'notAttempted', 'pending'] as const;

export type ContactBucket = (typeof CONTACT_BUCKETS)[number];

/**
 * The three facts every bucket is decided from, as columns on `discovered_leads dl`.
 *
 * ⚠️ `enrichAttemptedAt` is the load-bearing one. `recordEnrichment()` stamps it on a MISS as well
 * as a hit, which is the only thing separating "we looked and found nothing" from "nobody looked".
 * And `rating` is what makes `notAttempted` true rather than a guess: `enrichBatch()` scrapes
 * `rating IN ('hot','warm')` only, so a cold lead is never going to be attempted at all.
 */
const COL = {
    email: 'dl.contact_email',
    stamp: `dl.signals ->> 'enrichAttemptedAt'`,
    rating: 'dl.rating',
} as const;

/**
 * SQL predicates over `discovered_leads dl`, one per bucket.
 *
 * Built from COL rather than typed out so the JS mirror below cannot reference a different field.
 * These are module constants, never user input — safe to pass through `sql.raw()`.
 */
export const CONTACT_BUCKET_SQL: Record<ContactBucket, string> = {
    reachable: `${COL.email} IS NOT NULL`,
    nonePublished: `${COL.email} IS NULL AND ${COL.stamp} IS NOT NULL`,
    notAttempted: `${COL.email} IS NULL AND ${COL.stamp} IS NULL AND ${COL.rating} = 'cold'`,
    pending: `${COL.email} IS NULL AND ${COL.stamp} IS NULL AND ${COL.rating} IN ('hot','warm')`,
};

/** Leads the aggregate counts: everything sitting in the Leads tab, so rejects are excluded. */
export const CONTACT_AGGREGATE_SCOPE_SQL = `dl.status <> 'discarded'`;

/**
 * The same decision in JS. The mirror the test pins `contactState()` against.
 *
 * ⚠️ Exhaustive and mutually exclusive by construction — every lead lands in exactly one bucket,
 * which is what lets the four counts be presented as a total. A lead with a rating outside
 * hot/warm/cold and no stamp would fall through both `notAttempted` and `pending`, so the
 * fallthrough is `pending` rather than a fifth silent state: "still to check" over-promises in a
 * direction the user can see and correct, where a dropped row would silently break the arithmetic.
 */
export function contactBucketOf(lead: {
    contactEmail?: string | null;
    enrichAttemptedAt?: string | null;
    rating?: string | null;
}): ContactBucket {
    if (typeof lead.contactEmail === 'string' && lead.contactEmail.trim()) return 'reachable';
    if (lead.enrichAttemptedAt) return 'nonePublished';
    return lead.rating === 'cold' ? 'notAttempted' : 'pending';
}

/** The bucket each of the Contact column's five chips belongs to — the map the test asserts. */
export const CONTACT_STATE_TO_BUCKET: Record<string, ContactBucket> = {
    role: 'reachable',
    personal: 'reachable',
    none: 'nonePublished',
    unchecked: 'notAttempted',
    checking: 'pending',
};
