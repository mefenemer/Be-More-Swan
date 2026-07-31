// netlify/functions/integration-health-check.ts
// US-GAP-10.1.1: Integration Token Expiry Alert
//
// Scheduled daily at 08:30 UTC (schedule: "30 8 * * *")
// SC1: Checks all systemConnections where tokenExpiresAt is within 7 days OR status='expired'/'failed',
//      plus workspace_integrations rows whose refresh grant has died (status expired/revoked/error)
// SC2: In-app alert for expiring tokens (< 7 days)
// SC3: Email alert for already-expired tokens
// SC6: 24-hour dedup per connection using processedWebhookEvents

import type { Handler } from '@netlify/functions';
import { eq, and, or, lte, isNotNull, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, systemConnections, workspaceIntegrations, processedWebhookEvents } from '../../db/schema';
import { normalizePlatform, PLATFORM_FORMATS } from '../../src/config/platform-formats';
import { createNotification } from '../../src/utils/notify';
import { sendEmail } from '../../src/utils/email';
import { withLambda } from '@netlify/aws-lambda-compat';

const BASE_URL = process.env.BASE_URL || '';

async function runIntegrationHealthCheck() {
    const db  = getDb();
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // SC1: Find connections expiring within 7 days OR already expired/failed
    const atRiskConnections = await db
        .select({
            id:            systemConnections.id,
            userId:        systemConnections.userId,
            assistantId:   systemConnections.assistantId,
            serviceName:   systemConnections.serviceName,
            status:        systemConnections.status,
            tokenExpiresAt: systemConnections.tokenExpiresAt,
        })
        .from(systemConnections)
        .where(or(
            // Expiring soon (within 7 days, still active)
            and(
                eq(systemConnections.status, 'active'),
                isNotNull(systemConnections.tokenExpiresAt),
                lte(systemConnections.tokenExpiresAt, in7d),
            ),
            // Already expired or failed
            eq(systemConnections.status, 'expired'),
            eq(systemConnections.status, 'failed'),
        ));

    // The other credential store. Threads, YouTube and the Google connectors authenticate into
    // workspace_integrations, so this cron never saw them: a dead Threads grant produced no alert
    // and no email — the user's first sign was Autopilot quietly drafting for one platform fewer.
    //
    // Only DEAD statuses qualify, never an imminent expiresAt: these tokens are renewed
    // automatically (getFreshAccessToken + refresh-workspace-tokens), and a Google access token
    // lapses hourly by design, so an expiry-window alert here would fire every single day on a
    // perfectly healthy connection. getFreshAccessToken writes 'expired' when the refresh grant
    // itself is rejected, which is the honest "you must reconnect" signal.
    const DEAD_WORKSPACE_STATUSES = ['expired', 'revoked', 'error'];
    const atRiskWorkspace = await db
        .select({
            id: workspaceIntegrations.id,
            userId: workspaceIntegrations.connectedBy,
            provider: workspaceIntegrations.provider,
            status: workspaceIntegrations.status,
        })
        .from(workspaceIntegrations)
        .where(inArray(workspaceIntegrations.status, DEAD_WORKSPACE_STATUSES));

    type AtRisk = {
        /** Namespaced so a workspace_integrations id can't collide with a system_connections one. */
        dedupeId: string;
        userId: number | null;
        assistantId: number | null;
        connectionId: number | null;
        serviceName: string;
        status: string;
        tokenExpiresAt: Date | string | null;
    };
    const atRisk: AtRisk[] = [
        ...atRiskConnections.map(c => ({
            dedupeId: String(c.id), userId: c.userId, assistantId: c.assistantId,
            connectionId: c.id, serviceName: c.serviceName, status: c.status,
            tokenExpiresAt: c.tokenExpiresAt,
        })),
        ...atRiskWorkspace.map(w => ({
            dedupeId: `ws:${w.id}`, userId: w.userId, assistantId: null,
            connectionId: null, serviceName: w.provider, status: 'expired',
            tokenExpiresAt: null,
        })),
    ];

    for (const conn of atRisk) {
        if (!conn.userId) continue;

        const expiry = conn.tokenExpiresAt
            ? (conn.tokenExpiresAt instanceof Date ? conn.tokenExpiresAt : new Date(conn.tokenExpiresAt as string))
            : null;

        const isExpired = conn.status === 'expired' || conn.status === 'failed' || (expiry && expiry <= now);
        const daysLeft  = expiry && !isExpired
            ? Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
            : 0;

        const alertType  = isExpired ? 'expired' : 'expiring';
        const dedupeKey  = `integration-alert:${conn.dedupeId}:${alertType}:${new Date().toISOString().slice(0, 10)}`; // daily dedup

        // SC6: 24-hour dedup
        const [alreadySent] = await db
            .select({ id: processedWebhookEvents.id })
            .from(processedWebhookEvents)
            .where(eq(processedWebhookEvents.stripeEventId, dedupeKey))
            .limit(1);
        if (alreadySent) continue;

        await db.insert(processedWebhookEvents)
            .values({ stripeEventId: dedupeKey, eventType: `integration_${alertType}_alert` })
            .onConflictDoNothing();

        // Catalogue label for a social platform ("X (Twitter)", not "X"), capitalised service name
        // for everything else (Canva, Gmail, …).
        const platformKey = normalizePlatform(conn.serviceName);
        const displayName = platformKey
            ? PLATFORM_FORMATS[platformKey].label
            : conn.serviceName.charAt(0).toUpperCase() + conn.serviceName.slice(1);

        // SC2: In-app alert for both expiring and expired.
        await createNotification(db, isExpired ? 'integration_alert_expired' : 'integration_alert_expiring', {
            userId: conn.userId,
            context: {
                platform: { label: displayName },
                expiry: { days_left: `${daysLeft} day${daysLeft === 1 ? '' : 's'}` },
            },
            metadata: { connectionId: conn.connectionId, serviceName: conn.serviceName, alertType, assistantId: conn.assistantId },
        });

        // SC3: Email only for already-expired connections
        if (isExpired) {
            const [user] = await db
                .select({ email: users.email, firstName: users.firstName })
                .from(users)
                .where(eq(users.id, conn.userId))
                .limit(1);

            if (user) {
                sendEmail({
                    to: user.email,
                    subject: `${displayName} disconnected — action required`,
                    html: `<p>Hi ${user.firstName || 'there'},</p>
                           <p>Your <strong>${displayName}</strong> integration has been disconnected. This means any assistants that rely on ${displayName} may not be functioning correctly.</p>
                           <p>Re-connect it now to restore full functionality:</p>
                           <p style="margin-top:20px;">
                             <a href="${BASE_URL}/workspace.html#integrations" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                               Re-connect ${displayName} →
                             </a>
                           </p>
                           <p>The Be More Swan Team</p>`,
                }).catch(() => {});
            }
        }
    }
}

export default withLambda(async () => {
    try {
        await runIntegrationHealthCheck();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[integration-health-check]', err);
        return { statusCode: 500 };
    }
});
