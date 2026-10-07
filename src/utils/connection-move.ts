// src/utils/connection-move.ts
// Move a social account from one Be More Swan workspace to another, when the person asking owns
// (or administers) both. The way out of a tenant collision for that case: see connection-collision.ts.
//
// ── Who may move ────────────────────────────────────────────────────────────────────────────────
// Everything comes from the recorded collision attempt, never from the browser: the attempt names
// the requesting workspace, the holding workspace, the service and the account. The caller must be
// in the REQUESTING workspace (it is the active one) AND an owner/admin of the HOLDING one. Anyone
// else keeps the request-to-join flow, and the caller never learns the holding workspace's name
// unless they are entitled to move out of it.
//
// ── What a move does to the holding workspace ───────────────────────────────────────────────────
// The same as pressing Disconnect there (integrations.ts DELETE), with ONE deliberate difference:
//   · its row(s) for this account → status 'disconnected', is_active false
//   · its scheduled posts to those rows → cancelled ('connection_moved'), because they can no longer publish
//   · the row's owner is notified, and the move is audit-logged
//   · ⚠️ the token is NOT revoked at the provider. Disconnect calls Meta's DELETE /me/permissions,
//     which revokes the app for the whole Facebook LOGIN. A move happens precisely because the same
//     login is about to connect again, so revoking would break the connection being made, and every
//     other Page that login has connected in any workspace.
// The vault secret is deleted only when no other live row still reads it.

import { and, eq, inArray, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
    connectionCollisionAttempts, systemConnections, userOrganisations, organisations, scheduledPosts, auditLogs,
} from '../../db/schema';
import { deleteSecret } from './vault';
import { createNotification } from './notify';

type Db = PostgresJsDatabase<any>;

export const MOVE_ROLES: readonly string[] = ['owner', 'admin'];
const LABELS: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X (Twitter)' };

export type MoveEligibility =
    | { canMove: true; attemptId: number; platform: string; fromWorkspace: string; scheduledPosts: number; connectionIds: number[] }
    | { canMove: false; reason: 'not_found' | 'not_yours' | 'not_admin_there' | 'already_free' };

interface Attempt { id: number; requestingOrgId: number; existingOrgId: number; serviceName: string; externalUserId: string; status: string }

/** Pure: the membership rule. */
export function judgeMove(attempt: Attempt | null, callerOrgId: number, roleInHoldingOrg: string | null): MoveEligibility | null {
    if (!attempt) return { canMove: false, reason: 'not_found' };
    if (attempt.requestingOrgId !== callerOrgId) return { canMove: false, reason: 'not_yours' };
    if (!roleInHoldingOrg || !MOVE_ROLES.includes(roleInHoldingOrg)) return { canMove: false, reason: 'not_admin_there' };
    return null; // eligible so far: the caller still has to find live rows to move
}

export async function checkMove(db: Db, attemptId: number, caller: { userId: number; organisationId: number }): Promise<MoveEligibility> {
    const [attempt] = await db.select().from(connectionCollisionAttempts)
        .where(eq(connectionCollisionAttempts.id, attemptId)).limit(1);
    const [membership] = attempt
        ? await db.select({ role: userOrganisations.role }).from(userOrganisations)
            .where(and(eq(userOrganisations.userId, caller.userId), eq(userOrganisations.organisationId, attempt.existingOrgId))).limit(1)
        : [];
    const verdict = judgeMove(attempt ?? null, caller.organisationId, membership?.role ?? null);
    if (verdict) return verdict;

    const rows = await db.select({ id: systemConnections.id }).from(systemConnections).where(and(
        eq(systemConnections.organisationId, attempt.existingOrgId),
        eq(systemConnections.serviceName, attempt.serviceName),
        eq(systemConnections.externalUserId, attempt.externalUserId),
        eq(systemConnections.isActive, true),
    ));
    if (!rows.length) return { canMove: false, reason: 'already_free' };

    const ids = rows.map(r => r.id);
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, attempt.existingOrgId)).limit(1);
    const posts = await db.select({ id: scheduledPosts.id }).from(scheduledPosts)
        .where(and(inArray(scheduledPosts.connectionId, ids), eq(scheduledPosts.status, 'scheduled')));
    return {
        canMove: true, attemptId: attempt.id, platform: attempt.serviceName,
        fromWorkspace: org?.name ?? 'your other workspace', scheduledPosts: posts.length, connectionIds: ids,
    };
}

/** Disconnect the account from the holding workspace. Re-checks eligibility; returns what it did. */
export async function moveConnectionOut(db: Db, attemptId: number, caller: { userId: number; organisationId: number }) {
    const check = await checkMove(db, attemptId, caller);
    if (!check.canMove) return check;

    const rows = await db.select({
        id: systemConnections.id, userId: systemConnections.userId, organisationId: systemConnections.organisationId,
        vaultRefKey: systemConnections.vaultRefKey, assistantId: systemConnections.assistantId,
    }).from(systemConnections).where(inArray(systemConnections.id, check.connectionIds));

    await db.update(systemConnections).set({ status: 'disconnected', isActive: false, updatedAt: new Date() })
        .where(inArray(systemConnections.id, check.connectionIds));

    const cancelled = await db.update(scheduledPosts)
        .set({ status: 'cancelled', cancelledAt: new Date(), rejectionReason: 'connection_moved', updatedAt: new Date() })
        .where(and(inArray(scheduledPosts.connectionId, check.connectionIds), eq(scheduledPosts.status, 'scheduled')));
    const cancelledCount = Number((cancelled as any).count ?? 0);

    for (const key of new Set(rows.map(r => r.vaultRefKey).filter((k): k is string => !!k))) {
        const [stillUsed] = await db.select({ id: systemConnections.id }).from(systemConnections).where(and(
            eq(systemConnections.vaultRefKey, key), eq(systemConnections.isActive, true),
            ne(systemConnections.organisationId, caller.organisationId),
        )).limit(1);
        if (!stillUsed) await deleteSecret(db, key).catch(() => {});
    }

    const label = LABELS[check.platform] ?? check.platform;
    for (const row of rows) {
        if (row.userId) {
            await createNotification(db, cancelledCount > 0 ? 'social_disconnected_posts_cancelled' : 'social_disconnected', {
                userId: row.userId,
                context: { platform: { label }, cancelled: { post_count: `${cancelledCount} scheduled post${cancelledCount !== 1 ? 's have' : ' has'}` } },
                metadata: { connectionId: row.id, platform: check.platform, cancelledCount, assistantId: row.assistantId ?? null, movedToOrgId: caller.organisationId },
            });
        }
        await db.insert(auditLogs).values({
            actionType: 'social_connection_moved',
            resourceType: 'system_connections',
            resourceId: String(row.id),
            newState: { userId: caller.userId, fromOrgId: row.organisationId, toOrgId: caller.organisationId, platform: check.platform, attemptId, cancelledCount, movedAt: new Date().toISOString() },
        });
    }

    await db.update(connectionCollisionAttempts).set({ status: 'moved', updatedAt: new Date() })
        .where(eq(connectionCollisionAttempts.id, attemptId));

    return { canMove: true as const, moved: check.connectionIds.length, cancelledCount, platform: check.platform, fromWorkspace: check.fromWorkspace };
}
