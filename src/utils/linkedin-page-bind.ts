// src/utils/linkedin-page-bind.ts
// Bind a chosen LinkedIn Company Page to a workspace. Called from social-oauth-callback.ts when the
// member administers exactly one Page, and from linkedin-page-pick.ts once they choose among several.
//
// The Page becomes the workspace's ONE LinkedIn connection (service_name 'linkedin'), replacing a
// personal-feed connection if there was one, so publishing, the Connections card, relevance and the
// blog destination all keep working unchanged: publishLinkedIn() already accepts a full URN as the
// author. What tells the rest of the system it is a Page is external_user_id = urn:li:organization:*
// (see linkedin-page.ts).

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { systemConnections, auditLogs } from '../../db/schema';
import { createNotification } from './notify';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from './notification-actions';
import { restoreConnectionDependents } from './connection-recovery';
import { findTenantCollision, recordCollisionAttempt } from './connection-collision';
import { linkedinPageScopes } from '../config/linkedin-capabilities';
import type { LinkedInPage } from './linkedin-page';

type Db = ReturnType<typeof getDb>;

/** Vault key for a Page token. Separate from the member's `linkedin-token` so neither overwrites the other. */
export const linkedInPageVaultKey = (organisationId: number) => `aura/org-${organisationId}/linkedin-page-token`;

/** Vault key for the Pages awaiting a choice after sign-in. One per user; consumed on pick. */
export const linkedInPagePickKey = (userId: number) => `linkedin_page_pick:${userId}`;

/** How long the picker may wait — the same 10 minutes the OAuth CSRF state lives. */
export const LINKEDIN_PAGE_PICK_TTL_MS = 10 * 60 * 1000;

export type PendingPagePick = {
    organisationId: number;
    assistantId: number | null;
    pages: LinkedInPage[];
    tokenExpiresAt: string | null;
    expiresAt: number;
};

export type BindResult =
    | { ok: true; reconnected: boolean }
    | { ok: false; collisionAttemptId: number | null };

export async function bindLinkedInPage(db: Db, opts: {
    organisationId: number;
    userId: number;
    assistantId: number | null;
    page: LinkedInPage;
    tokenExpiresAt: Date | null;
}): Promise<BindResult> {
    const { organisationId, userId, assistantId, page, tokenExpiresAt } = opts;

    // Unlike a member profile, a Page IS a business, so it gets the same one-workspace rule as a
    // Facebook Page (connection-collision.ts exempts LinkedIn only for member ids).
    const collision = await findTenantCollision(db, { serviceName: 'linkedin', externalUserId: page.urn, organisationId });
    if (collision) {
        const attemptId = await recordCollisionAttempt(db, { requestingOrgId: organisationId, existingOrgId: collision.organisationId, serviceName: 'linkedin', externalUserId: page.urn });
        return { ok: false, collisionAttemptId: attemptId ?? null };
    }

    const [existing] = await db.select({ id: systemConnections.id, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'linkedin')))
        .limit(1);

    const scopes = linkedinPageScopes();
    const vaultRefKey = linkedInPageVaultKey(organisationId);
    // pageName is display-only (the card's "Posting as …"); the URN is the identity.
    const metadata = { ...((existing?.metadata as Record<string, unknown> | null) ?? {}), linkedinPageName: page.name };

    if (existing) {
        await db.update(systemConnections).set({ vaultRefKey, externalUserId: page.urn, tokenExpiresAt, status: 'active', isActive: true, scopes, metadata, ...(assistantId ? { assistantId } : {}), updatedAt: new Date() }).where(eq(systemConnections.id, existing.id));
    } else {
        await db.insert(systemConnections).values({ organisationId, userId, assistantId, serviceName: 'linkedin', connectionType: 'oauth', vaultRefKey, externalUserId: page.urn, tokenExpiresAt, status: 'active', isActive: true, scopes, metadata });
    }

    await createNotification(db, existing ? 'linkedin_reconnected' : 'linkedin_connected', { userId, metadata: assistantId ? { assistantId } : null });
    // Same order as the member branch: un-pause what the old connection's failure halted, only
    // AFTER the status='active' write (the assistant-resume guard reads current statuses).
    if (existing) {
        await restoreConnectionDependents(db, { connectionId: existing.id, organisationId, assistantId, serviceName: 'linkedin', userId });
    } else {
        await resolveActionNotifications(db, userId, CONNECTION_RESTORED_TYPES);
    }
    await db.insert(auditLogs).values({ actionType: existing ? 'linkedin_reconnected' : 'linkedin_connected', resourceType: 'system_connections', resourceId: page.urn, newState: { organisationId, linkedinPage: page.name } });

    return { ok: true, reconnected: !!existing };
}
