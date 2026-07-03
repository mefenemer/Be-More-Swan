// netlify/functions/refresh-social-tokens.ts
// Task 4 — silent OAuth token renewal for X (Twitter) and LinkedIn so connections
// never expire and the user is never asked to reconnect.
//
//   • X (Twitter) access tokens are short-lived (~2h) but ship with an `offline.access`
//     refresh token that rotates on every use. Refreshed when < 90 minutes remain.
//   • LinkedIn access tokens are long-lived (~60 days) with a 1-year refresh token
//     (captured at callback when the app is enrolled in LinkedIn's refresh-token
//     programme). Refreshed when < 14 days remain.
//
// Scheduled every 30 minutes (netlify.toml) — frequent enough to keep the 2h X tokens
// warm. Mirrors refresh-meta-tokens.ts for failure side-effects (pause posts + notify).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, scheduledPosts, notifications, users, auditLogs, userOrganisations } from '../../db/schema';
import { storeSecret, getSecret } from '../../src/utils/vault';
import { sendEmail } from '../../src/utils/email';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { systemPauseWorkingAssistants } from '../../src/utils/assistant-lifecycle';

const CONCURRENCY = 25;

// How close to expiry (ms) before we proactively refresh, per platform.
const REFRESH_WINDOW_MS: Record<string, number> = {
    x:        90 * 60 * 1000,             // 90 minutes (tokens last ~2h)
    linkedin: 14 * 24 * 60 * 60 * 1000,  // 14 days
};

const LABELS: Record<string, string> = { x: 'X (Twitter)', linkedin: 'LinkedIn' };

type Conn = {
    id: number;
    organisationId: number;
    assistantId: number | null;
    serviceName: string;
    vaultRefKey: string | null;
    tokenExpiresAt: Date | null;
};

export const handler: Handler = async () => {
    const db = getDb();

    const connections = await db
        .select({
            id: systemConnections.id,
            organisationId: systemConnections.organisationId,
            assistantId: systemConnections.assistantId,
            serviceName: systemConnections.serviceName,
            vaultRefKey: systemConnections.vaultRefKey,
            tokenExpiresAt: systemConnections.tokenExpiresAt,
        })
        .from(systemConnections)
        .where(and(
            inArray(systemConnections.serviceName, ['x', 'linkedin']),
            eq(systemConnections.status, 'active'),
        ));

    // Only refresh those approaching expiry within their platform's window.
    const now = Date.now();
    const due = connections.filter((c) => {
        const window = REFRESH_WINDOW_MS[c.serviceName];
        if (!window) return false;
        // No expiry recorded → refresh to establish one.
        if (!c.tokenExpiresAt) return true;
        return new Date(c.tokenExpiresAt).getTime() - now < window;
    });

    if (!due.length) return { statusCode: 200, body: 'no social tokens to refresh' };

    for (let i = 0; i < due.length; i += CONCURRENCY) {
        const chunk = due.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map((conn) => refreshConnection(db, conn)));
    }

    return { statusCode: 200, body: `refreshed up to ${due.length} social token(s)` };
};

async function refreshConnection(db: ReturnType<typeof getDb>, conn: Conn) {
    if (!conn.vaultRefKey) return;

    try {
        const stored = await getSecret(db, conn.vaultRefKey);
        const refreshToken = stored?.refreshToken as string | undefined;
        if (!refreshToken) {
            // No refresh token on file (e.g. a legacy connection captured before we
            // stored one). Can't renew silently — leave it for the health-check/expiry
            // path to surface a reconnect prompt. Skip without flipping status.
            console.warn(`[refresh-social-tokens] conn ${conn.id} (${conn.serviceName}) has no refresh token — skipping`);
            return;
        }

        const refreshed = conn.serviceName === 'x'
            ? await refreshX(refreshToken)
            : await refreshLinkedIn(refreshToken);

        // Persist the (possibly rotated) refresh token alongside the new access token.
        await storeSecret(db, conn.vaultRefKey, {
            token: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? refreshToken,
        });

        const newExpiry = new Date(Date.now() + refreshed.expiresInSec * 1000);
        await db.update(systemConnections).set({
            tokenExpiresAt: newExpiry,
            status: 'active',
            updatedAt: new Date(),
        }).where(eq(systemConnections.id, conn.id));

        await db.insert(auditLogs).values({
            actionType: `${conn.serviceName}_token_refreshed`,
            resourceType: 'system_connections',
            resourceId: String(conn.id),
            newState: { organisationId: conn.organisationId, newExpiry },
        });

        // Token healthy again — clear any open "reconnect" prompt for this org's user.
        const [refreshedUser] = await db.select({ id: users.id }).from(users)
            .innerJoin(userOrganisations, eq(users.id, userOrganisations.userId))
            .where(eq(userOrganisations.organisationId, conn.organisationId)).limit(1);
        if (refreshedUser) await resolveActionNotifications(db, refreshedUser.id, CONNECTION_RESTORED_TYPES);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refresh-social-tokens] conn ${conn.id} (${conn.serviceName}) failed:`, msg);
        await handleRefreshFailure(db, conn, msg);
    }
}

// ── X (Twitter) — OAuth2 refresh token grant (confidential client) ──────────────
async function refreshX(refreshToken: string) {
    const clientId     = process.env.X_CLIENT_ID!;
    const clientSecret = process.env.X_CLIENT_SECRET!;
    const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    const data: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } = await res.json();
    if (!data.access_token) throw new Error(data.error_description || data.error || 'X token refresh failed');

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null, // X rotates the refresh token
        expiresInSec: data.expires_in ?? 7200,
    };
}

// ── LinkedIn — OAuth2 refresh token grant ───────────────────────────────────────
async function refreshLinkedIn(refreshToken: string) {
    const clientId     = process.env.LINKEDIN_CLIENT_ID!;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET!;

    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    const data: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } = await res.json();
    if (!data.access_token) throw new Error(data.error_description || data.error || 'LinkedIn token refresh failed');

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null, // LinkedIn may rotate the refresh token
        expiresInSec: data.expires_in ?? 60 * 24 * 60 * 60,
    };
}

// Shared failure handling: mark unhealthy, pause posts, and prompt a reconnect.
async function handleRefreshFailure(db: ReturnType<typeof getDb>, conn: Conn, msg: string) {
    const label = LABELS[conn.serviceName] || conn.serviceName;

    await db.update(systemConnections).set({
        status: 'token_refresh_failed',
        updatedAt: new Date(),
    }).where(eq(systemConnections.id, conn.id));

    await db.update(scheduledPosts).set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(scheduledPosts.connectionId, conn.id), eq(scheduledPosts.status, 'scheduled')));

    const [orgUser] = await db.select({ id: users.id, email: users.email }).from(users)
        .innerJoin(userOrganisations, eq(users.id, userOrganisations.userId))
        .where(eq(userOrganisations.organisationId, conn.organisationId)).limit(1);

    if (orgUser) {
        await db.insert(notifications).values({
            userId: orgUser.id,
            type: `${conn.serviceName}_token_refresh_failed`,
            title: `${label} connection expired`,
            message: `Your ${label} account needs to be reconnected. Any scheduled posts will not be published until you reconnect.`,
            metadata: { connectionId: conn.id },
        });
        await sendEmail({
            to: orgUser.email,
            subject: `Action required: Reconnect your ${label} account`,
            html: `<p>Your ${label} account connected to Be More Swan needs to be reconnected — its access token could not be automatically refreshed.</p>
                   <p>Any scheduled posts have been paused and will resume once you reconnect.</p>
                   <p><a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/workspace.html?reconnect=${conn.serviceName}">Reconnect ${label} →</a></p>`,
        });
    }

    await db.insert(auditLogs).values({
        actionType: `${conn.serviceName}_token_refresh_failed`,
        resourceType: 'system_connections',
        resourceId: String(conn.id),
        newState: { error: msg },
    });

    // US5 AC5.1(a): a required OAuth token expired and could not be refreshed → force the
    // dependent working assistant(s) into system_paused. Scoped to the assistant when the
    // connection is assistant-scoped, else the whole org (shared connection pool).
    await systemPauseWorkingAssistants(
        db,
        { organisationId: conn.organisationId, assistantId: conn.assistantId },
        `token_refresh_failed:${conn.serviceName}`,
    );
}
