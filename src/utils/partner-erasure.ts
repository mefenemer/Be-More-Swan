// src/utils/partner-erasure.ts
// Affiliate Partner Programme, step 9 — a partner's personal data on erasure and account deletion
// (docs/affiliate-partner-programme-plan.md §4.8; privacy.html §9).
//
// What goes: the application (name, email, answers), the decision note, VAT number, partner code,
// invite and payout-change tokens, the masked payout summary, and the payout details themselves (the
// vault secrets aura/partner-<id>/payout and …/payout-pending).
// What stays: the commission and payout ledger — amounts, dates, statuses — because tax law requires
// payment records for 7 years. It no longer identifies anyone once this has run (the user row is
// anonymised or deleted by the caller).
// The partner is left SUSPENDED: nothing new is earned, and with no payout details nothing more can
// be paid out.
//
// Callers: admin-gdpr-erase.ts, user-deletion.ts deleteUserAndSoleOrgs, account-delete-execute.ts,
// and admin-partners.ts erase (an applicant with no account). Each runs this BEFORE the user row goes.

import { and, eq, isNull, lt, notExists, sql } from 'drizzle-orm';
import { partnerCommissions, partners } from '../../db/schema';
import { deleteSecret } from './vault';
import { payoutRefKey, pendingPayoutRefKey } from './partner-payouts';

type Db = any;   // the app db or a transaction

export async function erasePartnerRow(db: Db, partnerId: number): Promise<void> {
    await deleteSecret(db, payoutRefKey(partnerId));
    await deleteSecret(db, pendingPayoutRefKey(partnerId));
    await db.update(partners).set({
        status: 'suspended',
        applicantName: null, applicantEmail: null, application: { erased: true }, decisionNote: 'Personal data erased on request',
        vatNumber: null, vatRegistered: false, promoCode: null,
        inviteTokenHash: null, inviteExpiresAt: null,
        payoutDisplay: null, payoutMethod: null, payoutDetailsConfirmedAt: null,
        payoutPendingMethod: null, payoutPendingDisplay: null, payoutPendingTokenHash: null, payoutPendingExpiresAt: null,
        updatedAt: new Date(),
    }).where(eq(partners.id, partnerId));
}

/** The partner record belonging to a user, if any. Returns whether there was one. */
export async function erasePartnerDataForUser(db: Db, userId: number): Promise<{ erased: boolean; partnerId: number | null }> {
    const [p] = await db.select({ id: partners.id }).from(partners).where(eq(partners.userId, userId)).limit(1);
    if (!p) return { erased: false, partnerId: null };
    await erasePartnerRow(db, p.id);
    return { erased: true, partnerId: p.id };
}

/**
 * An application with no account and no money behind it (applied or rejected, never earned): delete
 * it outright. Used on request (admin) and by the nightly sweep for declined applications older than
 * 12 months.
 */
export async function deleteApplicantOnly(db: Db, partnerId: number): Promise<boolean> {
    const deleted = await db.delete(partners).where(and(
        eq(partners.id, partnerId), isNull(partners.userId), sql`${partners.status} IN ('applied', 'rejected')`,
        notExists(db.select({ x: sql`1` }).from(partnerCommissions).where(eq(partnerCommissions.partnerId, partners.id))),
    )).returning({ id: partners.id });
    return deleted.length > 0;
}

/** Nightly (partner-commission-sweep.ts): declined applications without an account, decided over 12 months ago. */
export async function purgeDeclinedApplications(db: Db, now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - 365 * 86_400_000);
    const deleted = await db.delete(partners).where(and(
        eq(partners.status, 'rejected'), isNull(partners.userId), lt(partners.decidedAt, cutoff),
        notExists(db.select({ x: sql`1` }).from(partnerCommissions).where(eq(partnerCommissions.partnerId, partners.id))),
    )).returning({ id: partners.id });
    return { deleted: deleted.length };
}
