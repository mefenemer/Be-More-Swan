// src/utils/user-deletion.ts
// Delete a user AND the workspace they leave behind with nobody in it.
//
// Why this exists: `organisations` has no FK back to its owner, so `DELETE FROM users` cascades the
// membership row away and leaves the org standing — empty, unreachable, still counted everywhere
// orgs are counted. purge-ghost-accounts did exactly that to every signup that never verified
// (prod org 42, 2026-09-17: a customer's abandoned first attempt, sitting beside the org she went
// on to pay from). The admin hard-delete had the same gap. account-delete-execute already closed it
// by hand; this is the one place the other two paths now go through.
//
// An org is only deleted when the user was its SOLE member. An org holding a live Stripe
// subscription is KEPT even then: deleting it would drop the plans row while Stripe goes on
// billing, and every later webhook would land on nothing. That case is reported, not guessed at.

import { and, eq, ne, inArray, isNotNull, notInArray, type SQL } from 'drizzle-orm';
import { users, organisations, userOrganisations, plans } from '../../db/schema';

// Plan statuses after which Stripe is no longer billing (see the status list on plans.status).
const ENDED_PLAN_STATUSES = ['cancelled', 'expired'];

export interface UserDeletionResult {
    /** false when the user was gone, or no longer matched `onlyIf`, by the time we got there. */
    userDeleted: boolean;
    deletedOrgIds: number[];
    /** Sole-member orgs left in place, and why. */
    keptOrgs: { orgId: number; reason: 'live_subscription' | 'delete_failed' }[];
}

/**
 * Pure decision for one org the user belonged to. Exported for the tests.
 */
export function decideOrgFate(org: { otherMembers: number; hasLiveSubscription: boolean }):
    'leave' | 'delete' | 'keep_billed' {
    if (org.otherMembers > 0) return 'leave';           // someone else still works here
    if (org.hasLiveSubscription) return 'keep_billed';  // never strand a paying subscription
    return 'delete';
}

/**
 * Delete `userId` and every org they were the only member of, in ONE transaction, so a crash
 * cannot strand either half.
 *
 * `onlyIf` is re-checked inside the DELETE itself — the purge passes its ghost predicate so a user
 * who verifies between the SELECT and the DELETE is not removed.
 */
export async function deleteUserAndSoleOrgs(
    db: any,
    userId: number,
    opts: { onlyIf?: SQL } = {},
): Promise<UserDeletionResult> {
    return db.transaction(async (tx: any) => {
        const result: UserDeletionResult = { userDeleted: false, deletedOrgIds: [], keptOrgs: [] };

        // Every org this user belongs to — the junction table, plus the deprecated users.organisation_id.
        const memberships: { orgId: number }[] = await tx
            .select({ orgId: userOrganisations.organisationId })
            .from(userOrganisations)
            .where(eq(userOrganisations.userId, userId));
        const [legacy]: { orgId: number | null }[] = await tx
            .select({ orgId: users.organisationId })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        const orgIds = [...new Set([
            ...memberships.map(m => m.orgId),
            ...(legacy?.orgId ? [legacy.orgId] : []),
        ])];

        const deleted = await tx
            .delete(users)
            .where(opts.onlyIf ? and(eq(users.id, userId), opts.onlyIf) : eq(users.id, userId))
            .returning({ id: users.id });
        if (deleted.length === 0) return result;
        result.userDeleted = true;

        // The user row (and its memberships, by cascade) is gone, so any member still found is someone else.
        for (const orgId of orgIds) {
            const junctionMembers = await tx
                .select({ id: userOrganisations.id })
                .from(userOrganisations)
                .where(eq(userOrganisations.organisationId, orgId))
                .limit(1);
            const legacyMembers = await tx
                .select({ id: users.id })
                .from(users)
                .where(and(eq(users.organisationId, orgId), ne(users.id, userId)))
                .limit(1);
            const livePlans = await tx
                .select({ id: plans.id })
                .from(plans)
                .where(and(
                    eq(plans.organisationId, orgId),
                    isNotNull(plans.stripeSubscriptionId),
                    notInArray(plans.status, ENDED_PLAN_STATUSES),
                ))
                .limit(1);

            const fate = decideOrgFate({
                otherMembers: junctionMembers.length + legacyMembers.length,
                hasLiveSubscription: livePlans.length > 0,
            });
            if (fate === 'leave') continue;
            if (fate === 'keep_billed') {
                result.keptOrgs.push({ orgId, reason: 'live_subscription' });
                continue;
            }

            // Savepoint: an org some un-cascaded table still points at must not roll back the user delete.
            try {
                await tx.transaction(async (sp: any) => {
                    await sp.delete(organisations).where(inArray(organisations.id, [orgId]));
                });
                result.deletedOrgIds.push(orgId);
            } catch (err) {
                console.error(`[user-deletion] Could not delete sole-member org ${orgId} of user ${userId}:`, err);
                result.keptOrgs.push({ orgId, reason: 'delete_failed' });
            }
        }

        return result;
    });
}
