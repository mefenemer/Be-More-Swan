// netlify/functions/refresh-meta-tokens.ts
// US-SMM-3.2.2: Nightly token refresh for Instagram connections expiring within 14 days.
// Scheduled: 01:00 UTC daily (netlify.toml).
// Also handles disconnection side-effects: pause scheduled_posts when token is expired/revoked.

import { Handler } from '@netlify/functions';
import { and, eq, lt, lte, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, scheduledPosts, users, auditLogs, userOrganisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { storeSecret, getSecret } from '../../src/utils/vault';
import { sendEmail } from '../../src/utils/email';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { systemPauseWorkingAssistants } from '../../src/utils/assistant-lifecycle';
import { withLambda } from '@netlify/aws-lambda-compat';
import { reconnectUrl } from '../../src/utils/connection-recovery';

// Both Meta products this cron refreshes. Mirrors refresh-social-tokens.ts.
const LABELS: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook' };

const metaAppId  = process.env.META_APP_ID!;
const metaSecret = process.env.META_APP_SECRET!;
const CONCURRENCY = 50;

export default withLambda(async () => {
    const db = getDb();
    const fourteenDaysFromNow = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    // Find active Instagram AND Facebook connections expiring within 14 days
    const connections = await db
        .select({
            id: systemConnections.id,
            organisationId: systemConnections.organisationId,
            assistantId: systemConnections.assistantId,
            serviceName: systemConnections.serviceName,
            vaultRefKey: systemConnections.vaultRefKey,
            externalUserId: systemConnections.externalUserId,
            tokenExpiresAt: systemConnections.tokenExpiresAt,
        })
        .from(systemConnections)
        .where(and(
            // Both Meta products store a 60-day long-lived user token refreshed the same way
            // (fb_exchange_token), so refresh 'facebook' Page connections alongside 'instagram'.
            inArray(systemConnections.serviceName, ['instagram', 'facebook']),
            eq(systemConnections.status, 'active'),
            lt(systemConnections.tokenExpiresAt, fourteenDaysFromNow),
        ));

    if (!connections.length) return { statusCode: 200, body: 'no tokens to refresh' };

    // Process in chunks to respect Meta rate limit
    for (let i = 0; i < connections.length; i += CONCURRENCY) {
        const chunk = connections.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map(conn => refreshToken(db, conn)));
    }

    return { statusCode: 200, body: `refreshed ${connections.length} token(s)` };
});

async function refreshToken(db: ReturnType<typeof getDb>, conn: {
    id: number; organisationId: number; assistantId: number | null; serviceName: string;
    vaultRefKey: string | null; externalUserId: string | null; tokenExpiresAt: Date | null;
}) {
    if (!conn.vaultRefKey) return;

    try {
        const tokenData = await getSecret(db, conn.vaultRefKey);
        const existingToken = tokenData?.token as string | undefined;
        if (!existingToken) throw new Error('No token in vault for connection.');
        const res = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${metaAppId}&client_secret=${metaSecret}&fb_exchange_token=${existingToken}`
        );
        const data: { access_token?: string; expires_in?: number; error?: { message: string } } = await res.json();

        if (!data.access_token) throw new Error(data.error?.message ?? 'Token refresh failed');

        await storeSecret(db, conn.vaultRefKey, { token: data.access_token });

        const newExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
        await db.update(systemConnections).set({
            tokenExpiresAt: newExpiry,
            status: 'active',
            updatedAt: new Date(),
        }).where(eq(systemConnections.id, conn.id));

        await db.insert(auditLogs).values({ actionType: 'instagram_token_refreshed', resourceType: 'system_connections', resourceId: String(conn.id), newState: { organisationId: conn.organisationId, newExpiry } });

        // Token is healthy again — clear any open "reconnect" prompt for this org's user.
        const [refreshedUser] = await db.select({ id: users.id }).from(users)
            .innerJoin(userOrganisations, eq(users.id, userOrganisations.userId))
            .where(eq(userOrganisations.organisationId, conn.organisationId)).limit(1);
        if (refreshedUser) await resolveActionNotifications(db, refreshedUser.id, CONNECTION_RESTORED_TYPES);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refresh-meta-tokens] conn ${conn.id} failed:`, msg);

        await db.update(systemConnections).set({
            status: 'token_refresh_failed',
            updatedAt: new Date(),
        }).where(eq(systemConnections.id, conn.id));

        // Pause all scheduled posts for this connection
        await db.update(scheduledPosts).set({ status: 'paused', updatedAt: new Date() })
            .where(and(eq(scheduledPosts.connectionId, conn.id), eq(scheduledPosts.status, 'scheduled')));

        // Notify the user
        const [orgUser] = await db.select({ id: users.id, email: users.email }).from(users)
            .innerJoin(userOrganisations, eq(users.id, userOrganisations.userId))
            .where(eq(userOrganisations.organisationId, conn.organisationId)).limit(1);

        // This cron handles BOTH Meta products (see the inArray filter above), but every piece of
        // user-facing copy here was hardcoded to Instagram — so a dead Facebook Page connection
        // emailed the user "Reconnect your Instagram account" and raised an Instagram notification.
        const label = LABELS[conn.serviceName] || conn.serviceName;

        if (orgUser) {
            await createNotification(db, 'social_token_refresh_failed', {
                userId: orgUser.id,
                // Computed type so resolve-on-reconnect can match a single platform (see notify.ts).
                // For Instagram this still resolves to 'instagram_token_refresh_failed', so the
                // existing type — and everything keyed off it — is unchanged.
                typeOverride: `${conn.serviceName}_token_refresh_failed`,
                context: { platform: { label } },
                metadata: { connectionId: conn.id, assistantId: conn.assistantId },
            });
            await sendEmail({
                to: orgUser.email,
                subject: `Action required: Reconnect your ${label} account`,
                html: `<p>Your ${label} account connected to Be More Swan needs to be reconnected — your token could not be automatically refreshed.</p>
                       <p>Your scheduled posts have been paused and will resume once you reconnect.</p>
                       <p><a href="${reconnectUrl(conn.serviceName, conn.assistantId)}">Reconnect ${label} →</a></p>`,
            });
        }

        await db.insert(auditLogs).values({ actionType: `${conn.serviceName}_token_refresh_failed`, resourceType: 'system_connections', resourceId: String(conn.id), newState: { error: msg } });

        // US5 AC5.1(a): expired/unrefreshable token → force dependent working assistant(s) into
        // system_paused (assistant-scoped when set, else the whole org).
        await systemPauseWorkingAssistants(
            db,
            { organisationId: conn.organisationId, assistantId: conn.assistantId },
            // Was hardcoded 'instagram' for both platforms this cron handles. connection-recovery.ts
            // matches this reason against the connection being restored to decide whether an
            // assistant may resume, so a Facebook failure filed under 'instagram' would never be
            // undone by reconnecting Facebook.
            `token_refresh_failed:${conn.serviceName}`,
        );
    }
}
