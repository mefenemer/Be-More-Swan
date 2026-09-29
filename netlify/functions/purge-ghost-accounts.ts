// purge-ghost-accounts.ts  (US5)
// Scheduled Netlify function — runs every hour via cron.
// Permanently deletes user accounts that are STILL in 'pending_verification' AND whose most recent
// verification link expired more than GHOST_GRACE_MS ago — together with the workspace register.ts
// created for them, when they were its only member.
//
// The grace period: the link itself lasts 15 minutes, but the ACCOUNT waits 24 hours after that.
// This used to purge the moment the link expired, so anyone who opened the email an hour later found
// their account gone and had to register again. Resend-verification pushes token_expires_at forward,
// so a user who keeps asking for links is never purged.
//
// The workspace: organisations has no FK to its owner, so deleting the user alone left the org
// standing, empty and unreachable (prod org 42). deleteUserAndSoleOrgs removes both in one transaction.
//
// Scenario 3 safety: active users, and pending users inside the grace period, are NEVER touched —
// and the predicate is re-checked inside the DELETE, so a user who verifies mid-run is spared.

import type { Config } from '@netlify/functions';
import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { deleteUserAndSoleOrgs } from '../../src/utils/user-deletion';

export const GHOST_GRACE_MS = 24 * 60 * 60 * 1000;

export default async function handler(): Promise<void> {
    const db = getDb();
    const cutoff = new Date(Date.now() - GHOST_GRACE_MS);

    const isGhost = and(
        eq(users.status, 'pending_verification'),
        isNotNull(users.tokenExpiresAt),
        lt(users.tokenExpiresAt, cutoff),
    );

    try {
        const ghosts = await db
            .select({ id: users.id })
            .from(users)
            .where(isGhost);

        if (ghosts.length === 0) {
            console.log('[purge-ghost-accounts] Nothing to purge.');
            return;
        }

        let purged = 0;
        let orgsPurged = 0;
        for (const ghost of ghosts) {
            try {
                const res = await deleteUserAndSoleOrgs(db, ghost.id, { onlyIf: isGhost });
                if (res.userDeleted) purged++;
                orgsPurged += res.deletedOrgIds.length;
                if (res.keptOrgs.length) {
                    console.warn(`[purge-ghost-accounts] User ${ghost.id}: kept org(s)`, res.keptOrgs);
                }
            } catch (err) {
                console.error(`[purge-ghost-accounts] Failed to delete user ${ghost.id}:`, err);
            }
        }

        console.log(`[purge-ghost-accounts] Purged ${purged}/${ghosts.length} ghost accounts and ${orgsPurged} empty workspace(s).`);
    } catch (err) {
        console.error('[purge-ghost-accounts] Fatal error:', err);
    }
}

// Run every hour
export const config: Config = {
    schedule: '0 * * * *',
};
