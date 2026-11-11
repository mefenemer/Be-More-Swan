// src/utils/invite-link.ts
// Binds an invite link's pending membership row, workspace, role and expiry with a server signature.
//
// The workspace and role travel in the URL, so without a signature an edited link could join any
// workspace as an admin, and an invited viewer could promote themselves. Only invite-member.ts signs.
//
// A link names its 'invited' row, not a token. users.verification_token is shared with the sign-up
// and login emails, so each used to overwrite the other. The row does the job a token did: a resend
// replaces it (old links stop working), and accepting changes its role (a link works once).
//
// Pure: no database. accept-invite.ts must still require the pending membership row.

import crypto from 'crypto';

export const INVITE_ROLES = ['member', 'admin', 'viewer'] as const;
export type InviteRole = typeof INVITE_ROLES[number];

export function isInviteRole(role: unknown): role is InviteRole {
    return INVITE_ROLES.includes(role as InviteRole);
}

/** The signature for one invite link. The prefix keeps it from matching any other use of the secret. */
export function signInviteLink(inviteId: number, orgId: number, role: string, expiresAtMs: number, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(`org-invite-link:${inviteId}:${orgId}:${role}:${expiresAtMs}`)
        .digest('hex');
}

function sameSignature(expected: string, signature: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True only for a signature this server made for exactly this row, workspace, role and expiry. */
export function verifyInviteLink(
    inviteId: number,
    orgId: number,
    role: string,
    expiresAtMs: number,
    signature: string | null | undefined,
    secret: string,
): boolean {
    if (!signature || !isInviteRole(role)) return false;
    return sameSignature(signInviteLink(inviteId, orgId, role, expiresAtMs, secret), signature);
}

// ── Links emailed before 2026-11-07 name a token instead. They last 7 days, so this and the token
// branch in accept-invite.ts can go once none are left: any time after 2026-11-30. ──

/** The signature for a token-based invite link. The prefix keeps it from matching any other use of the secret. */
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
    return sameSignature(signInvite(plainToken, orgId, role, secret), signature);
}
