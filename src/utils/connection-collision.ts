// src/utils/connection-collision.ts
// Security & Fair Usage — Multi-Account Abuse Prevention (US1: OAuth Tenant Collision Blocking).
//
// A given third-party tenant (the provider's unique org/account id — Instagram user id, Facebook
// Page id, X user id, LinkedIn id, etc., stored as system_connections.external_user_id) may only be
// actively connected to ONE Be More Swan workspace. This helper detects when a DIFFERENT workspace
// already holds an active connection to the same (service_name, external_user_id), so OAuth callbacks
// can reject the attempt before persisting a token. The DB also enforces this with a partial unique
// index (db/connection-tenant-uniqueness.sql) as the race-proof backstop.

import { and, eq, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { systemConnections, connectionCollisionAttempts } from '../../db/schema';

export type TenantCollision = { connectionId: number; organisationId: number };

/**
 * Returns the colliding connection (active, owned by a different org) for this provider tenant,
 * or null when the tenant is free to connect. A null/empty externalUserId never collides.
 */
export async function findTenantCollision(
    db: PostgresJsDatabase<any>,
    params: { serviceName: string; externalUserId: string | null | undefined; organisationId: number },
): Promise<TenantCollision | null> {
    const tenantId = params.externalUserId;
    if (!tenantId) return null;

    const [row] = await db
        .select({ id: systemConnections.id, organisationId: systemConnections.organisationId })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.serviceName, params.serviceName),
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
 * that already holds this tenant. Best-effort — never let a logging failure break the OAuth redirect.
 */
export async function recordCollisionAttempt(
    db: PostgresJsDatabase<any>,
    params: { requestingOrgId: number; existingOrgId: number; serviceName: string; externalUserId: string },
): Promise<void> {
    try {
        await db.insert(connectionCollisionAttempts).values({
            requestingOrgId: params.requestingOrgId,
            existingOrgId: params.existingOrgId,
            serviceName: params.serviceName,
            externalUserId: params.externalUserId,
            status: 'pending',
        });
    } catch (e) {
        console.warn('[connection-collision] failed to record attempt (non-blocking):', e);
    }
}
