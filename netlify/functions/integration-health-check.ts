// netlify/functions/integration-health-check.ts
// US-GAP-10.1.1: Integration Token Expiry Alert
//
// Scheduled daily at 08:30 UTC (schedule: "30 8 * * *")
// SC1: Checks all systemConnections where tokenExpiresAt is within 7 days OR status='expired'/'failed'
// SC2: In-app alert for expiring tokens (< 7 days)
// SC3: Email alert for already-expired tokens
// SC6: 24-hour dedup per connection using processedWebhookEvents

import type { Handler } from '@netlify/functions';
import { eq, and, or, lte, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, systemConnections, notifications, processedWebhookEvents } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

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

    for (const conn of atRiskConnections) {
        if (!conn.userId) continue;

        const expiry = conn.tokenExpiresAt
            ? (conn.tokenExpiresAt instanceof Date ? conn.tokenExpiresAt : new Date(conn.tokenExpiresAt as string))
            : null;

        const isExpired = conn.status === 'expired' || conn.status === 'failed' || (expiry && expiry <= now);
        const daysLeft  = expiry && !isExpired
            ? Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
            : 0;

        const alertType  = isExpired ? 'expired' : 'expiring';
        const dedupeKey  = `integration-alert:${conn.id}:${alertType}:${new Date().toISOString().slice(0, 10)}`; // daily dedup

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

        const displayName = conn.serviceName.charAt(0).toUpperCase() + conn.serviceName.slice(1);

        // SC2: In-app alert for both expiring and expired
        const notifTitle = isExpired
            ? `${displayName} disconnected — action required`
            : `${displayName} connection expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
        const notifMsg = isExpired
            ? `Your ${displayName} integration has been disconnected. Re-authorise it to keep your assistants running.`
            : `Your ${displayName} connection will expire in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Re-authorise to avoid interruption.`;

        await db.insert(notifications).values({
            userId: conn.userId,
            type: 'integration_alert',
            title: notifTitle,
            message: notifMsg,
            isRead: false,
            metadata: { connectionId: conn.id, serviceName: conn.serviceName, alertType },
        }).catch(() => {});

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

export const handler: Handler = async () => {
    try {
        await runIntegrationHealthCheck();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[integration-health-check]', err);
        return { statusCode: 500 };
    }
};
