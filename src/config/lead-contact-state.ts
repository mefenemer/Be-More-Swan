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

import { PROSPECT_TYPES } from './icp-profile';

/**
 * The five states, as a user would say them.
 *
 * Collapsing `nonePublished` and `notAttempted` into one "no" would destroy the only useful
 * distinction here: the first means the site was read and publishes nothing (go and find an
 * address by hand), the second means the lead was never eligible for a scrape at all — it is not
 * a company this business could sell to, so the fix is TARGETING, not the scraper. Same reasoning
 * as the Contact column's chips. ⚠️ `notAttempted` is now decided by ENRICH_ELIGIBLE_SQL rather
 * than by a cold rating: a cold lead the scorer identified as a `target_business` IS attempted.
 *
 * ⚠️ `pending` and `missed` are the SAME lead — hot or warm, no address, no attempt stamp — split
 * by whether anything is actually running. That split is the whole of Phase 2 item 11: without it
 * the column says "Checking…" forever on a run that finished or died, which is a promise the
 * pipeline will never keep. `enrichBatch()` only ever visits leads while a job is live, so once
 * every job is terminal an unstamped lead is not queued for anything — it was missed, and the only
 * thing that will change it is a human (item 9's manual address, or item 10's re-queue).
 */
export const CONTACT_BUCKETS = ['reachable', 'nonePublished', 'notAttempted', 'pending', 'missed'] as const;

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
    prospectType: `dl.scoring_card ->> 'prospectType'`,
} as const;

/**
 * WHICH LEADS ENRICHMENT WILL ACTUALLY ATTEMPT. The one definition of that rule.
 *
 * ⚠️ This is the predicate `enrichBatch()` runs, and it is also what makes `notAttempted` a
 * statement of fact rather than a guess. It lived as a hand-typed `rating IN ('hot','warm')` in
 * four places — the worker's batch query, the worker's remaining-count query, the bucket
 * predicates below and the Contact column's browser mirror — which is precisely the shape this
 * file exists to prevent. Changing it in one place and not the others makes the Searches tab say
 * nobody looked at a lead the pipeline just looked at.
 *
 * ── §5, 2026-08-25: the rule is now about WHAT it is, never about its rating ────────────────
 * The customer's principle, and it is the right one:
 *
 *   "Emails should be found for all leads irrespective of cold or not, as the user can then
 *    determine themselves whether to contact a cold lead. This is not for us to decide."
 *
 * Agreed for COLD. Not agreed for NOT-A-COMPANY: an aggregator, a news article or a Wikipedia page
 * has nobody to email, and a lookup against one cannot return anything. So rating drops out of the
 * rule entirely and prospect type is the whole of it.
 *
 * ⚠️ Conflating those two is the original defect. `rating = cold` was used as a proxy for "not
 * worth contacting" and silently included 89 companies the scorer had itself classified
 * `target_business`. Measured 2026-08-25: 95 of 500 leads were ever offered a lookup, and 68% of
 * those yielded an address — the gate was the bottleneck, never the lookup.
 *
 * ── TWO gates, because one is free and the other is not ─────────────────────
 * Reading a company's own website costs a few seconds. Buying an address costs money. So:
 *
 *   ENRICH_ELIGIBLE_SQL       who gets READ    — anything that might be a company, including
 *                                               leads with no prospect type at all
 *   PAID_ENRICH_ELIGIBLE_SQL  who gets BOUGHT  — only a confirmed `target_business`
 *
 * An unclassified lead is either legacy (scored before the gate shipped 2026-08-12) or unscored
 * (§4.2). Scraping one is free and might hand the user an address; PAYING for one is a blank
 * cheque against a lead nobody has judged.
 */
const DISQUALIFYING_TYPES = PROSPECT_TYPES.filter((t) => t !== 'target_business');

/**
 * Who gets their website read. Everything except the types no address can help.
 *
 * Built from PROSPECT_TYPES rather than a hand-typed list, so a new disqualifying type reaches
 * this rule on the next deploy with no second edit to forget.
 */
export const ENRICH_ELIGIBLE_SQL =
    `(${COL.prospectType} IS NULL OR ${COL.prospectType} NOT IN (${DISQUALIFYING_TYPES.map((t) => `'${t}'`).join(', ')}))`;

/**
 * Who is worth PAYING a provider for. Confirmed companies only.
 *
 * ⚠️ Deliberately narrower than the scrape. The free tier can afford to be generous with an
 * unknown; a paid lookup cannot, and `paidLookupAt` is stamped on a MISS too — it counts money
 * spent, not addresses found.
 */
export const PAID_ENRICH_ELIGIBLE_SQL = `${COL.prospectType} = 'target_business'`;

export function isEnrichEligible(lead: { prospectType?: string | null }): boolean {
    return !lead.prospectType || !(DISQUALIFYING_TYPES as readonly string[]).includes(lead.prospectType);
}

/** The JS mirror of PAID_ENRICH_ELIGIBLE_SQL. */
export function isPaidEnrichEligible(lead: { prospectType?: string | null }): boolean {
    return lead.prospectType === 'target_business';
}

/**
 * Is anything actually going to look at this lead? True only while a job on ITS OWN campaign is
 * live — enrichment runs per job over that job's campaign, so another campaign being busy says
 * nothing about this lead.
 *
 * 'queued' counts as live: a sliced discovery run RESTS at queued between slices and spends most
 * of its life there (see the note above `started` in assistant-signal-inbox.js). Treating it as
 * terminal would flip every in-flight lead to "Not attempted" mid-run — the opposite lie.
 */
export const LIVE_JOB_SQL =
    `EXISTS (SELECT 1 FROM discovery_jobs j WHERE j.campaign_id = dl.campaign_id AND j.status IN ('queued','processing'))`;

/**
 * SQL predicates over `discovered_leads dl`, one per bucket.
 *
 * Built from COL rather than typed out so the JS mirror below cannot reference a different field.
 * These are module constants, never user input — safe to pass through `sql.raw()`.
 */
export const CONTACT_BUCKET_SQL: Record<ContactBucket, string> = {
    reachable: `${COL.email} IS NOT NULL`,
    nonePublished: `${COL.email} IS NULL AND ${COL.stamp} IS NOT NULL`,
    notAttempted: `${COL.email} IS NULL AND ${COL.stamp} IS NULL AND NOT ${ENRICH_ELIGIBLE_SQL}`,
    pending: `${COL.email} IS NULL AND ${COL.stamp} IS NULL AND ${ENRICH_ELIGIBLE_SQL} AND ${LIVE_JOB_SQL}`,
    missed: `${COL.email} IS NULL AND ${COL.stamp} IS NULL AND ${ENRICH_ELIGIBLE_SQL} AND NOT ${LIVE_JOB_SQL}`,
};

/** Leads the aggregate counts: everything sitting in the Leads tab, so rejects are excluded. */
export const CONTACT_AGGREGATE_SCOPE_SQL = `dl.status <> 'discarded'`;

/**
 * The same decision in JS. The mirror the test pins `contactState()` against.
 *
 * ⚠️ Exhaustive and mutually exclusive by construction — every lead lands in exactly one bucket,
 * which is what lets the counts be presented as a total. Eligibility is now a single positive
 * test, so the partition holds for any rating at all: an unrecognised rating with no prospect type
 * is not eligible and reads `notAttempted`, which is exactly what the pipeline will do with it.
 * That is a change from the old fallthrough, which sent unrated leads to the hot/warm pair to
 * avoid dropping a row — a positive eligibility test cannot drop one, so the understatement is
 * both safe and true.
 */
export function contactBucketOf(lead: {
    contactEmail?: string | null;
    enrichAttemptedAt?: string | null;
    rating?: string | null;
    /** The scorer's verdict on WHAT this is. Mirrors COL.prospectType. */
    prospectType?: string | null;
    /** Is a job live on this lead's own campaign? Mirrors LIVE_JOB_SQL. */
    enrichmentInFlight?: boolean;
}): ContactBucket {
    if (typeof lead.contactEmail === 'string' && lead.contactEmail.trim()) return 'reachable';
    if (lead.enrichAttemptedAt) return 'nonePublished';
    if (!isEnrichEligible(lead)) return 'notAttempted';
    return lead.enrichmentInFlight ? 'pending' : 'missed';
}

/** The bucket each of the Contact column's chips belongs to — the map the test asserts. */
export const CONTACT_STATE_TO_BUCKET: Record<string, ContactBucket> = {
    role: 'reachable',
    personal: 'reachable',
    none: 'nonePublished',
    unchecked: 'notAttempted',
    checking: 'pending',
    missed: 'missed',
};
