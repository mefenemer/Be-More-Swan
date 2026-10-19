// netlify/functions/integration-health-check.ts
// US-GAP-10.1.1: Integration Token Expiry Alert
//
// Scheduled daily at 08:30 UTC — `[functions.integration-health-check]` in netlify.toml.
// ⚠️ Until October 2026 that schedule did not exist: this header claimed it, nothing ran it, and no
// expiry or disconnection alert ever went out. LinkedIn connections died at 60 days with no warning.
//
// SC1: Checks systemConnections expiring within 7 days that nothing renews, or that broke recently,
//      plus workspace_integrations rows whose refresh grant has died (status 'expired')
// SC2: In-app alert for expiring and expired tokens
// SC3: Email alert for already-expired tokens
// SC6: ONE alert per connection per cycle (processedWebhookEvents). It used to dedupe per DAY,
//      which — had it ever run — would have emailed every dead connection daily, forever.

import type { Handler } from '@netlify/functions';
import { eq, and, or, lte, gte, isNotNull, inArray, notInArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, systemConnections, workspaceIntegrations, processedWebhookEvents } from '../../db/schema';
import { normalizePlatform, PLATFORM_FORMATS } from '../../src/config/platform-formats';
import { DEAD_CONNECTION_STATUSES, isConnectionDead } from '../../src/config/connection-status';
import { CRON_RENEWED_SERVICES, CRON_WARNS_OWN_EXPIRY } from '../../src/config/connection-renewal';
import { createNotification } from '../../src/utils/notify';
import { sendEmail } from '../../src/utils/email';
import { withLambda } from '@netlify/aws-lambda-compat';

const BASE_URL = process.env.BASE_URL || '';

/**
 * Dead statuses this job must NOT alert on, because somebody already did or nobody should:
 *   token_refresh_failed — written only by refresh-social-tokens / refresh-meta-tokens, and both
 *                          send their own notification AND email in the same breath.
 *   revoked              — the customer's own decision (Disconnect, or removing our app at Meta).
 *                          "Action required: reconnect" would be telling them off for it.
 */
export const ALREADY_HANDLED_DEAD_STATUSES = ['token_refresh_failed', 'revoked'];

/**
 * Expiring tokens this job must NOT alert on: a cron renews them (an X token ALWAYS looks like it
 * expires within the week — it lasts 2 hours), or a cron sends its own warning (LinkedIn).
 */
export const NO_EXPIRY_ALERT_SERVICES = [...CRON_RENEWED_SERVICES, ...CRON_WARNS_OWN_EXPIRY];

/**
 * Only breakages from the last 30 days. Switching this job on for the first time would otherwise
 * email about every connection that died since the summer and was quietly abandoned.
 */
const MAX_DEAD_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A stamp that changes on reconnect and on breaking, so each cycle alerts once and only once. */
function cycleStamp(d: Date | string | null | undefined): string {
    if (!d) return 'none';
    const t = d instanceof Date ? d : new Date(d);
    return isNaN(t.getTime()) ? 'none' : t.toISOString();
}

async function runIntegrationHealthCheck() {
    const db  = getDb();
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const deadSince = new Date(now.getTime() - MAX_DEAD_AGE_MS);
    const alertableDead = DEAD_CONNECTION_STATUSES.filter(s => !ALREADY_HANDLED_DEAD_STATUSES.includes(s));

    // SC1: Find connections expiring within 7 days OR already expired/failed
    const atRiskConnections = await db
        .select({
            id:            systemConnections.id,
            userId:        systemConnections.userId,
            assistantId:   systemConnections.assistantId,
            serviceName:   systemConnections.serviceName,
            status:        systemConnections.status,
            tokenExpiresAt: systemConnections.tokenExpiresAt,
            updatedAt:     systemConnections.updatedAt,
        })
        .from(systemConnections)
        .where(or(
            // Expiring soon (within 7 days, still active) and nothing renews or warns about it
            and(
                eq(systemConnections.status, 'active'),
                isNotNull(systemConnections.tokenExpiresAt),
                lte(systemConnections.tokenExpiresAt, in7d),
                notInArray(systemConnections.serviceName, NO_EXPIRY_ALERT_SERVICES),
            ),
            // Already broken. This used to be eq('expired') OR eq('failed') — two values NOTHING
            // writes to this table — while the value the Meta paths actually write, 'token_expired',
            // matched neither branch. A dead Facebook/Instagram connection therefore produced no
            // alert and no email, ever. See src/config/connection-status.ts.
            // Minus the statuses whose writer already alerted (or that the customer chose), and
            // only recent ones — see ALREADY_HANDLED_DEAD_STATUSES and MAX_DEAD_AGE_MS.
            and(
                inArray(systemConnections.status, alertableDead),
                gte(systemConnections.updatedAt, deadSince),
            ),
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
    //
    // 'expired' only. 'revoked' here is the customer removing our app at Meta (meta-callbacks.ts),
    // and nothing writes 'error'.
    const DEAD_WORKSPACE_STATUSES = ['expired'];
    const atRiskWorkspace = await db
        .select({
            id: workspaceIntegrations.id,
            userId: workspaceIntegrations.connectedBy,
            provider: workspaceIntegrations.provider,
            status: workspaceIntegrations.status,
            updatedAt: workspaceIntegrations.updatedAt,
        })
        .from(workspaceIntegrations)
        .where(and(
            inArray(workspaceIntegrations.status, DEAD_WORKSPACE_STATUSES),
            gte(workspaceIntegrations.updatedAt, deadSince),
        ));

    type AtRisk = {
        /** Namespaced so a workspace_integrations id can't collide with a system_connections one. */
        dedupeId: string;
        userId: number | null;
        assistantId: number | null;
        connectionId: number | null;
        serviceName: string;
        status: string;
        tokenExpiresAt: Date | string | null;
        /** When the row last changed — the flip to dead sets it, so does a reconnect. */
        updatedAt: Date | string | null;
    };
    const atRisk: AtRisk[] = [
        ...atRiskConnections.map(c => ({
            dedupeId: String(c.id), userId: c.userId, assistantId: c.assistantId,
            connectionId: c.id, serviceName: c.serviceName, status: c.status,
            tokenExpiresAt: c.tokenExpiresAt, updatedAt: c.updatedAt,
        })),
        ...atRiskWorkspace.map(w => ({
            dedupeId: `ws:${w.id}`, userId: w.userId, assistantId: null,
            connectionId: null, serviceName: w.provider, status: 'expired',
            tokenExpiresAt: null, updatedAt: w.updatedAt,
        })),
    ];

    for (const conn of atRisk) {
        if (!conn.userId) continue;

        const expiry = conn.tokenExpiresAt
            ? (conn.tokenExpiresAt instanceof Date ? conn.tokenExpiresAt : new Date(conn.tokenExpiresAt as string))
            : null;

        const isExpired = isConnectionDead(conn.status) || (expiry && expiry <= now);
        const daysLeft  = expiry && !isExpired
            ? Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
            : 0;

        const alertType  = isExpired ? 'expired' : 'expiring';
        // SC6: once per cycle. Expiring → keyed on the expiry, which a reconnect moves 60 days out.
        // Expired → keyed on when the row last changed, which the flip to dead sets. Either way a
        // reconnect starts a fresh cycle and an unchanged connection is never alerted twice.
        const cycle      = alertType === 'expiring' ? cycleStamp(conn.tokenExpiresAt) : cycleStamp(conn.updatedAt);
        const dedupeKey  = `integration-alert:${conn.dedupeId}:${alertType}:${cycle}`;

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
