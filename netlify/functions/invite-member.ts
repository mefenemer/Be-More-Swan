// netlify/functions/invite-member.ts
// US-GAP-5.1.1: Org Owner Invites Team Member
//
// POST { email, role? }   → SC2/SC3/SC4: send invite or direct-add existing user
// POST { resend: true, email } → SC6: invalidate old invite, generate new 7-day link
//
// SC2: If the invitee is already a registered Be More Swan user → add directly to org + in-app notification
//       If not registered → send magic-link invite email (creates account + joins org in one click)
// SC3: Check seat limit from org owner's masterPlan.seatLimit (null=1 seat, 0=unlimited)
// SC4: Invite email contains inviter name, org name, role, 7-day expiry link
// SC6: Resend invalidates previous token (overwrites verificationToken + tokenExpiresAt)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { eq, and, count } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users,
    userOrganisations,
    plans,
    masterPlans,
    organisations,
    notifications,
} from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const jwtSecret  = process.env.JWT_SECRET;
const BASE_URL   = process.env.BASE_URL || 'https://bemoreswan.com';

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const callerId = getAuth(event);
    if (!callerId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // Resolve caller's org
    const [callerUser] = await db
        .select({ organisationId: userOrganisations.organisationId, email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, callerId)).limit(1);

    if (!callerUser?.organisationId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'You must be part of an organisation to invite members.' }) };
    }
    const orgId = callerUser.organisationId;

    // Check caller is owner or admin
    const [callerMembership] = await db
        .select({ role: userOrganisations.role })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, callerId), eq(userOrganisations.organisationId, orgId)))
        .limit(1);

    if (!['owner', 'admin'].includes(callerMembership?.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Only workspace owners and admins can invite members.' }) };
    }

    let body: { email?: string; role?: string; resend?: boolean };
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { email, role = 'member', resend = false } = body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid email address is required.' }) };
    }
    if (!['member', 'admin', 'viewer'].includes(role)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Role must be "member", "admin", or "viewer".' }) };
    }
    if (email.toLowerCase() === callerUser.email?.toLowerCase()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'You cannot invite yourself.' }) };
    }

    // SC3: Seat limit — find org owner's master plan
    const [orgOwner] = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userOrganisations, and(
            eq(userOrganisations.userId, users.id),
            eq(userOrganisations.organisationId, orgId),
            eq(userOrganisations.role, 'owner'),
        ))
        .limit(1);

    let seatLimit: number | null = 1;
    if (orgOwner) {
        const [ownerPlan] = await db
            .select({ seatLimit: masterPlans.seatLimit })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.userId, orgOwner.id), eq(plans.status, 'active')))
            .limit(1);
        seatLimit = ownerPlan?.seatLimit ?? 1;
    }

    const [{ value: currentSeats }] = await db
        .select({ value: count() })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.organisationId, orgId), eq(userOrganisations.role, 'invited')
            // count all non-invited too — effective seats = active members
        ));

    // Re-count all active (non-invited) seats for limit check
    const [{ value: activeSeats }] = await db
        .select({ value: count() })
        .from(userOrganisations)
        .where(eq(userOrganisations.organisationId, orgId));

    const effectiveLimit = seatLimit === null ? 1 : seatLimit;
    if (effectiveLimit !== 0 && activeSeats >= effectiveLimit) {
        return {
            statusCode: 403,
            body: JSON.stringify({
                error: 'You have reached your team member limit for your plan. Upgrade to add more seats.',
                code: 'SEAT_LIMIT_REACHED',
                currentSeats: activeSeats,
                seatLimit: effectiveLimit,
            }),
        };
    }

    // Check if they're already an active member
    const [existingMembership] = await db
        .select({ role: userOrganisations.role, userId: userOrganisations.userId })
        .from(userOrganisations)
        .innerJoin(users, eq(userOrganisations.userId, users.id))
        .where(and(
            eq(userOrganisations.organisationId, orgId),
            eq(users.email, email.toLowerCase()),
        ))
        .limit(1);

    if (existingMembership && existingMembership.role !== 'invited') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This person is already a member of your workspace.' }) };
    }

    // Fetch org name + inviter name for emails
    const [org] = await db
        .select({ name: organisations.name })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const orgName    = org?.name || 'your workspace';
    const inviterName = [callerUser.firstName, callerUser.lastName].filter(Boolean).join(' ') || callerUser.email?.split('@')[0] || 'A team member';

    // SC2: Check if the invitee is already a registered Be More Swan user
    const [existingUser] = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

    if (existingUser && existingMembership?.role !== 'invited') {
        // Already registered, not in org yet — add directly (SC2a)
        await db.insert(userOrganisations).values({
            userId:         existingUser.id,
            organisationId: orgId,
            role:           role as any,
        }).onConflictDoNothing();

        // SC2a: In-app notification
        await db.insert(notifications).values({
            userId:  existingUser.id,
            type:    'org_invite_accepted',
            title:   `You've been added to ${orgName}`,
            message: `${inviterName} has added you to ${orgName} as a ${role}.`,
            metadata: { orgId, orgName, role },
        }).catch(() => {});

        // Also send a courtesy email
        sendEmail({
            to: existingUser.email,
            subject: `You've been added to ${orgName} on Be More Swan`,
            html: `<p>Hi ${existingUser.firstName || 'there'},</p>
                   <p><strong>${inviterName}</strong> has added you to <strong>${orgName}</strong> on Be More Swan as a ${role}.</p>
                   <p style="margin-top:20px;">
                     <a href="${BASE_URL}/workspace.html" style="background:#10b981;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                       Open Workspace →
                     </a>
                   </p>
                   <p>The Be More Swan Team</p>`,
        }).catch(() => {});

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: `${email} has been added to your workspace.`, directAdd: true }),
        };
    }

    // SC4 / SC6: Generate 7-day invite token (resend overwrites existing token)
    const plainToken  = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    let invitedUserId: number;

    if (existingUser) {
        // SC6: Resend — overwrite token
        await db.update(users)
            .set({ verificationToken: hashedToken, tokenExpiresAt: expiresAt })
            .where(eq(users.id, existingUser.id));
        invitedUserId = existingUser.id;

        // Ensure org membership row exists as 'invited'
        if (existingMembership) {
            await db.update(userOrganisations)
                .set({ role: 'invited' } as any)
                .where(and(
                    eq(userOrganisations.userId, existingUser.id),
                    eq(userOrganisations.organisationId, orgId),
                ));
        } else {
            await db.insert(userOrganisations).values({
                userId: existingUser.id, organisationId: orgId, role: 'invited' as any,
            }).onConflictDoNothing();
        }
    } else {
        // New user — create stub account
        const [newUser] = await db.insert(users).values({
            email:             email.toLowerCase(),
            status:            'pending_verification',
            verificationToken: hashedToken,
            tokenExpiresAt:    expiresAt,
        }).returning({ id: users.id });
        invitedUserId = newUser.id;

        // Pending org membership
        await db.insert(userOrganisations).values({
            userId: invitedUserId, organisationId: orgId, role: 'invited' as any,
        }).onConflictDoNothing();
    }

    // Store intended role in metadata so accept-invite.ts can apply it
    // We store it as JSON in the user's existing metadata field or via a custom column.
    // Since there's no dedicated invitations table, we store role info in tokenExpiresAt + encode
    // in the URL so accept-invite can apply it. The role is appended as a second param.
    const acceptUrl = `${BASE_URL}/accept-invite.html?token=${plainToken}&orgId=${orgId}&role=${encodeURIComponent(role)}`;

    // SC4: Send invite email with all required content
    sendEmail({
        to: email,
        subject: `${inviterName} invited you to join ${orgName} on Be More Swan`,
        html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
  <div style="background:#111827;padding:20px 28px">
    <span style="color:#10b981;font-size:20px;font-weight:800">Be More Swan</span>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 8px;color:#111827;font-size:22px">You're invited! 🎉</h2>
    <p style="color:#374151;margin:0 0 6px;line-height:1.6">
      <strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on Be More Swan.
    </p>
    <p style="color:#6b7280;margin:0 0 24px;font-size:14px">You'll be joining as a <strong>${role}</strong>.</p>
    <a href="${acceptUrl}" style="display:inline-block;padding:14px 28px;background:#10b981;color:#fff;font-weight:700;text-decoration:none;border-radius:8px;font-size:15px">
      Join ${orgName} on Be More Swan →
    </a>
    <p style="color:#9ca3af;font-size:12px;margin-top:20px">This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.</p>
  </div>
</div>`,
    }).catch(err => console.warn('[invite-member] Email send failed (non-fatal):', err.message));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success: true,
            message: resend ? `Invitation resent to ${email}.` : `Invitation sent to ${email}.`,
            directAdd: false,
        }),
    };
};
