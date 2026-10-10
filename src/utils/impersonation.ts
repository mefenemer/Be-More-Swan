// src/utils/impersonation.ts
// US-ADM-1.2.1: Admin impersonation — the ONE module that reads the aura_impersonation cookie.
//
// How impersonation works (and why it never did before 2026-10-10):
//
//   admin-impersonate.ts (action 'start') sets `aura_impersonation`, a 15-minute JWT naming the
//   TARGET user and the real admin. The admin's own `aura_session` is left untouched — it is what
//   keeps them signed in, and what lets them go straight back to the admin portal afterwards.
//
//   requireTenant (src/utils/tenant.ts) asks resolveImpersonation() on every request. When the
//   cookie is valid AND bound to the admin's current session AND that admin still holds the
//   `impersonate` permission, the request resolves to the target user's organisation instead of
//   the admin's — and it is READ-ONLY: requireTenant refuses every non-GET method (see
//   impersonationWriteBlock). That is the whole identity switch. Nothing else reads this cookie
//   to grant access.
//
//   Until 2026-10-10 nothing honoured the cookie at all: admin.html never sent `action: 'start'`
//   (every attempt 400'd), and even with it, tenant resolution read only aura_session, so the
//   admin landed in their own (empty) workspace. A second, older design that REPLACED
//   aura_session with a `scope: 'impersonate'` token survives only as a blocking check below.
//
// Endpoints that never go through requireTenant still act as the ADMIN, never the target, so they
// cannot touch the customer's data. Dangerous ones additionally call checkImpersonationBlock().

import jwt from 'jsonwebtoken';
import { inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { hasPermission, isAdminRole } from './rbac';

type Db = ReturnType<typeof getDb>;

export const IMPERSONATION_COOKIE = 'aura_impersonation';
export const IMPERSONATION_TTL_SECONDS = 15 * 60; // 15 minutes

export const IMPERSONATION_REASONS = ['support_investigation', 'billing_dispute', 'qa_testing', 'account_recovery'] as const;
export type ImpersonationReason = typeof IMPERSONATION_REASONS[number];

export interface ImpersonationPayload {
    scope: 'impersonate';
    userId: number;                  // the TARGET user (kept for older readers)
    realAdminId: number;             // the admin performing impersonation — must match aura_session
    realAdminEmail: string;
    impersonatingUserId: number;     // the TARGET user
    targetUserEmail: string;
    targetUserName: string;
    sessionId: string;
    reason: ImpersonationReason;
    activeOrganisationId?: number;   // target user's active org at start, so requests resolve a tenant
    iat?: number;
    exp?: number;
}

/** Methods an impersonating admin may use. Everything else is a write and is refused. */
export const IMPERSONATION_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

function readCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            const value = rest.join('=');
            if (!value) return null;
            try { return decodeURIComponent(value); } catch { return value; }
        }
    }
    return null;
}

/**
 * Parse and VERIFY the aura_impersonation cookie. Returns null when absent, expired, tampered,
 * or not an impersonation-scoped token. This alone grants nothing — see resolveImpersonation.
 */
export function getImpersonationSession(cookieHeader: string | undefined): ImpersonationPayload | null {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return null;
    const token = readCookie(cookieHeader, IMPERSONATION_COOKIE);
    if (!token) return null;
    try {
        const payload = jwt.verify(token, jwtSecret) as ImpersonationPayload;
        if (payload.scope !== 'impersonate') return null;
        if (typeof payload.realAdminId !== 'number' || typeof payload.impersonatingUserId !== 'number') return null;
        return payload;
    } catch {
        return null;
    }
}

/**
 * The impersonation a request should actually be served under, or null.
 *
 * A verified cookie is necessary but not sufficient. It is honoured only when:
 *   1. it was issued to the admin whose aura_session made this request (`sessionUserId`) — so a
 *      cookie left behind after a logout, or carried into someone else's session, is inert;
 *   2. that admin STILL holds the `impersonate` permission (re-read from the DB every request, so
 *      a demotion ends every live session on the next click, not 15 minutes later);
 *   3. the target still exists and is not itself an admin.
 */
export async function resolveImpersonation(
    db: Db,
    cookieHeader: string | undefined,
    sessionUserId: number,
): Promise<ImpersonationPayload | null> {
    const imp = getImpersonationSession(cookieHeader);
    if (!imp) return null;
    if (imp.realAdminId !== sessionUserId) return null;
    if (imp.impersonatingUserId === imp.realAdminId) return null;

    const rows = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(inArray(users.id, [imp.realAdminId, imp.impersonatingUserId]));
    const admin = rows.find((r) => r.id === imp.realAdminId);
    const target = rows.find((r) => r.id === imp.impersonatingUserId);
    if (!admin || !hasPermission(admin.role, 'impersonate')) return null;
    if (!target || isAdminRole(target.role)) return null;
    return imp;
}

/**
 * 403 for any write made while impersonating. requireTenant applies this to every request it
 * resolves under impersonation, which is what makes an impersonated workspace read-only: drafting,
 * approving, publishing, sending, connecting, deleting and paying all arrive as POST/PUT/PATCH/DELETE.
 */
export function impersonationWriteBlock(
    method: string | undefined,
    imp: ImpersonationPayload,
): { statusCode: number; body: string } | null {
    const m = (method || 'GET').toUpperCase();
    if ((IMPERSONATION_SAFE_METHODS as readonly string[]).includes(m)) return null;
    return {
        statusCode: 403,
        body: JSON.stringify({
            error: 'This workspace is read-only while an admin is viewing it. End impersonation to make changes.',
            impersonation: true,
            impersonationSessionId: imp.sessionId,
        }),
    };
}

/** True when the legacy design's replaced aura_session (scope 'impersonate') is present. */
function hasLegacyImpersonationSession(cookieHeader: string | undefined): boolean {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return false;
    const token = readCookie(cookieHeader, 'aura_session');
    if (!token) return false;
    try {
        return (jwt.verify(token, jwtSecret) as Record<string, unknown>).scope === 'impersonate';
    } catch {
        return false;
    }
}

/**
 * Returns a 403 response if the request carries ANY impersonation session, otherwise null.
 *
 * Deliberately broader than resolveImpersonation: it blocks on a verified cookie alone, without
 * the binding or permission checks. Over-blocking a dangerous action is the safe direction.
 *
 * Accepts the Cookie header or the whole event:
 *   const block = checkImpersonationBlock(event, 'billing_upgrade');
 *   if (block) return block;
 */
export function checkImpersonationBlock(
    source: string | undefined | { headers: Record<string, string | undefined> },
    blockedAction = 'this action',
): { statusCode: number; body: string } | null {
    const cookieHeader = typeof source === 'object' && source !== null
        ? (source.headers.cookie ?? source.headers.Cookie)
        : source;
    const session = getImpersonationSession(cookieHeader);
    if (!session && !hasLegacyImpersonationSession(cookieHeader)) return null;
    return {
        statusCode: 403,
        body: JSON.stringify({
            error: `Action "${blockedAction}" is not permitted during an admin impersonation session.`,
            impersonation: true,
            ...(session ? { impersonationSessionId: session.sessionId } : {}),
        }),
    };
}
