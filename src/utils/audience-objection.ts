// src/utils/audience-objection.ts
// "Has this person told the ORGANISATION to stop, on the audience side?" — asked before cold
// outreach, so an unsubscribe or a pause reaches the Lead Generator too.
//
// ── Why this is not checkAudienceConsent ────────────────────────────────────────────────────────
// audience-consent.ts asks "may we send this person a NEWSLETTER", and it is a POSITIVE gate: no
// contact row means `not_in_audience` means refuse. That is exactly right for a mailing list and
// exactly wrong here — a cold prospect is by definition not in the audience, so calling that
// resolver from the outreach path would block every cold email in the product.
//
// So this asks the narrower question, and the difference is entirely in what ABSENCE means:
//
//                          audience-consent            this module
//   no contact row         refuse (not_in_audience)    no objection — the lead side decides
//   'pending'              refuse (unconfirmed)        no objection *
//   'unsubscribed'         refuse                      OBJECTION
//   paused until a date    refuse (temporary)          OBJECTION, temporary
//
// * ⚠️ `pending` is the double-opt-in waiting room. It means "we have no confirmation to send them
//   a newsletter", which is a statement about the mailing list, not a refusal by the person. A
//   half-finished newsletter signup must not silently delete a prospect from the sales pipeline.
//
// ── The direction this closes ───────────────────────────────────────────────────────────────────
// A Lead Generator opt-out already blocks a newsletter (audience-consent.ts reads lead_opt_outs),
// and a spam complaint already writes lead_opt_outs. But a PLAIN UNSUBSCRIBE, and a 30/90-day
// pause from the preference centre, wrote nothing the outreach side reads — so somebody could ask
// for quiet through the preference centre and be cold-emailed the following month.
//
// ⚠️ Not solved by writing a lead_opt_outs row on unsubscribe, which was the obvious fix: that
// table has no expiry and, by the DELETE RULE in audience-contacts.ts, deliberately no removal
// path. A 90-day pause recorded there would be permanent, and a resubscribe could never undo it.
// A pause has to stay a timestamp compared against the clock, so it lifts itself.
//
// ⚠️ Type-only import from audience-consent.ts, deliberately. That module imports emailDomain from
// suppression.ts and suppression.ts calls this one, so a VALUE import here would close a runtime
// cycle. `import type` is erased at compile time and cannot.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceContacts } from '../../db/schema';
import { normaliseEmail } from './audience-contacts';
import type { AudienceSkipReason } from './audience-consent';

type Db = ReturnType<typeof getDb>;

export interface AudienceObjection {
    reason: AudienceSkipReason;
    detail: string | null;
    /** Set only for a pause: when the refusal expires. Callers that schedule must DEFER to it. */
    retryAfter: Date | null;
    /** True when this is a fail-closed guess rather than a completed lookup. */
    unknown?: boolean;
}

/**
 * Statuses that are a refusal by the PERSON or a fact about the ADDRESS, and so bind every send.
 *
 * ⚠️ Keep in step with audience_contacts_status_check (db/audience.sql). An unrecognised status is
 * schema drift and fails closed below — it is not a licence to send.
 */
const OBJECTING: Record<string, { reason: AudienceSkipReason; detail: string }> = {
    unsubscribed: { reason: 'opted_out',             detail: 'Unsubscribed from your emails' },
    complained:   { reason: 'complained_previously', detail: 'Reported one of your emails as spam' },
    bounced:      { reason: 'bounced_previously',    detail: 'A previous email to this address bounced' },
    suppressed:   { reason: 'suppressed',            detail: 'Suppressed on your audience' },
};

/** Statuses that carry no objection to outreach. See the `pending` note in the header. */
const SILENT = new Set(['subscribed', 'pending']);

/**
 * Does the organisation's audience record a refusal for this address?
 *
 * `null` means "no objection here" — NOT "safe to send". The caller's own gates (suppression,
 * lead_opt_outs, do-not-contact) still apply and run first.
 */
export async function audienceObjection(
    db: Db,
    organisationId: number,
    email: string | null | undefined,
): Promise<AudienceObjection | null> {
    const key = normaliseEmail(email);
    // No address to look up cannot be an audience refusal. The send paths reject a blank recipient
    // on their own, and inventing an objection here would misreport why.
    if (!key) return null;

    let contact: { status: string; pausedUntil: Date | null } | undefined;
    try {
        [contact] = await db
            .select({ status: audienceContacts.status, pausedUntil: audienceContacts.pausedUntil })
            .from(audienceContacts)
            .where(and(
                eq(audienceContacts.organisationId, organisationId),
                eq(audienceContacts.email, key),
            ))
            .limit(1);
    } catch (err) {
        const pg = err as { code?: string; cause?: { code?: string } };
        const code = pg?.code ?? pg?.cause?.code;
        // ⚠️ A missing table is NOT fail-closed here, and the asymmetry is deliberate. On an
        // environment without db/audience.sql there is no audience, so there is no refusal to
        // violate — failing closed would block every cold email in the product to protect nobody.
        // Any OTHER error is a lookup we could not complete, and that does fail closed.
        if (code === '42P01') {
            console.error('[audience-objection] audience_contacts is missing — treating as no objection', { organisationId });
            return null;
        }
        console.error('[audience-objection] lookup failed — treating as OBJECTED (fail closed)', {
            organisationId, pgCode: code, cause: pg?.cause,
        }, err);
        return { reason: 'consent_check_failed', detail: null, retryAfter: null, unknown: true };
    }

    if (!contact) return null;

    const objection = OBJECTING[contact.status];
    if (objection) return { ...objection, retryAfter: null };

    if (!SILENT.has(contact.status)) {
        return { reason: 'consent_check_failed', detail: `Unrecognised audience status '${contact.status}'`, retryAfter: null, unknown: true };
    }

    // ⚠️ LAST, mirroring the ladder in audience-consent.ts: a pause is the only TEMPORARY refusal,
    // so every permanent one outranks it. Reporting 'paused' for somebody who actually unsubscribed
    // would tell a caller to retry in 90 days on what it should never retry.
    if (contact.pausedUntil && contact.pausedUntil.getTime() > Date.now()) {
        return {
            reason: 'paused',
            detail: `Asked for no emails until ${contact.pausedUntil.toISOString().slice(0, 10)}`,
            retryAfter: contact.pausedUntil,
        };
    }

    return null;
}
