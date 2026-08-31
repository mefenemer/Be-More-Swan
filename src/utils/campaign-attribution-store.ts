// src/utils/campaign-attribution-store.ts
// The ONE way to write a campaign_attributions row. Modelled on revenue-ledger.ts — same
// contract, same reasons.
//
//   await bindConversion(db, {
//       organisationId: orgId,
//       subjectType: 'audience_contact',
//       subjectId: contactId,
//       pageUrl: body.url,
//       cookieHeader: event.headers.cookie,
//   });
//
// Pure decision logic is src/utils/campaign-attribution.ts; tables are db/campaign-attribution.sql.
//
// ── Never throws ────────────────────────────────────────────────────────────────────────────────
// Attribution is an OBSERVER of the journey, never a participant. This function is called from the
// public sign-up path, and a person who filled in a form must end up subscribed whether or not we
// manage to work out which advert sent them. So it resolves, logs and swallows. Callers need no
// try/catch and should NOT add one.
//
// The corollary, which is the thing to remember: a silent no-op is a real outcome here. If a
// campaign shows conversions it should have caught, look for the console.error below before
// assuming the click was never recorded.
//
// ── Why binding happens at CAPTURE, not at confirmation ─────────────────────────────────────────
// A double opt-in contact is written as 'pending' and may never confirm. We bind anyway, at the
// moment the row is created, because attribution is a fact about where somebody came from — it
// does not become true later. Whether a pending contact COUNTS as a conversion is a reporting
// question, and the funnel answers it separately. Deferring the binding to confirmation would lose
// the click ref entirely: the confirmation arrives from an email client, on a different request,
// with no page URL and no cookie.

import { and, desc, eq, gte } from 'drizzle-orm';
import { campaignAttributions, campaignClickEvents } from '../../db/schema';
import {
    ATTRIBUTION_WINDOW_DAYS, CLICK_REF_PARAM, chooseBinding, readVisitorCookie,
    type BindingCandidate,
} from './campaign-attribution';

/**
 * Minimal structural type for a drizzle handle, so this works with the top-level db from getDb()
 * and with a transaction handle — the same accommodation revenue-ledger.ts makes.
 */
type Db = {
    select: (fields?: any) => any;
    insert: (table: any) => any;
};

/** How many of a visitor's recent clicks to consider. */
const MAX_COOKIE_CANDIDATES = 20;

export type AttributionSubjectType = 'audience_contact' | 'discovered_lead' | 'assistant_record';

export interface BindConversionInput {
    organisationId: number;
    subjectType: AttributionSubjectType;
    subjectId: number;
    /** The page the conversion happened on. Both form callers send `location.href`. */
    pageUrl?: string | null;
    /** The raw Cookie header off the request. */
    cookieHeader?: string | null;
    /** Injectable for tests. */
    now?: Date;
}

/**
 * Pull our click ref off the page URL the form reported.
 *
 * ⚠️ This is why no client change was needed to ship binding: subscribe.js and the hosted page
 * both already post `url: location.href`, and the redirector already appends `?bmsc=` to the
 * destination. The parameter arrives on its own.
 *
 * Returns null for a malformed URL rather than throwing — `body.url` is caller-supplied and
 * arrives malformed regularly.
 */
export function clickRefFromPageUrl(pageUrl: string | null | undefined): string | null {
    if (!pageUrl) return null;
    try {
        const value = new URL(pageUrl).searchParams.get(CLICK_REF_PARAM);
        // Length-capped: this is an attacker-supplied string heading for a WHERE clause.
        return value && value.length <= 64 ? value : null;
    } catch {
        return null;
    }
}

/**
 * Tie a newly captured person to the campaign click that brought them, if there was one.
 *
 * Returns the attribution's `boundVia` on success, or null when nothing matched — and **null is a
 * frequent, correct answer**. Most sign-ups are not from a campaign, and of those that are, some
 * arrive with the cookie stripped and the query string rewritten. That gap is reported as
 * unattributed by the funnel; it is never quietly assigned to whichever campaign is running.
 */
export async function bindConversion(
    db: Db,
    input: BindConversionInput,
): Promise<'click_ref' | 'cookie' | null> {
    try {
        const now = input.now ?? new Date();
        const windowStart = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const clickRef = clickRefFromPageUrl(input.pageUrl);
        const visitorId = readVisitorCookie(input.cookieHeader);
        // Nothing to go on. The overwhelmingly common case — return before touching the database,
        // so an unattributed sign-up costs two string operations rather than two queries.
        if (!clickRef && !visitorId) return null;

        const columns = {
            clickEventId: campaignClickEvents.id,
            campaignId: campaignClickEvents.campaignId,
            linkId: campaignClickEvents.linkId,
            organisationId: campaignClickEvents.organisationId,
            occurredAt: campaignClickEvents.occurredAt,
        };

        // ⚠️ EVERY LOOKUP IS SCOPED TO THE SUBJECT'S ORGANISATION. Both keys are attacker-supplied
        // — a click ref is visible in the address bar, and a cookie can be replayed — so without
        // this scope someone could paste another tenant's bmsc onto a sign-up form and attach
        // their own conversion to that tenant's campaign. The org scope makes the worst case
        // "a tenant can attribute their own conversion to their own campaign", which is not an
        // attack, it is just the feature.
        const [byClickRef]: BindingCandidate[] = clickRef
            ? await db.select(columns).from(campaignClickEvents)
                .where(and(
                    eq(campaignClickEvents.clickRef, clickRef),
                    eq(campaignClickEvents.organisationId, input.organisationId),
                ))
                .limit(1)
            : [];

        const byCookie: BindingCandidate[] = visitorId
            ? await db.select(columns).from(campaignClickEvents)
                .where(and(
                    eq(campaignClickEvents.visitorId, visitorId),
                    eq(campaignClickEvents.organisationId, input.organisationId),
                    gte(campaignClickEvents.occurredAt, windowStart),
                ))
                .orderBy(desc(campaignClickEvents.occurredAt))
                .limit(MAX_COOKIE_CANDIDATES)
            : [];

        const decision = chooseBinding(byClickRef ?? null, byCookie, now);
        if (!decision) return null;

        // ⚠️ FIRST BINDING WINS — onConflictDoNothing against the unique index on
        // (subject_type, subject_id). Re-submitting the form is not a second capture, and letting
        // a later submission overwrite the first would let anyone re-attribute an existing contact
        // by typing a known address into a form with their own bmsc on the URL.
        await db.insert(campaignAttributions).values({
            organisationId: input.organisationId,
            campaignId: decision.candidate.campaignId,
            linkId: decision.candidate.linkId,
            clickEventId: decision.candidate.clickEventId,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            boundVia: decision.boundVia,
        }).onConflictDoNothing();

        return decision.boundVia;
    } catch (err) {
        console.error('[campaign-attribution] conversion not bound', {
            subjectType: input.subjectType, subjectId: input.subjectId,
        }, err);
        return null;
    }
}
