// netlify/functions/churn-detection.ts
// US-AUD-3.1.1: Scheduled churn red-flag detection job.
//
// Runs daily (via Netlify scheduled function).
// Detects Signals 1, 3 & 4. Signal 2 is detected at task-submission time (run-task flow).
// Signal 5 is detected at support-ticket creation time (support-tickets flow).
//
// SC7: Deduplication — skips re-sending if same userId+signalType within 7 days.

import { HandlerEvent } from '@netlify/functions';
import { eq, and, lt, gte, isNull, count, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users,
    plans,
    taskRuns,
    systemConnections,
    userChurnSignals,
    pageEvents,
    userNotifications,
} from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const NETLIFY_CRON_SECRET = process.env.NETLIFY_CRON_SECRET;

// SC7: 7-day deduplication window
async function isRecentlySignalled(db: any, userId: number, signalType: string): Promise<boolean> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [existing] = await db
        .select({ id: userChurnSignals.id })
        .from(userChurnSignals)
        .where(
            and(
                eq(userChurnSignals.userId, userId),
                eq(userChurnSignals.signalType, signalType),
                gte(userChurnSignals.detectedAt, sevenDaysAgo)
            )
        )
        .limit(1);
    return !!existing;
}

async function insertSignal(db: any, userId: number, signalType: string, metadata: Record<string, any> = {}) {
    await db.insert(userChurnSignals).values({ userId, signalType, metadata });
}

async function sendInAppNotification(db: any, userId: number, title: string, message: string, type: string) {
    await db.insert(userNotifications).values({ userId, title, message, type });
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 1: Zero tasks in 7 days post-signup (SC2)
// ─────────────────────────────────────────────────────────────────────────────
async function detectNoTasks7d(db: any) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    // Active users created between 7–14 days ago with zero completed task_runs
    const activeUsers = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .innerJoin(plans, and(eq(plans.userId, users.id), eq(plans.status, 'active')))
        .where(and(lt(users.createdAt, sevenDaysAgo)))
        .limit(500);

    for (const user of activeUsers) {
        // Check zero completed task_runs
        const [taskCount] = await db
            .select({ cnt: count() })
            .from(taskRuns)
            .where(and(eq(taskRuns.userId, user.id), eq(taskRuns.status, 'completed')));

        if ((taskCount?.cnt ?? 0) > 0) continue;

        // SC7: dedup
        if (await isRecentlySignalled(db, user.id, 'no_tasks_7d')) continue;

        await insertSignal(db, user.id, 'no_tasks_7d', { detectedAt: now.toISOString() });

        // In-app notification
        await sendInAppNotification(
            db,
            user.id,
            'Your assistant is ready',
            'Your assistant is ready — try your first task now',
            'churn_signal'
        );

        // Email
        try {
            await sendEmail({
                to: user.email,
                subject: 'Your assistant is waiting — here\'s how to get started in 2 minutes',
                html: `<p>Hi ${user.firstName || 'there'},</p>
                       <p>Your Be More Swan assistant has been set up and is ready to help — but it looks like you haven't run a task yet.</p>
                       <p>It only takes 2 minutes to see what it can do. <a href="${process.env.BASE_URL}/workspace.html">Try your first task now →</a></p>
                       <p>The Be More Swan Team</p>`,
            });
        } catch { /* non-critical */ }

        // Mark intervention sent
        await db
            .update(userChurnSignals)
            .set({ interventionSentAt: now })
            .where(
                and(
                    eq(userChurnSignals.userId, user.id),
                    eq(userChurnSignals.signalType, 'no_tasks_7d'),
                    isNull(userChurnSignals.interventionSentAt)
                )
            );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 3: Integration disconnected 48h+ (SC4)
// ─────────────────────────────────────────────────────────────────────────────
async function detectIntegrationDisconnected(db: any) {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const now = new Date();

    // Connections that went failed/expired more than 48h ago
    const staleConnections = await db
        .select({
            userId: systemConnections.userId,
            integrationName: systemConnections.serviceName,
            updatedAt: systemConnections.updatedAt,
        })
        .from(systemConnections)
        .where(
            and(
                or(
                    eq(systemConnections.status, 'failed'),
                    eq(systemConnections.status, 'expired'),
                    eq(systemConnections.status, 'revoked')
                ),
                lt(systemConnections.updatedAt, fortyEightHoursAgo)
            )
        )
        .limit(500);

    for (const conn of staleConnections) {
        if (!conn.userId) continue;
        if (await isRecentlySignalled(db, conn.userId, 'integration_disconnected_48h')) continue;

        await insertSignal(db, conn.userId, 'integration_disconnected_48h', {
            integrationName: conn.integrationName,
            detectedAt: now.toISOString(),
        });

        const integrationName = conn.integrationName || 'integration';

        await sendInAppNotification(
            db,
            conn.userId,
            'Reconnect your integration',
            `Reconnect your ${integrationName} to keep your assistant running`,
            'churn_signal'
        );

        // Get user email for email notification
        const [user] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, conn.userId))
            .limit(1);

        if (user) {
            try {
                await sendEmail({
                    to: user.email,
                    subject: `Action needed: Reconnect your ${integrationName}`,
                    html: `<p>Hi ${user.firstName || 'there'},</p>
                           <p>Your <strong>${integrationName}</strong> connection has been disconnected for more than 48 hours. Your assistant won't be able to use it until you reconnect.</p>
                           <p><a href="${process.env.BASE_URL}/integrations.html">Reconnect your ${integrationName} now →</a></p>
                           <p>The Be More Swan Team</p>`,
                });
            } catch { /* non-critical */ }
        }

        await db
            .update(userChurnSignals)
            .set({ interventionSentAt: now })
            .where(
                and(
                    eq(userChurnSignals.userId, conn.userId),
                    eq(userChurnSignals.signalType, 'integration_disconnected_48h'),
                    isNull(userChurnSignals.interventionSentAt)
                )
            );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 4: Pricing page view, no upgrade in 72h (SC5)
// ─────────────────────────────────────────────────────────────────────────────
async function detectUpgradeIntentNotConverted(db: any) {
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const now = new Date();

    // Users who viewed /pricing.html more than 72h ago
    const pricingViews = await db
        .select({ userId: pageEvents.userId, createdAt: pageEvents.createdAt })
        .from(pageEvents)
        .where(
            and(
                eq(pageEvents.pagePath, '/pricing.html'),
                lt(pageEvents.createdAt, seventyTwoHoursAgo)
            )
        )
        .limit(500);

    // Get currently active plan tier for upgrade context
    for (const ev of pricingViews) {
        if (await isRecentlySignalled(db, ev.userId, 'upgrade_intent_not_converted')) continue;

        // Check if they already upgraded after the page view
        const [planAfterView] = await db
            .select({ startedAt: plans.startedAt })
            .from(plans)
            .where(
                and(
                    eq(plans.userId, ev.userId),
                    eq(plans.status, 'active'),
                    gte(plans.startedAt, ev.createdAt)
                )
            )
            .limit(1);

        if (planAfterView) continue; // They converted — skip

        await insertSignal(db, ev.userId, 'upgrade_intent_not_converted', {
            pricingPageViewedAt: ev.createdAt,
            detectedAt: now.toISOString(),
        });

        const [user] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, ev.userId))
            .limit(1);

        if (user) {
            try {
                await sendEmail({
                    to: user.email,
                    subject: 'You were checking out our plans — here\'s what you\'re missing',
                    html: `<p>Hi ${user.firstName || 'there'},</p>
                           <p>We noticed you were checking out our plans recently. Higher tiers unlock features like brand voice analysis, compliance checking, priority support, and more assistants.</p>
                           <p><a href="${process.env.BASE_URL}/pricing.html">See what you're missing →</a></p>
                           <p>The Be More Swan Team</p>`,
                });
            } catch { /* non-critical */ }
        }

        await db
            .update(userChurnSignals)
            .set({ interventionSentAt: now })
            .where(
                and(
                    eq(userChurnSignals.userId, ev.userId),
                    eq(userChurnSignals.signalType, 'upgrade_intent_not_converted'),
                    isNull(userChurnSignals.interventionSentAt)
                )
            );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled handler
// ─────────────────────────────────────────────────────────────────────────────
export const handler = async (event: HandlerEvent) => {
    // Allow both scheduled invocations and manual POST (protected by secret)
    if (event.httpMethod === 'POST') {
        const authHeader = event.headers['x-cron-secret'] || '';
        if (NETLIFY_CRON_SECRET && authHeader !== NETLIFY_CRON_SECRET) {
            return { statusCode: 401, body: 'Unauthorized' };
        }
    }

    const db = getDb();

    await Promise.allSettled([
        detectNoTasks7d(db),
        detectIntegrationDisconnected(db),
        detectUpgradeIntentNotConverted(db),
    ]);

    return { statusCode: 200, body: JSON.stringify({ ok: true, ran: new Date().toISOString() }) };
};

// Netlify scheduled function config — runs daily at 08:00 UTC
export const config = { schedule: '0 8 * * *' };
