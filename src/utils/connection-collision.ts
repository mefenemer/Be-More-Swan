// src/utils/connection-collision.ts
// Security & Fair Usage — Multi-Account Abuse Prevention (US1: OAuth Tenant Collision Blocking).
//
// A given third-party tenant (the provider's unique org/account id — Instagram user id, Facebook
// Page id, X user id, LinkedIn id, etc., stored as system_connections.external_user_id) may only be
// actively connected to ONE Be More Swan workspace. This helper detects when a DIFFERENT workspace
// already holds an active connection to the same (service_name, external_user_id), so OAuth callbacks
// can reject the attempt before persisting a token. The DB also enforces this with a partial unique
// index (db/connection-tenant-uniqueness.sql) as the race-proof backstop.
//
// ── What counts as "the same account" ─────────────────────────────────────────────────────────
// The BUSINESS account, never the login used to reach it. Facebook is keyed on the Page id and
// Instagram on the IG business account id (src/utils/meta-accounts.ts), so one person who owns two
// businesses signs in with the same Facebook login in both workspaces, picks a different Page in
// each, and never collides. That is the intended case: Love Cat Studio and Be More Swan share an
// owner and must both connect.
//
// ⚠️ LinkedIn is EXEMPT. We post as a personal MEMBER profile (w_member_social), so its id is the
// person, not a business, and an owner posting for two businesses from their own profile is
// legitimate. Blocking it would lock that owner out of one of their own workspaces.
//
// ── When it does collide: move, don't lock out ────────────────────────────────────────────────
// Parked 2026-09-01 because a real owner was locked out of their own Page (a stray row left in
// their OTHER workspace by the pre-picker reconnect bug). Re-armed with a way out: a caller who is
// an owner/admin of the workspace holding the account can move it (src/utils/connection-move.ts,
// netlify/functions/move-connection.ts). Anyone else gets the request-to-join flow.
//
// Still behind ENFORCE_TENANT_COLLISION. To arm it: apply db/system-connections-tenant-unique-v2.sql
// (the race backstop, which excludes LinkedIn) AFTER deploying this code, then set the env var.

import { and, eq, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { systemConnections, connectionCollisionAttempts } from '../../db/schema';

export type TenantCollision = { connectionId: number; organisationId: number };

/**
 * service_name is canonically lowercase in both system_connections and
 * connection_collision_attempts. Normalise here so a caller passing "Instagram" can never silently
 * miss a live 'instagram' row — a missed collision would let the same provider tenant be connected
 * to two workspaces, which is exactly what this module exists to prevent.
 */
const canonicalService = (serviceName: string): string => serviceName.toLowerCase();

/** Services whose external id is a PERSON rather than a business account. Never collide. */
export const COLLISION_EXEMPT_SERVICES: ReadonlySet<string> = new Set(['linkedin']);

/**
 * Kill switch for the whole US1 block. Unset/false — the current default — means every OAuth
 * callback treats the tenant as free, exactly as it did before US1 shipped. Set
 * ENFORCE_TENANT_COLLISION to 1/true/yes to re-arm it.
 */
export const tenantCollisionEnforced = (): boolean =>
    ['1', 'true', 'yes'].includes(String(process.env.ENFORCE_TENANT_COLLISION ?? '').trim().toLowerCase());

/**
 * Returns the colliding connection (active, owned by a different org) for this provider tenant,
 * or null when the tenant is free to connect. A null/empty externalUserId never collides.
 *
 * While ENFORCE_TENANT_COLLISION is unset this ALWAYS returns null — callers keep their existing
 * `if (collision)` branches, which simply never fire, so re-arming is a config change not a deploy.
 */
export async function findTenantCollision(
    db: PostgresJsDatabase<any>,
    params: { serviceName: string; externalUserId: string | null | undefined; organisationId: number },
): Promise<TenantCollision | null> {
    if (!tenantCollisionEnforced()) return null;
    if (COLLISION_EXEMPT_SERVICES.has(canonicalService(params.serviceName))) return null;

    const tenantId = params.externalUserId;
    if (!tenantId) return null;

    const [row] = await db
        .select({ id: systemConnections.id, organisationId: systemConnections.organisationId })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.serviceName, canonicalService(params.serviceName)),
            eq(systemConnections.externalUserId, tenantId),
            eq(systemConnections.isActive, true),
            eq(systemConnections.status, 'active'),
            ne(systemConnections.organisationId, params.organisationId),
        ))
        .limit(1);

    return row ? { connectionId: row.id, organisationId: row.organisationId } : null;
}

/** Postgres unique-violation SQLSTATE — thrown by the DB backstop index on a collision race. */
export const UNIQUE_VIOLATION = '23505';

/**
 * US2: persist a rejected connection attempt so the requester can later ask to join the workspace
 * that already holds this tenant — or, as its owner/admin, move the account (connection-move.ts).
 * Returns the attempt id for the redirect, or null if it could not be written. Best-effort — never
 * let a logging failure break the OAuth redirect.
 */
export async function recordCollisionAttempt(
    db: PostgresJsDatabase<any>,
    params: { requestingOrgId: number; existingOrgId: number; serviceName: string; externalUserId: string },
): Promise<number | null> {
    try {
        const [row] = await db.insert(connectionCollisionAttempts).values({
            requestingOrgId: params.requestingOrgId,
            existingOrgId: params.existingOrgId,
            // request-workspace-access.ts matches this column against a lowercased `platform`.
            serviceName: canonicalService(params.serviceName),
            externalUserId: params.externalUserId,
            status: 'pending',
        }).returning({ id: connectionCollisionAttempts.id });
        return row?.id ?? null;
    } catch (e) {
        console.warn('[connection-collision] failed to record attempt (non-blocking):', e);
        return null;
    }
}

/** The `&collision=<id>` suffix for a tenant_collision redirect; empty when the attempt was not recorded. */
export const collisionParam = (attemptId: number | null): string => (attemptId ? `&collision=${attemptId}` : '');
