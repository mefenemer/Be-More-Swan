// netlify/functions/win-back-emails.ts
// US-GAP-4.2.1: Win-Back Email Sequence Post-Cancellation
//
// Scheduled daily at 10:00 UTC (schedule: "0 10 * * *")
// Sends two win-back emails:
//   Day 7  (SC1/SC2): soft re-subscribe nudge
//   Day 30 (SC3):     direct re-subscribe offer with discount hint
//
// SC4: Suppression — skips users who have re-subscribed (active plan)
// SC5: Unsubscribe — skips users in win_back_opt_outs

import type { Handler } from '@netlify/functions';
import { eq, and, gte, lte, isNotNull, count } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, winBackOptOuts, processedWebhookEvents, taskRuns } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const BASE_URL = process.env.BASE_URL || '';

// Unsubscribe token is a simple base64-encoded userId — for a production system
// you'd use a signed JWT. This keeps it dependency-light.
function makeUnsubToken(userId: number): string {
    return Buffer.from(`wb-unsub:${userId}`).toString('base64url');
}

async function runWinBackEmails() {
    const db  = getDb();
    const now = new Date();

    // Day 7 window: cancelled between 6.5 and 7.5 days ago
    const day7Start = new Date(now.getTime() - 7.5 * 24 * 60 * 60 * 1000);
    const day7End   = new Date(now.getTime() - 6.5 * 24 * 60 * 60 * 1000);

    // Day 30 window: cancelled between 29.5 and 30.5 days ago
    const day30Start = new Date(now.getTime() - 30.5 * 24 * 60 * 60 * 1000);
    const day30End   = new Date(now.getTime() - 29.5 * 24 * 60 * 60 * 1000);

    // Fetch opted-out user IDs for suppression (SC5)
    const optOuts = await db.select({ userId: winBackOptOuts.userId }).from(winBackOptOuts);
    const optOutSet = new Set(optOuts.map(o => o.userId));

    // Fetch all cancelled plans in either window
    const cancelledPlans = await db
        .select({
            planId: plans.id,
            userId: plans.userId,
            cancelledAt: plans.cancelledAt,
        })
        .from(plans)
        .where(and(
            eq(plans.status, 'cancelled'),
            isNotNull(plans.cancelledAt),
            gte(plans.cancelledAt, day7Start),
            lte(plans.cancelledAt, day30End),
        ));

    for (const plan of cancelledPlans) {
        const userId = plan.userId!;

        // SC4: Suppression — user has re-subscribed
        const [activePlan] = await db
            .select({ id: plans.id })
            .from(plans)
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .limit(1);
        if (activePlan) continue;

        // SC5: Unsubscribe opt-out
        if (optOutSet.has(userId)) continue;

        // Query filters isNotNull(cancelledAt); timestamp columns come back as Date.
        const cancelledAt = plan.cancelledAt as Date;

        const isDay7  = cancelledAt >= day7Start  && cancelledAt <= day7End;
        const isDay30 = cancelledAt >= day30Start && cancelledAt <= day30End;

        if (!isDay7 && !isDay30) continue;

        const emailType  = isDay30 ? 'day30' : 'day7';
        const dedupeKey  = `winback:${plan.planId}:${emailType}`;

        // Idempotency
        const [alreadySent] = await db
            .select({ id: processedWebhookEvents.id })
            .from(processedWebhookEvents)
            .where(eq(processedWebhookEvents.stripeEventId, dedupeKey))
            .limit(1);
        if (alreadySent) continue;

        await db.insert(processedWebhookEvents)
            .values({ stripeEventId: dedupeKey, eventType: `winback_${emailType}_sent` })
            .onConflictDoNothing();

        const [userRecord] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        if (!userRecord) continue;

        const name        = userRecord.firstName || 'there';
        const unsubToken  = makeUnsubToken(userId);
        const unsubUrl    = `${BASE_URL}/.netlify/functions/win-back-unsubscribe?token=${unsubToken}`;
        const pricingUrl  = `${BASE_URL}/pricing.html`;

        if (isDay7) {
            // SC1/SC2: Day 7 win-back — soft nudge with personalised task count
            const thirtyDaysBefore = new Date(cancelledAt.getTime() - 30 * 24 * 60 * 60 * 1000);
            const [{ value: taskCount }] = await db
                .select({ value: count() })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.userId, userId),
                    gte(taskRuns.createdAt, thirtyDaysBefore),
                    lte(taskRuns.createdAt, cancelledAt),
                ));

            const taskLine = taskCount > 0
                ? `<p>In your last month with Be More Swan, your assistants completed <strong>${taskCount} task${taskCount === 1 ? '' : 's'}</strong> for you.</p>`
                : '';

            await sendEmail({
                to: userRecord.email,
                subject: `We miss you — here's what your assistants have been up to`,
                html: `<p>Hi ${name},</p>
                       <p>It's been a week since you left Be More Swan, and we've been thinking about you.</p>
                       ${taskLine}<p>Your AI assistants haven't stopped — they've been patiently waiting, ready to jump straight back in to scheduling, content creation, and growing your business the moment you return.</p>
                       <p>Coming back is easy. Your entire setup — assistants, brand voice, integrations — is preserved and ready.</p>
                       <p style="margin-top:24px;">
                         <a href="${pricingUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                           Pick up where you left off →
                         </a>
                       </p>
                       <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                         <a href="${unsubUrl}" style="color:#9ca3af;">Unsubscribe from re-subscription emails</a>
                       </p>
                       <p>The Be More Swan Team</p>`,
            }).catch(err => console.warn('[win-back-emails] Day 7 email failed:', err));

        } else {
            // SC3: Day 30 win-back — direct offer
            await sendEmail({
                to: userRecord.email,
                subject: `One last thing — come back to Be More Swan (special offer inside)`,
                html: `<p>Hi ${name},</p>
                       <p>It's been 30 days since you cancelled, and we'd love to have you back.</p>
                       <p>We've been listening to feedback and have made improvements since you left — new integrations, faster assistants, and more control over your content.</p>
                       <p>🎁 <strong>As a returning member, use code <code>COMEBACK30</code> for 30% off your first month back.</strong></p>
                       <p>Your assistants and data are still waiting for you.</p>
                       <p style="margin-top:24px;">
                         <a href="${pricingUrl}?promo=COMEBACK30" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                           Re-subscribe now →
                         </a>
                       </p>
                       <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                         <a href="${unsubUrl}" style="color:#9ca3af;">Unsubscribe from re-subscription emails</a>
                       </p>
                       <p>The Be More Swan Team</p>`,
            }).catch(err => console.warn('[win-back-emails] Day 30 email failed:', err));
        }
    }
}

export const handler: Handler = async () => {
    try {
        await runWinBackEmails();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[win-back-emails]', err);
        return { statusCode: 500 };
    }
};
