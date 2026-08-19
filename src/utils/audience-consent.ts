// src/utils/audience-consent.ts
// "May this organisation email this address right now?" — the ONE answer, for every assistant.
//
// This module is the whole cross-assistant promise made concrete. A person who unsubscribes from a
// newsletter must also stop receiving Lead Generator outreach, and a prospect who told the Lead
// Generator to stop must never appear in a newsletter send. Those two facts live in different
// tables written by different features, so the only way they can agree is if there is exactly one
// place that reads them all — this one. Every future assistant (Campaign, Ad Buyer, Onboarding)
// calls this and nothing else.
//
// ── What it consults, in precedence order ───────────────────────────────────────────────────────
//   1. audience_contacts.status   — the tenant's own audience state (positive gate: no row, no send)
//   2. lead_opt_outs              — address-grained opt-outs from cold outreach (db/lead-opt-outs.sql)
//   3. suppression_list           — domain-grained "this company is already our customer"
//
// The precedence for 2 and 3 deliberately mirrors src/utils/suppression.ts — address before
// domain, because an individual's opt-out is the stronger and more specific claim. That module
// remains the canonical rule for the LEAD side; this one re-implements the same precedence over
// SET-BASED reads because a newsletter send resolves thousands of addresses at once and calling a
// per-address helper would issue two queries per recipient. tests/audience-consent.test.ts asserts
// the two agree on the same fixtures — a reader that disagrees with the other reader is the exact
// failure that let suppression_list sit unread for months.
//
// ── Fails CLOSED ────────────────────────────────────────────────────────────────────────────────
// If we cannot determine whether an address may be emailed, we do not email it. Skipping a send
// costs one delayed newsletter; sending to someone who opted out costs a complaint, a legal
// exposure, and the sending domain's reputation. Those are not symmetric. A lookup failure yields
// `consent_check_failed`, and the send worker records that on the ledger row rather than silently
// dropping the recipient — an unexplained gap in a send is indistinguishable from a bug.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceContacts, leadOptOuts, suppressionList } from '../../db/schema';
import { emailDomain } from './suppression';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';

type Db = ReturnType<typeof getDb>;

/**
 * Why an address was not mailed. Every value here is also a legal value of
 * newsletter_sends.skip_reason (db/newsletter.sql) — the ledger stores the verdict verbatim, so
 * adding a reason here means widening that CHECK constraint in the same change.
 */
export type AudienceSkipReason =
    | 'invalid_address'
    | 'not_in_audience'
    | 'unconfirmed'
    | 'opted_out'
    | 'suppressed'
    | 'bounced_previously'
    | 'complained_previously'
    | 'consent_check_failed';

export interface AudienceVerdict {
    sendable: boolean;
    reason: AudienceSkipReason | null;
    /** Human-readable detail for the UI ("opted out of outreach on 3 May"). Never shown to the recipient. */
    detail?: string | null;
    /** True when the verdict is a fail-closed guess rather than a completed lookup. */
    unknown?: boolean;
}

/** Copy for the Audience UI and the send report. Keep in step with AudienceSkipReason. */
export const SKIP_REASON_LABEL: Record<AudienceSkipReason, string> = {
    invalid_address:       'Not a valid email address',
    not_in_audience:       'No longer in your audience',
    unconfirmed:           'Has not confirmed their subscription',
    opted_out:             'Unsubscribed',
    suppressed:            'On your suppression list',
    bounced_previously:    'Previous email bounced',
    complained_previously: 'Marked a previous email as spam',
    consent_check_failed:  'Consent could not be checked — not sent',
};

const SENDABLE: AudienceVerdict = { sendable: true, reason: null };

/** Contact status → verdict. `subscribed` is the ONLY status that can proceed. */
function statusVerdict(status: string): AudienceVerdict | null {
    switch (status) {
        case 'subscribed':   return null;                 // continue to the opt-out checks
        // ⚠️ 'pending' is the double-opt-in waiting room. Mailing it would make double opt-in
        // decorative — the entire point is that an unconfirmed address is never sent to.
        case 'pending':      return { sendable: false, reason: 'unconfirmed' };
        case 'unsubscribed': return { sendable: false, reason: 'opted_out' };
        case 'bounced':      return { sendable: false, reason: 'bounced_previously' };
        case 'complained':   return { sendable: false, reason: 'complained_previously' };
        case 'suppressed':   return { sendable: false, reason: 'suppressed' };
        // An unknown status is a schema drift, not a licence to send.
        default:             return { sendable: false, reason: 'consent_check_failed', unknown: true };
    }
}

/** inArray with thousands of values builds a query nobody wants to debug. */
const CHUNK = 500;
const chunk = <T>(xs: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
    return out;
};

/** A lookup that failed for a reason other than "table not applied here". */
function isMissingTable(err: unknown): boolean {
    const pg = err as { code?: string; cause?: { code?: string } };
    return (pg?.code ?? pg?.cause?.code) === '42P01';
}

/**
 * Resolve consent for many addresses at once.
 *
 * Returns a Map keyed by the NORMALISED address (see normaliseEmail) — callers that keep the raw
 * form must normalise before looking a verdict up, or they will miss every row.
 */
export async function checkAudienceConsentBulk(
    db: Db,
    organisationId: number,
    emails: readonly (string | null | undefined)[],
): Promise<Map<string, AudienceVerdict>> {
    const verdicts = new Map<string, AudienceVerdict>();

    // Deduplicate before querying: a segment and the whole-audience fallback can name the same
    // person twice, and sending them the issue twice is the complaint we are trying to avoid.
    // ⚠️ A blank entry produces NO map entry — there is no key to store it under. Callers must
    // treat a missing verdict as unsendable, which is what the send worker does.
    const valid: string[] = [];
    const seen = new Set<string>();
    for (const raw of emails) {
        const email = normaliseEmail(raw);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        if (!looksLikeEmail(email)) {
            verdicts.set(email, { sendable: false, reason: 'invalid_address' });
            continue;
        }
        valid.push(email);
    }
    if (!valid.length) return verdicts;

    // ── 1. The audience itself. A POSITIVE gate: an address with no contact row is not mailable,
    // which is also what makes a missing table safe — it degrades to "nobody is subscribed".
    const contacts = new Map<string, { status: string; unsubscribedAt: Date | null }>();
    try {
        for (const part of chunk(valid)) {
            const rows = await db
                .select({
                    email: audienceContacts.email,
                    status: audienceContacts.status,
                    unsubscribedAt: audienceContacts.unsubscribedAt,
                })
                .from(audienceContacts)
                .where(and(
                    eq(audienceContacts.organisationId, organisationId),
                    inArray(audienceContacts.email, part),
                ));
            for (const r of rows) contacts.set(r.email, { status: r.status, unsubscribedAt: r.unsubscribedAt });
        }
    } catch (err) {
        // No 42P01 exemption here, unlike the two lists below. Those answer "is this address
        // BLOCKED?", where an absent table genuinely means "nothing blocks it". This one answers
        // "is this address SUBSCRIBED?", and an absent table cannot mean yes.
        console.error('[audience-consent] contact lookup failed — treating every address as UNSENDABLE (fail closed)', {
            organisationId, count: valid.length,
        }, err);
        for (const e of valid) verdicts.set(e, { sendable: false, reason: 'consent_check_failed', unknown: true });
        return verdicts;
    }

    // ── 2. Cold-outreach opt-outs, address grain. THE cross-assistant binding: someone who told
    // the Lead Generator to stop is not a newsletter recipient, whatever the audience row says.
    const optedOut = new Map<string, string | null>();
    let optOutUnknown = false;
    try {
        for (const part of chunk(valid)) {
            const rows = await db
                .select({ email: leadOptOuts.email, reason: leadOptOuts.reason })
                .from(leadOptOuts)
                .where(and(
                    eq(leadOptOuts.organisationId, organisationId),
                    inArray(leadOptOuts.email, part),
                ));
            for (const r of rows) optedOut.set(r.email, r.reason);
        }
    } catch (err) {
        if (isMissingTable(err)) {
            console.error('[audience-consent] lead_opt_outs is missing — treating as empty', { organisationId });
        } else {
            console.error('[audience-consent] opt-out lookup failed — treating as UNSENDABLE (fail closed)', { organisationId }, err);
            optOutUnknown = true;
        }
    }

    // ── 3. Suppression list, DOMAIN grain (same normalisation as suppression.ts).
    const domains = [...new Set(valid.map((e) => emailDomain(e)).filter((d): d is string => !!d))];
    const suppressedDomains = new Map<string, string | null>();
    let suppressionUnknown = false;
    if (domains.length) {
        try {
            for (const part of chunk(domains)) {
                const rows = await db
                    .select({ domain: suppressionList.domain, reason: suppressionList.reason })
                    .from(suppressionList)
                    .where(and(
                        eq(suppressionList.organisationId, organisationId),
                        inArray(suppressionList.domain, part),
                    ));
                for (const r of rows) suppressedDomains.set(r.domain, r.reason);
            }
        } catch (err) {
            if (isMissingTable(err)) {
                console.error('[audience-consent] suppression_list is missing — treating as empty', { organisationId });
            } else {
                console.error('[audience-consent] suppression lookup failed — treating as UNSENDABLE (fail closed)', { organisationId }, err);
                suppressionUnknown = true;
            }
        }
    }

    for (const email of valid) {
        if (verdicts.has(email)) continue;

        // A failed block-list lookup outranks everything below it: we cannot prove this address is
        // not blocked, so we do not send. Placed before the contact check so a broken database
        // never reads as "this person simply is not subscribed".
        if (optOutUnknown || suppressionUnknown) {
            verdicts.set(email, { sendable: false, reason: 'consent_check_failed', unknown: true });
            continue;
        }

        const contact = contacts.get(email);
        if (!contact) {
            verdicts.set(email, { sendable: false, reason: 'not_in_audience' });
            continue;
        }

        const byStatus = statusVerdict(contact.status);
        if (byStatus) {
            verdicts.set(email, byStatus);
            continue;
        }

        const optOutReason = optedOut.get(email);
        if (optOutReason !== undefined) {
            // Subscribed here, opted out there. The opt-out wins, always.
            verdicts.set(email, {
                sendable: false,
                reason: 'opted_out',
                detail: optOutReason ? `Opted out of outreach (${optOutReason})` : 'Opted out of outreach',
            });
            continue;
        }

        const domain = emailDomain(email);
        if (domain && suppressedDomains.has(domain)) {
            verdicts.set(email, {
                sendable: false,
                reason: 'suppressed',
                detail: suppressedDomains.get(domain) || null,
            });
            continue;
        }

        verdicts.set(email, SENDABLE);
    }

    return verdicts;
}

/**
 * Single-address form. Implemented ON TOP of the bulk path rather than beside it — two
 * implementations of "may we email this person" is precisely the drift this module exists to
 * prevent.
 */
export async function checkAudienceConsent(
    db: Db,
    organisationId: number,
    email: string | null | undefined,
): Promise<AudienceVerdict> {
    const key = normaliseEmail(email);
    if (!key) return { sendable: false, reason: 'invalid_address' };
    const map = await checkAudienceConsentBulk(db, organisationId, [key]);
    return map.get(key) ?? { sendable: false, reason: 'consent_check_failed', unknown: true };
}
