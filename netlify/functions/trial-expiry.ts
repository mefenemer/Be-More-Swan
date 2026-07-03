// netlify/functions/trial-expiry.ts
// US-GAP-8.1.1: Free Trial Lifecycle Management
//
// Scheduled daily at 07:00 UTC (schedule: "0 7 * * *")
// Handles three scenarios:
//   SC4: Trial has 7 days remaining → send warning email + in-app notification
//   SC5: Trial has 1 day remaining  → send final warning email
//   SC6: Trial expiresAt is in the past → expire plan, pause assistants, fire gate

import type { Handler } from '@netlify/functions';
import { eq, and, lt, lte, gte, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, aiAssistants, notifications, processedWebhookEvents } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const BASE_URL = process.env.BASE_URL || '';

async function runTrialExpiry() {
    const db  = getDb();
    const now = new Date();

    // Day boundaries
    const in7d  = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
    const in8d  = new Date(now.getTime() + 8  * 24 * 60 * 60 * 1000);
    const in1d  = new Date(now.getTime() + 1  * 24 * 60 * 60 * 1000);
    const in2d  = new Date(now.getTime() + 2  * 24 * 60 * 60 * 1000);

    // All active trial plans
    const trialPlans = await db
        .select({
            planId:   plans.id,
            userId:   plans.userId,
            expiresAt: plans.expiresAt,
        })
        .from(plans)
        .where(and(
            eq(plans.planType, 'trial'),
            eq(plans.status, 'active'),
            isNotNull(plans.expiresAt),
        ));

    for (const plan of trialPlans) {
        // Query filters isNotNull(expiresAt); coerce to Date (timestamps come back as Date).
        const expiry = new Date(plan.expiresAt!);

        const userId = plan.userId!;

        // ── SC6: Trial expired ────────────────────────────────────────────────
        if (expiry <= now) {
            // Set plan to 'expired' and pause all assistants
            await db.update(plans)
                .set({ status: 'expired', updatedAt: now })
                .where(eq(plans.id, plan.planId));

            await db.update(aiAssistants)
                .set({ isActive: false, provisioningStatus: 'paused_payment', updatedAt: now })
                .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));

            await db.insert(notifications).values({
                userId,
                type: 'trial_expired',
                title: 'Your free trial has ended',
                message: 'Your 14-day free trial has expired. Choose a plan to continue using your assistants.',
                isRead: false,
            }).catch(() => {});

            continue;
        }

        // ── SC4: 7-day warning ────────────────────────────────────────────────
        const is7dayWarning = expiry >= in7d && expiry < in8d;
        if (is7dayWarning) {
            const dedupeKey = `trial-warning:7d:${plan.planId}`;
            const [sent] = await db
                .select({ id: processedWebhookEvents.id })
                .from(processedWebhookEvents)
                .where(eq(processedWebhookEvents.stripeEventId, dedupeKey))
                .limit(1);
            if (!sent) {
                await db.insert(processedWebhookEvents)
                    .values({ stripeEventId: dedupeKey, eventType: 'trial_7day_warning' })
                    .onConflictDoNothing();

                await db.insert(notifications).values({
                    userId,
                    type: 'trial_expiring_soon',
                    title: 'Your trial ends in 7 days',
                    message: 'Upgrade now to keep your assistants running without interruption.',
                    isRead: false,
                }).catch(() => {});

                const [user] = await db.select({ email: users.email, firstName: users.firstName })
                    .from(users).where(eq(users.id, userId)).limit(1);
                if (user) {
                    sendEmail({
                        to: user.email,
                        subject: 'Your trial ends in 7 days',
                        html: `<p>Hi ${user.firstName || 'there'},</p>
                               <p>Your Be More Swan free trial ends in <strong>7 days</strong>. After that, your assistants will be paused until you choose a plan.</p>
                               <p>Upgrade now to keep everything running smoothly — your setup, brand voice, and integrations all carry over.</p>
                               <p style="margin-top:20px;">
                                 <a href="${BASE_URL}/pricing.html" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                                   Choose a Plan →
                                 </a>
                               </p>
                               <p>The Be More Swan Team</p>`,
                    }).catch(() => {});
                }
            }
        }

        // ── SC5: 1-day warning ────────────────────────────────────────────────
        const is1dayWarning = expiry >= in1d && expiry < in2d;
        if (is1dayWarning) {
            const dedupeKey = `trial-warning:1d:${plan.planId}`;
            const [sent] = await db
                .select({ id: processedWebhookEvents.id })
                .from(processedWebhookEvents)
                .where(eq(processedWebhookEvents.stripeEventId, dedupeKey))
                .limit(1);
            if (!sent) {
                await db.insert(processedWebhookEvents)
                    .values({ stripeEventId: dedupeKey, eventType: 'trial_1day_warning' })
                    .onConflictDoNothing();

                const [user] = await db.select({ email: users.email, firstName: users.firstName })
                    .from(users).where(eq(users.id, userId)).limit(1);
                if (user) {
                    sendEmail({
                        to: user.email,
                        subject: `Your trial expires tomorrow — don't lose your assistant`,
                        html: `<p>Hi ${user.firstName || 'there'},</p>
                               <p>⚠️ Your Be More Swan free trial expires <strong>tomorrow</strong>.</p>
                               <p>After expiry, your assistants will be automatically paused. To keep them running, choose a plan today — it takes less than 2 minutes.</p>
                               <p style="margin-top:20px;">
                                 <a href="${BASE_URL}/pricing.html" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                                   Upgrade Before It's Too Late →
                                 </a>
                               </p>
                               <p>The Be More Swan Team</p>`,
                    }).catch(() => {});
                }
            }
        }
    }
}

export const handler: Handler = async () => {
    try {
        await runTrialExpiry();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[trial-expiry]', err);
        return { statusCode: 500 };
    }
};
