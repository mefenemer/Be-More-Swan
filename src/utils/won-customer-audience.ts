// src/utils/won-customer-audience.ts
// A lead marked WON becomes a customer, and its owner may add them to the Audience so the Email
// Marketing Assistant can email them. The ONLY writer of source = 'lead_promotion'.
//
// ⚠️ Customers only — never prospects. Decided 2026-10-11, narrowing the 2026-08-21 rule that kept
// leads and the Audience apart: a cold lead has given no permission to be sent marketing, a customer
// can be emailed under SOFT OPT-IN (UK PECR reg. 22(3): details obtained in the course of a sale,
// similar products, a simple way to refuse at collection and in every message). The "in every
// message" half is already true — every Audience send carries the unsubscribe link. The "at
// collection" half is the owner's tick in the Record outcome dialog, which is why this never runs
// without one (`addToAudience: true` on set_outcome).
//
// Refusals win, always:
//   • an address that opted out of outreach (lead_opt_outs, address grain) is NOT added;
//   • an address already in the Audience keeps its status — upsertContact's ratchet never lifts
//     unsubscribed / bounced / complained / suppressed.
// Domain-level suppression (checkSuppression's CRM customer list) is deliberately NOT consulted: it
// exists to stop COLD outreach to existing customers, which is the opposite of this case.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { leadOptOuts } from '../../db/schema';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { recordConsentEvent, upsertContact } from './audience-store';

type Db = ReturnType<typeof getDb>;

export type WonAudienceResult =
    | { result: 'added'; email: string; contactId: number }
    | { result: 'already'; email: string; contactId: number; status: string }
    | { result: 'no_email' }
    | { result: 'opted_out'; email: string };

/** The address a lead record holds, in the order the send path resolves it. */
export function leadEmail(data: Record<string, unknown>): string {
    const draft = (data.outreachDraft && typeof data.outreachDraft === 'object') ? data.outreachDraft as Record<string, unknown> : {};
    const lead = (data.lead && typeof data.lead === 'object') ? data.lead as Record<string, unknown> : {};
    for (const v of [draft.to, data.contactEmail, lead.email]) {
        const e = normaliseEmail(typeof v === 'string' ? v : '');
        if (looksLikeEmail(e)) return e;
    }
    return '';
}

function splitName(full: unknown): { firstName: string | null; lastName: string | null } {
    const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { firstName: null, lastName: null };
    return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

export async function addWonCustomerToAudience(db: Db, input: {
    organisationId: number;
    userId: number | null;
    recordId: number;
    company: string | null;
    data: Record<string, unknown>;
}): Promise<WonAudienceResult> {
    const email = leadEmail(input.data);
    if (!email) return { result: 'no_email' };

    const [optOut] = await db.select({ id: leadOptOuts.id }).from(leadOptOuts)
        .where(and(eq(leadOptOuts.organisationId, input.organisationId), eq(leadOptOuts.email, email))).limit(1);
    if (optOut) return { result: 'opted_out', email };

    const { firstName, lastName } = splitName(input.data.contactName);
    const contact = await upsertContact(db, {
        organisationId: input.organisationId,
        email,
        firstName,
        lastName,
        company: input.company,
        status: 'subscribed',
        source: 'lead_promotion',
        sourceDetail: { assistantRecordId: input.recordId },
        consentBasis: 'soft_opt_in',
        confirmedAt: new Date(),
    });

    if (!contact.created) return { result: 'already', email, contactId: contact.id, status: contact.status };

    // The lawful basis, written down. Throws on failure by design (see recordConsentEvent) — the
    // caller reports it rather than leaving a contact nobody can justify holding.
    await recordConsentEvent(db, {
        organisationId: input.organisationId,
        contactId: contact.id,
        email,
        event: 'promoted',
        channel: 'admin',
        evidence: `Became a customer: lead ${input.recordId} marked won by user ${input.userId ?? 'unknown'}, who chose to add them to the Audience. Basis: soft opt-in (existing customer). Every email carries an unsubscribe link.`,
    });
    return { result: 'added', email, contactId: contact.id };
}
