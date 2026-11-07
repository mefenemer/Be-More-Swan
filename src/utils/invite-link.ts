// src/utils/invite-link.ts
// Binds an invite link's token, workspace and role together with a server signature.
//
// users.verification_token is shared with the sign-up and magic-link emails, and the workspace and
// role travel in the URL. Without a signature, any emailed login token plus an edited URL could join
// any workspace as an admin, and an invited viewer could promote themselves. Only invite-member.ts
// signs, so a login token, or a link with a changed workspace or role, never verifies.
//
// Pure: no database. accept-invite.ts must still require the pending membership row.

import crypto from 'crypto';

export const INVITE_ROLES = ['member', 'admin', 'viewer'] as const;
export type InviteRole = typeof INVITE_ROLES[number];

export function isInviteRole(role: unknown): role is InviteRole {
    return INVITE_ROLES.includes(role as InviteRole);
}

/** The signature for one invite link. The prefix keeps it from matching any other use of the secret. */
export function signInvite(plainToken: string, orgId: number, role: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(`org-invite:${plainToken}:${orgId}:${role}`)
        .digest('hex');
}

/** True only for a signature this server made for exactly this token, workspace and role. */
export function verifyInviteSignature(
    plainToken: string,
    orgId: number,
    role: string,
    signature: string | null | undefined,
    secret: string,
): boolean {
    if (!signature || !isInviteRole(role)) return false;
    const expected = Buffer.from(signInvite(plainToken, orgId, role, secret));
    const given = Buffer.from(signature);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
