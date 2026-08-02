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
// ── Fails CLOSED ─────────────────────────────────────────────────────────────
// Unlike the ledger and the thread helpers, this one does NOT swallow and continue. If we cannot
// determine whether an address is suppressed, we must not send: the cost of skipping a send is one
// delayed email, and the cost of sending to a suppressed domain is emailing a tenant's own
// customer as if they were a cold prospect. Those are not symmetric, so the error path returns
// `true` (treat as suppressed) rather than `false`.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { suppressionList } from '../../db/schema';

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

    try {
        const [hit] = await db
            .select({ reason: suppressionList.reason })
            .from(suppressionList)
            .where(and(
                eq(suppressionList.organisationId, organisationId),
                eq(suppressionList.domain, domain),
            ))
            .limit(1);
        return hit ? { suppressed: true, reason: hit.reason } : { suppressed: false };
    } catch (err) {
        // Fail closed — see the header. The one exception is a MISSING TABLE: on an environment
        // where suppression_list has never been created there is no list to violate, and failing
        // closed there would block every send in the product rather than protecting anyone.
        const pg = err as { code?: string; cause?: { code?: string } };
        const code = pg?.code ?? pg?.cause?.code;
        if (code === '42P01') {
            console.error('[suppression] suppression_list is missing — treating as empty', { organisationId });
            return { suppressed: false };
        }
        console.error('[suppression] lookup failed — treating as SUPPRESSED (fail closed)', {
            organisationId, domain, pgCode: code, cause: pg?.cause,
        }, err);
        return { suppressed: true, reason: null, unknown: true };
    }
}
