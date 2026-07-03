// src/utils/billing-fingerprint.ts
// Abuse Prevention US3 — Stripe Fingerprint Monitoring.
//
// Records a workspace's payment-method card fingerprint (a stable Stripe hash of the physical
// card — never the PAN) and silently flags account-splitting: if the same fingerprint is active
// on two or more separate workspaces, all of them get billing_review_required = true for a
// Superadmin to review (US3 AC3.2). Best-effort — never let this break webhook processing.

import { eq, inArray, and, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { organisations } from '../../db/schema';

export async function recordCardFingerprint(
    db: PostgresJsDatabase<any>,
    organisationId: number,
    fingerprint: string | null | undefined,
): Promise<void> {
    if (!fingerprint || !organisationId) return;

    try {
        await db.update(organisations)
            .set({ cardFingerprint: fingerprint, updatedAt: new Date() })
            .where(eq(organisations.id, organisationId));

        // Any OTHER workspace already using this exact card?
        const others = await db.select({ id: organisations.id }).from(organisations)
            .where(and(eq(organisations.cardFingerprint, fingerprint), ne(organisations.id, organisationId)))
            .limit(1);

        if (others.length > 0) {
            // Flag every workspace sharing this fingerprint (this one + the others) for review.
            const all = await db.select({ id: organisations.id }).from(organisations)
                .where(eq(organisations.cardFingerprint, fingerprint));
            await db.update(organisations)
                .set({ billingReviewRequired: true, updatedAt: new Date() })
                .where(inArray(organisations.id, all.map(o => o.id)));
        }
    } catch (e) {
        console.warn('[billing-fingerprint] recordCardFingerprint failed (non-blocking):', e);
    }
}
