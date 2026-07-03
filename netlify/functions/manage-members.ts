/**
 * netlify/functions/manage-members.ts
 *
 * US-GAP-5.2.1: Seat Management and Member Removal
 *
 * GET  /manage-members          → list org members + seat usage (SC1, SC2)
 * PATCH /manage-members?id=N    { role: 'member'|'viewer'|'admin' }  → change role (SC3, SC6)
 * DELETE /manage-members?id=N   → remove member (SC4, SC5)
 *
 * Caller must be the org owner or an admin.
 */

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, count, ne } from 'drizzle-orm';
import { Resend } from 'resend';
import { getDb } from '../../db/client';
import {
    users,
    userOrganisations,
    organisations,
    plans,
    masterPlans,
    jwtBlocklist,
} from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { tombstoneOrgMemberAssets } from '../../src/utils/gdpr-asset-purge';

const jwtSecret  = process.env.JWT_SECRET;
const VALID_ROLES = ['admin', 'member', 'viewer'] as const;
type OrgRole = typeof VALID_ROLES[number];

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    const callerId = getAuth(event);
    if (!callerId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // Resolve caller's org membership and role
    const [callerUser] = await db.select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations).where(eq(userOrganisations.userId, callerId)).limit(1);
    if (!callerUser?.organisationId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'No organisation found.' }) };
    }
    const orgId = callerUser.organisationId;

    const [callerMembership] = await db.select({ role: userOrganisations.role })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, callerId), eq(userOrganisations.organisationId, orgId)))
        .limit(1);

    // Only owners and admins can manage members
    if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Insufficient permissions.' }) };
    }

    try {

        // ── GET: List members + seat usage ──────────────────────────────
        if (event.httpMethod === 'GET') {
            const members = await db
                .select({
                    membershipId: userOrganisations.id,
                    userId: userOrganisations.userId,
                    role: userOrganisations.role,
                    joinedAt: userOrganisations.joinedAt,
                    firstName: users.firstName,
                    lastName: users.lastName,
                    email: users.email,
                })
                .from(userOrganisations)
                .leftJoin(users, eq(userOrganisations.userId, users.id))
                .where(eq(userOrganisations.organisationId, orgId))
                .orderBy(userOrganisations.joinedAt);

            // Resolve seat limit from the org owner's active plan
            const [ownerPlanRow] = await db
                .select({ seatLimit: masterPlans.seatLimit })
                .from(plans)
                .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.userId, callerId), eq(plans.status, 'active')))
                .limit(1);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    members,
                    seatCount: members.length,
                    seatLimit: ownerPlanRow?.seatLimit ?? null,
                }),
            };
        }

        const qs = event.queryStringParameters || {};
        const targetUserId = parseInt(qs.id || '');
        if (!targetUserId) return { statusCode: 400, body: JSON.stringify({ error: 'Member id is required.' }) };

        // Verify the target is actually a member of this org
        const [targetMembership] = await db
            .select({ id: userOrganisations.id, role: userOrganisations.role })
            .from(userOrganisations)
            .where(and(eq(userOrganisations.userId, targetUserId), eq(userOrganisations.organisationId, orgId)))
            .limit(1);

        if (!targetMembership) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Member not found in this organisation.' }) };
        }

        // ── PATCH: Change member role ───────────────────────────────────
        if (event.httpMethod === 'PATCH') {
            const body = JSON.parse(event.body || '{}');
            const newRole = body.role as OrgRole;

            if (!VALID_ROLES.includes(newRole)) {
                return { statusCode: 400, body: JSON.stringify({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` }) };
            }

            // SC5: Cannot change the owner's own role
            if (targetUserId === callerId && targetMembership.role === 'owner') {
                return { statusCode: 400, body: JSON.stringify({ error: 'Cannot change your own owner role.' }) };
            }

            // SC6: Last Admin Guard — cannot demote the last admin without another admin in place
            if (targetMembership.role === 'admin' && newRole !== 'admin') {
                const [{ value: adminCount }] = await db
                    .select({ value: count() })
                    .from(userOrganisations)
                    .where(and(
                        eq(userOrganisations.organisationId, orgId),
                        eq(userOrganisations.role, 'admin'),
                    ));
                if (adminCount <= 1) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({
                            error: 'Cannot demote the only admin. Assign another admin first.',
                            code: 'LAST_ADMIN',
                        }),
                    };
                }
            }

            await db.update(userOrganisations)
                .set({ role: newRole })
                .where(eq(userOrganisations.id, targetMembership.id));

            return { statusCode: 200, body: JSON.stringify({ success: true, role: newRole }) };
        }

        // ── DELETE: Remove member ───────────────────────────────────────
        if (event.httpMethod === 'DELETE') {
            // SC5: Sole owner cannot remove themselves
            if (targetUserId === callerId) {
                const [{ value: ownerCount }] = await db
                    .select({ value: count() })
                    .from(userOrganisations)
                    .where(and(
                        eq(userOrganisations.organisationId, orgId),
                        eq(userOrganisations.role, 'owner'),
                    ));
                if (ownerCount <= 1) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({
                            error: 'You cannot remove yourself as the only owner. Transfer ownership first.',
                            code: 'SOLE_OWNER',
                        }),
                    };
                }
            }

            // Fetch the member's email before deleting (for notification)
            const [targetUser] = await db
                .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
                .from(users).where(eq(users.id, targetUserId)).limit(1);

            const [org] = await db
                .select({ name: organisations.name })
                .from(organisations).where(eq(organisations.id, orgId)).limit(1);

            // SC4a: Remove the membership row
            await db.delete(userOrganisations)
                .where(and(
                    eq(userOrganisations.userId, targetUserId),
                    eq(userOrganisations.organisationId, orgId),
                ));

            // SC4b: Invalidate session immediately — update tokenExpiresAt and blocklist all
            // existing JWTs so the removed member cannot continue using a valid 7-day token.
            await db.update(users)
                .set({ tokenExpiresAt: new Date(0) })
                .where(eq(users.id, targetUserId));

            await db.insert(jwtBlocklist).values({
                userId: targetUserId,
                blockType: 'userId',
                reason: 'member_removed',
                expiresAt: null,
            });

            // US-GDPR-2.2.1: Tombstone departing member's assets so remaining members
            // can't access their files, but org-level rows remain intact (isActive=false).
            const tombstonedCount = await tombstoneOrgMemberAssets(db, targetUserId, orgId).catch(() => 0);
            if (tombstonedCount > 0) {
                // Notify org owner(s) that files need review
                const owners = await db
                    .select({ email: users.email, firstName: users.firstName })
                    .from(userOrganisations)
                    .innerJoin(users, eq(userOrganisations.userId, users.id))
                    .where(and(
                        eq(userOrganisations.organisationId, orgId),
                        eq(userOrganisations.role, 'owner'),
                        ne(userOrganisations.userId, targetUserId),
                    ));
                for (const owner of owners) {
                    const memberName = [targetUser?.firstName, targetUser?.lastName].filter(Boolean).join(' ') || 'A member';
                    await sendMagicLinkEmail({
                        to: owner.email,
                        subject: `${tombstonedCount} file(s) from a removed member need review — ${org?.name || 'your workspace'}`,
                        html: `<div style="font-family:sans-serif;padding:24px;max-width:500px">
                            <h2>Workspace Files Need Attention</h2>
                            <p>Hi ${owner.firstName || 'there'},</p>
                            <p><strong>${memberName}</strong> has been removed from <strong>${org?.name || 'your workspace'}</strong>. They had <strong>${tombstonedCount} file(s)</strong> uploaded that are now inactive.</p>
                            <p>You have <strong>30 days</strong> to reassign ownership of these files to keep them active. After 30 days, their content will be automatically purged to comply with data privacy requirements.</p>
                            <p>Visit your workspace <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/workspace.html">Connections &amp; Assets</a> section to review and reassign files.</p>
                            <p style="color:#999;font-size:12px;margin-top:24px">Be More Swan Data Privacy</p>
                        </div>`,
                    }).catch(err => console.warn('[manage-members] Owner asset-notice email failed:', err));
                }
            }

            // SC4c: Send email notification to removed member
            if (targetUser?.email) {
                await sendMagicLinkEmail({
                    to: targetUser.email,
                    subject: `You've been removed from ${org?.name || 'an organisation'} on Be More Swan`,
                    html: `
                        <div style="font-family:sans-serif;padding:24px;max-width:500px">
                            <h2>Workspace Access Removed</h2>
                            <p>Hi ${[targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') || 'there'},</p>
                            <p>You have been removed from <strong>${org?.name || 'a workspace'}</strong> on Be More Swan.</p>
                            <p>If you believe this was a mistake, please contact the workspace owner directly.</p>
                            <p style="color:#999;font-size:12px;margin-top:24px">Be More Swan</p>
                        </div>
                    `,
                }).catch(err => console.warn('[manage-members] Email send failed (non-blocking):', err));
            }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err: any) {
        console.error('[manage-members]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
    }
};
