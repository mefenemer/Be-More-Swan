// src/utils/suppression.ts
// The READ side of suppression_list — "may we email this address at all?".
//
// ⚠️ This did not exist before Phase 2b. `suppression-sync.ts` has been POPULATING suppression_list
// from tenants' CRMs since the Integration Scenario Library shipped, but nothing ever read it: the
// list was written, indexed, and completely ignored at send time. So the existing `send_outreach`
// path has been able to cold-email an org's own existing customers despite the tenant having
// connected a CRM specifically to prevent that.
//
// docs/lead-generator-revenue-engine-plan.md §5.2 lists "global suppression check before every
// send" as non-negotiable and says "suppression-sync.ts already exists; use it" — which was half
// true. The list existed; the check did not. This module is that check, and it is wired into BOTH
// the sequence worker and the pre-existing opening-email path.
//
// ── Three lists, not two (2026-08-21) ────────────────────────────────────────
// It also asks the AUDIENCE now. A Lead Generator opt-out already blocked a newsletter, and a spam
// complaint already wrote a lead_opt_outs row — but a plain unsubscribe, or a 30/90-day pause from
// the preference centre, wrote nothing this side reads, so somebody could ask for quiet and be
// cold-emailed the following month. Owner's decision: the two POPULATIONS stay separate (a
// speculative prospect is never promoted into a mailing list) but a REFUSAL crosses.
// See src/utils/audience-objection.ts for why that is not checkAudienceConsent.
//
// ── Fails CLOSED ─────────────────────────────────────────────────────────────
// Unlike the ledger and the thread helpers, this one does NOT swallow and continue. If we cannot
// determine whether an address is suppressed, we must not send: the cost of skipping a send is one
// delayed email, and the cost of sending to a suppressed domain is emailing a tenant's own
// customer as if they were a cold prospect. Those are not symmetric, so the error path returns
// `true` (treat as suppressed) rather than `false`.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { suppressionList, leadOptOuts } from '../../db/schema';
import { audienceObjection } from './audience-objection';

type Db = ReturnType<typeof getDb>;

/**
 * The domain part of an email address, normalised the same way suppression-sync.ts writes it
 * (lowercased, no leading www., no path). Returns null when the input is not an address —
 * callers treat that as "no domain to check", which is safe because a send with no recipient
 * cannot happen anyway.
 */
export function emailDomain(email: string | null | undefined): string | null {
    if (!email) return null;
    const at = String(email).lastIndexOf('@');
    if (at < 0) return null;
    const host = String(email)
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/[^a-z0-9.-]/g, '');
    return host.includes('.') ? host : null;
}

export interface SuppressionVerdict {
    suppressed: boolean;
    /** Present when suppressed by a list entry — 'existing_customer', 'manual', etc. */
    reason?: string | null;
    /** True when the verdict is a fail-closed guess rather than a real lookup. */
    unknown?: boolean;
    /**
     * WHICH list blocked, because the callers do different things about it: an audience refusal
     * halts a cadence as `do_not_contact` and a domain hit halts it as `suppressed`, and the two
     * are different sentences on screen. Absent when nothing blocked.
     */
    source?: 'lead_opt_out' | 'suppression_list' | 'audience';
    /**
     * When a TEMPORARY block expires — set only for an audience pause.
     *
     * ⚠️ Callers that END something on a block (the sequence worker halts an enrolment) MUST treat
     * this as "not yet" rather than "stop". Nothing resumes a halted enrolment, so halting on a
     * 30-day pause would end the cadence for ever over a request for quiet.
     */
    retryAfter?: Date | null;
}

/**
 * Is this address on the organisation's suppression list?
 *
 * Matches on DOMAIN, not on the full address, because that is the grain suppression_list stores
 * and the grain that is actually useful: if a tenant's CRM says acme.co.uk is an existing
 * customer, emailing a different person at Acme as a cold prospect is the same mistake.
 */
export async function checkSuppression(
    db: Db,
    organisationId: number,
    email: string | null | undefined,
): Promise<SuppressionVerdict> {
    const domain = emailDomain(email);
    if (!domain) return { suppressed: false };

    // Individual opt-out first, and at ADDRESS grain. Checked before the domain list because it is
    // the stronger claim: a person who asked us to stop must not be emailed even if their employer
    // is otherwise a fine prospect. Same fail-closed contract as below.
    const addr = String(email).trim().toLowerCase();
    try {
        const [out] = await db
            .select({ reason: leadOptOuts.reason })
            .from(leadOptOuts)
            .where(and(
                eq(leadOptOuts.organisationId, organisationId),
                eq(leadOptOuts.email, addr),
            ))
            .limit(1);
        if (out) return { suppressed: true, reason: out.reason, source: 'lead_opt_out' };
    } catch (err) {
        const pg = err as { code?: string; cause?: { code?: string } };
        const code = pg?.code ?? pg?.cause?.code;
        // A missing table means the opt-out feature has not been applied to this environment yet —
        // there are no opt-outs to violate, so fall through to the domain check rather than
        // blocking every send in the product. Any OTHER error fails closed.
        if (code !== '42P01') {
            console.error('[suppression] opt-out lookup failed — treating as SUPPRESSED (fail closed)', {
                organisationId, pgCode: code, cause: pg?.cause,
            }, err);
            return { suppressed: true, reason: null, unknown: true, source: 'lead_opt_out' };
        }
        console.error('[suppression] lead_opt_outs is missing — treating as empty', { organisationId });
    }

    try {
        const [hit] = await db
            .select({ reason: suppressionList.reason })
            .from(suppressionList)
            .where(and(
                eq(suppressionList.organisationId, organisationId),
                eq(suppressionList.domain, domain),
            ))
            .limit(1);
        if (hit) return { suppressed: true, reason: hit.reason, source: 'suppression_list' };
    } catch (err) {
        // Fail closed — see the header. The one exception is a MISSING TABLE: on an environment
        // where suppression_list has never been created there is no list to violate, and failing
        // closed there would block every send in the product rather than protecting anyone.
        const pg = err as { code?: string; cause?: { code?: string } };
        const code = pg?.code ?? pg?.cause?.code;
        if (code !== '42P01') {
            console.error('[suppression] lookup failed — treating as SUPPRESSED (fail closed)', {
                organisationId, domain, pgCode: code, cause: pg?.cause,
            }, err);
            return { suppressed: true, reason: null, unknown: true, source: 'suppression_list' };
        }
        console.error('[suppression] suppression_list is missing — treating as empty', { organisationId });
    }

    return audienceRefusal(db, organisationId, email);
}

/**
 * Nothing on the lead side blocks this address — now ask the AUDIENCE whether the person has told
 * this organisation to stop.
 *
 * ⚠️ LAST, after both lead-side checks, and that ordering is what keeps the reported reason honest:
 * those two are permanent and describe the tenant's own lists, while the only temporary block in
 * the product is an audience pause. A pause reported over a suppression would tell the caller to
 * retry in 90 days on something it must never retry.
 *
 * ⚠️ Folded in HERE rather than added to the three send sites. checkSuppression is already the one
 * DB-backed "may we email this address at all" gate wired into every outreach path
 * (lead-generation.ts, lead-threads.ts, process-sequence-sends.ts), and a fourth send site added
 * later inherits this for free. Three parallel call-site edits is how one of them gets missed.
 */
async function audienceRefusal(
    db: Db,
    organisationId: number,
    email: string | null | undefined,
): Promise<SuppressionVerdict> {
    const objection = await audienceObjection(db, organisationId, email);
    if (!objection) return { suppressed: false };
    return {
        suppressed: true,
        // The human sentence when there is one — these reach a halt row and an on-screen message.
        reason: objection.detail ?? objection.reason,
        source: 'audience',
        unknown: objection.unknown,
        retryAfter: objection.retryAfter,
    };
}
