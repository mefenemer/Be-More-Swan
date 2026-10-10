// src/utils/tenant.ts
// US-DB-1.3.1: Mandatory tenant-scoping guard.
//
// Single source of truth for "which organisation is this request acting in, and
// is the user allowed to". Replaces inline userOrganisations lookups (e.g.
// integration-audit.ts, billing-upgrade.ts) and removes all remaining reads of
// the DEPRECATED users.organisationId column.
//
// SECURITY: the activeOrganisationId JWT claim only *selects* the tenant. This
// module always re-verifies current membership against userOrganisations, so a
// stale/forged claim can never grant access to an org the user has left.

import type { HandlerEvent } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { userOrganisations } from '../../db/schema';
import { requireSession, type JsonResponse } from './session';
import { resolveImpersonation, impersonationWriteBlock } from './impersonation';

type Db = ReturnType<typeof getDb>;

export interface OrgMembership {
    organisationId: number;
    role: string;
}

export interface TenantContext {
    userId: number;
    organisationId: number;
    /** The caller's role *within* organisationId, e.g. 'owner' | 'admin' | 'member' | 'viewer'. */
    role: string;
    /**
     * Present only when an admin is viewing this workspace through impersonation. `userId` is
     * then the TARGET user; the real admin is here. Such a request is always a GET — see below.
     */
    impersonation?: { realAdminId: number; sessionId: string };
}

/**
 * Resolve the organisation a request should act in.
 *
 * 1. If `claimedOrgId` is supplied (from the session claim) and the user is a
 *    current member, that org is used.
 * 2. Otherwise we fall back to the user's most-recently-joined membership.
 *
 * Returns null when the user belongs to no organisation. Membership is always
 * read from userOrganisations — never from the JWT or users.organisationId.
 */
export async function resolveActiveOrg(
    db: Db,
    userId: number,
    claimedOrgId?: number,
): Promise<OrgMembership | null> {
    if (claimedOrgId !== undefined) {
        const membership = await requireOrgMembership(db, userId, claimedOrgId);
        if (membership) return { organisationId: claimedOrgId, role: membership.role };
        // Claim points at an org the user is no longer in — ignore it and fall back.
    }

    const [fallback] = await db
        .select({ organisationId: userOrganisations.organisationId, role: userOrganisations.role })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, userId))
        .orderBy(desc(userOrganisations.joinedAt))
        .limit(1);

    return fallback ?? null;
}

/**
 * Verify `userId` is a current member of `orgId`. When `roles` is given, the
 * membership role must be one of them. Returns the membership (with role) or null.
 */
export async function requireOrgMembership(
    db: Db,
    userId: number,
    orgId: number,
    roles?: string[],
): Promise<{ role: string } | null> {
    const [membership] = await db
        .select({ role: userOrganisations.role })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, orgId)))
        .limit(1);

    if (!membership) return null;
    if (roles && !roles.includes(membership.role)) return null;
    return membership;
}

/** All user ids belonging to an organisation. */
export async function getOrgMembers(db: Db, orgId: number): Promise<number[]> {
    const rows = await db
        .select({ userId: userOrganisations.userId })
        .from(userOrganisations)
        .where(eq(userOrganisations.organisationId, orgId));
    return rows.map((r) => r.userId);
}

/**
 * Standard entry point for a tenant-scoped function: authenticate, resolve the
 * active org, and (optionally) enforce a role. Returns a discriminated result:
 *
 *   const ctx = await requireTenant(event, db);
 *   if ('error' in ctx) return ctx.error;
 *   // ctx.userId, ctx.organisationId, ctx.role available here
 *
 * Pass `{ roles: ['owner', 'admin'] }` to gate admin-only actions.
 */
export async function requireTenant(
    event: HandlerEvent,
    db: Db,
    opts?: {
        roles?: string[];
        /**
         * The request changes state even though it is a GET — an OAuth connect start, say. Such a
         * request is refused under impersonation exactly like a POST would be.
         */
        mutates?: boolean;
    },
): Promise<TenantContext | { error: JsonResponse }> {
    const session = requireSession(event);
    if ('error' in session) return session;

    // US-ADM-1.2.1: an admin impersonating a customer resolves the CUSTOMER's org, read-only.
    // resolveImpersonation honours the cookie only when it is bound to this admin's session and
    // the admin still holds the `impersonate` permission (src/utils/impersonation.ts).
    const imp = await resolveImpersonation(db, event.headers?.cookie ?? event.headers?.Cookie, session.userId);
    if (imp) {
        const blocked = impersonationWriteBlock(opts?.mutates ? 'POST' : event.httpMethod, imp);
        if (blocked) return { error: blocked };
        const targetOrg = await resolveActiveOrg(db, imp.impersonatingUserId, imp.activeOrganisationId);
        if (!targetOrg) {
            return {
                error: { statusCode: 403, body: JSON.stringify({ error: 'The impersonated user has no organisation.' }) },
            };
        }
        if (opts?.roles && !opts.roles.includes(targetOrg.role)) {
            return { error: { statusCode: 403, body: JSON.stringify({ error: 'Insufficient permissions for this organisation.' }) } };
        }
        return {
            userId: imp.impersonatingUserId,
            organisationId: targetOrg.organisationId,
            role: targetOrg.role,
            impersonation: { realAdminId: imp.realAdminId, sessionId: imp.sessionId },
        };
    }

    const org = await resolveActiveOrg(db, session.userId, session.activeOrganisationId);
    if (!org) {
        return {
            error: { statusCode: 403, body: JSON.stringify({ error: 'No organisation associated with this account.' }) },
        };
    }

    if (opts?.roles && !opts.roles.includes(org.role)) {
        return { error: { statusCode: 403, body: JSON.stringify({ error: 'Insufficient permissions for this organisation.' }) } };
    }

    return { userId: session.userId, organisationId: org.organisationId, role: org.role };
}
