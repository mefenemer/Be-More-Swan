// src/utils/enquiry-audience.ts
// Someone who wrote through a website's contact form joins the Audience (owner, 2026-10-17) — but
// only with their agreement, because an enquiry is not permission to send marketing:
//
//   • they ticked "Send me news and offers by email" on the form   → basis single_opt_in, their own act
//   • the owner adds them from the Enquiries tab, saying they agreed → basis manual_entry, the owner's word
//
// Without either, an enquiry stays an enquiry (the Enquiries tab, and the email to the owner).
// Refusals win, as everywhere in the Audience: upsertContact never lifts an unsubscribe, bounce or
// complaint, so an address that said stop is not re-subscribed by writing in again.

import type { getDb } from '../../db/client';
import { applyTagsByName, recordConsentEvent, upsertContact } from './audience-store';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';

type Db = ReturnType<typeof getDb>;

/** The tag every website enquirer carries in the Audience, so they can be found and segmented. */
export const ENQUIRY_TAG = 'Website enquiry';

export type EnquiryAudienceResult =
    | { result: 'added'; contactId: number }
    | { result: 'already'; contactId: number; status: string }
    | { result: 'no_email' };

export function splitName(name: string): { firstName: string | null; lastName: string | null } {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { firstName: null, lastName: null };
    return { firstName: parts[0].slice(0, 100), lastName: parts.length > 1 ? parts.slice(1).join(' ').slice(0, 100) : null };
}

export async function addEnquirerToAudience(db: Db, input: {
    organisationId: number;
    email: string;
    name: string;
    enquiryId: number;
    /** 'form': they ticked the box. 'owner': the owner added them, saying they agreed. */
    by: 'form' | { userId: number };
    sourceUrl?: string | null;
    ipHash?: string | null;
    userAgent?: string | null;
}): Promise<EnquiryAudienceResult> {
    const email = normaliseEmail(input.email);
    if (!looksLikeEmail(email)) return { result: 'no_email' };
    const fromForm = input.by === 'form';
    const contact = await upsertContact(db, {
        organisationId: input.organisationId,
        email,
        ...splitName(input.name),
        status: 'subscribed',
        source: fromForm ? 'web_form' : 'manual',
        sourceDetail: { siteEnquiryId: input.enquiryId },
        consentBasis: fromForm ? 'single_opt_in' : 'manual_entry',
        confirmedAt: new Date(),
    });
    await applyTagsByName(db, input.organisationId, contact.id, [ENQUIRY_TAG]);
    if (!contact.created) return { result: 'already', contactId: contact.id, status: contact.status };
    // The lawful basis, written down. Throws by design (recordConsentEvent): the caller reports it.
    await recordConsentEvent(db, {
        organisationId: input.organisationId,
        contactId: contact.id,
        email,
        event: fromForm ? 'confirmed' : 'manual_added',
        channel: fromForm ? 'site' : 'admin',
        sourceUrl: input.sourceUrl ?? null,
        ipHash: input.ipHash ?? null,
        userAgent: input.userAgent ?? null,
        evidence: fromForm
            ? `Ticked "Send me news and offers by email" on the website contact form (enquiry ${input.enquiryId}). Basis: single opt-in. Every email carries an unsubscribe link.`
            : `Added from website enquiry ${input.enquiryId} by user ${(input.by as { userId: number }).userId}, who confirmed the person agreed to receive emails. Every email carries an unsubscribe link.`,
    });
    return { result: 'added', contactId: contact.id };
}
