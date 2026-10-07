// src/utils/disconnect-revoke.ts
// What pressing Disconnect (integrations.ts DELETE) may do OUTSIDE the row being disconnected:
// revoke the token at the provider, and delete the vault secret.
//
// ── Why this needs a guard ──────────────────────────────────────────────────────────────────────
// ⚠️ The token stored for a facebook / instagram row is a Facebook USER token (meta-oauth.ts
// exchanges the login's code for a long-lived user token and stores it as `{ token }`). Meta's
// DELETE /me/permissions de-authorises the app for that whole LOGIN: every user token for the
// person is invalidated. It is not scoped to the one Page or IG account being disconnected.
//
// One owner with two businesses (e.g. Love Cat Studio and Be More Swan) connects both workspaces'
// Pages and IG accounts with the SAME Facebook login. Each row has its own vault key and its own
// external_user_id (the Page / IG id), but they all hold a token for the same login, recorded as
// metadata.fbUserId. Revoking from one Disconnect would kill Facebook AND Instagram in the other
// workspace, and Instagram in this one.
//
// So, for Meta, the remote revoke runs only when NO other active facebook/instagram row, in any
// workspace, carries the same fbUserId. A row without a recorded fbUserId (pre-picker legacy) is
// never revoked remotely: we cannot tell who else it would break. Deleting our copy of the token
// already ends our access through this row.
//
// LinkedIn and X: each workspace runs its own OAuth exchange and stores its own token under a
// per-org key (`aura/org-N/linkedin-token`, `aura/org-N/x-token`). Both providers revoke the ONE
// token presented (LinkedIn allows a member to hold several valid tokens for an app at once), so
// revoking this workspace's token leaves another workspace's alone. The only shared case is two
// rows reading the same vault key, which the vault check below covers for every service.
//
// The vault secret is deleted only when no other active row still reads the same vault_ref_key
// (legacy `aura/org-N/<service>-token` keys could be shared by two rows). connection-move.ts makes
// the same check and never revokes at the provider, for the same reason.

import { and, eq, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { systemConnections } from '../../db/schema';

type Db = PostgresJsDatabase<any>;

export const META_SERVICES: readonly string[] = ['facebook', 'instagram'];

export interface DisconnectSharing {
    /** Another active facebook/instagram row (any workspace) holds a token for the same Facebook login. */
    loginSharedElsewhere: boolean;
    /** Another active row reads the same vault secret. */
    vaultSharedElsewhere: boolean;
}

/** Pure: given who else shares this token, what Disconnect may do outside its own row. */
export function planDisconnectRevoke(
    params: { serviceName: string; fbUserId: string | null | undefined } & DisconnectSharing,
): { revokeAtProvider: boolean; deleteVaultSecret: boolean } {
    const deleteVaultSecret = !params.vaultSharedElsewhere;
    if (params.vaultSharedElsewhere) return { revokeAtProvider: false, deleteVaultSecret };
    if (META_SERVICES.includes(params.serviceName.toLowerCase())) {
        return { revokeAtProvider: !!params.fbUserId && !params.loginSharedElsewhere, deleteVaultSecret };
    }
    return { revokeAtProvider: true, deleteVaultSecret };
}

/** The two lookups planDisconnectRevoke needs. `connectionId` is excluded from both. */
export async function findDisconnectSharing(
    db: Db,
    params: { connectionId: number; serviceName: string; fbUserId: string | null | undefined; vaultRefKey: string },
): Promise<DisconnectSharing> {
    const [vaultSharer] = await db.select({ id: systemConnections.id }).from(systemConnections).where(and(
        eq(systemConnections.vaultRefKey, params.vaultRefKey),
        eq(systemConnections.isActive, true),
        ne(systemConnections.id, params.connectionId),
    )).limit(1);

    let loginSharer: { id: number } | undefined;
    if (META_SERVICES.includes(params.serviceName.toLowerCase()) && params.fbUserId) {
        [loginSharer] = await db.select({ id: systemConnections.id }).from(systemConnections).where(and(
            sql`lower(${systemConnections.serviceName}) in ('facebook', 'instagram')`,
            sql`${systemConnections.metadata}->>'fbUserId' = ${params.fbUserId}`,
            eq(systemConnections.isActive, true),
            ne(systemConnections.id, params.connectionId),
        )).limit(1);
    }

    return { loginSharedElsewhere: !!loginSharer, vaultSharedElsewhere: !!vaultSharer };
}
