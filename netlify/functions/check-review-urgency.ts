// netlify/functions/check-review-urgency.ts
// US-SMM-2.4.2: Runs every 15 minutes.
//   1. For posts crossing into <12h remaining with no red-alert sent → send push + email
//   2. For posts past their cut-off time and still not approved → mark 'missed', notify user
//
// Schedule: "*/15 * * * *"

import { Handler } from '@netlify/functions';
import { and, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { aiAssistants, notifications, scheduledPosts, users } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db  = getDb();
    const now = new Date();

    // ── 1. Red-zone alert: posts entering <12h window, no alert sent yet ──────
    const redThreshold = new Date(now.getTime() + 12 * 60 * 60 * 1000);

    const redZonePosts = await db
        .select({
            post:      scheduledPosts,
            userId:    aiAssistants.userId,
            assistantName: aiAssistants.name,
            notifPref: aiAssistants.reviewNotifPreference,
        })
        .from(scheduledPosts)
        .innerJoin(aiAssistants, eq(scheduledPosts.assistantId, aiAssistants.id))
        .where(and(
            sql`${scheduledPosts.status} IN ('draft','in_review')`,
            lte(scheduledPosts.publishDate, redThreshold),
            gt(scheduledPosts.publishDate, now),
            isNull(scheduledPosts.redAlertSentAt),
        ));

    let redAlertsSent = 0;
    for (const { post, userId, assistantName, notifPref } of redZonePosts) {
        // Skip if user prefers daily digest
        if (notifPref === 'daily_digest') continue;

        const publishDt    = new Date(post.publishDate);
        const hoursLeft    = Math.round((publishDt.getTime() - now.getTime()) / (1000 * 60 * 60) * 10) / 10;
        const publishLabel = publishDt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

        // Mark alert sent first (fire-and-forget to avoid duplicate on retry)
        await db.update(scheduledPosts)
            .set(withUpdatedAt({ redAlertSentAt: now }))
            .where(eq(scheduledPosts.id, post.id));

        // In-app notification
        await db.insert(notifications).values({
            userId,
            type: 'review_red_urgency',
            title: 'Action needed — post due soon',
            message: `${post.platform} post scheduled for ${publishLabel} needs your approval in the next ${hoursLeft} hours or it will be missed.`,
        }).catch(() => {});

        // Email (only for 'immediate' pref — red_urgency_only also qualifies)
        const [user] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        if (user) {
            sendEmail({
                to: user.email,
                subject: `Action needed: ${post.platform} post due in ${hoursLeft}h`,
                html: `<p>Hi ${user.firstName || 'there'},</p>
                       <p>Your <strong>${post.platform}</strong> post scheduled for <strong>${publishLabel}</strong> via <em>${assistantName}</em> needs your approval.</p>
                       <p>You have approximately <strong>${hoursLeft} hours</strong> before the publish window closes.</p>
                       <p>Posts not approved before the cut-off are never auto-published.</p>
                       <p><a href="${process.env.BASE_URL || ''}/workspace.html#review-queue">Open Review Queue →</a></p>
                       <p>The Be More Swan Team</p>`,
            }).catch(() => {});
        }

        redAlertsSent++;
    }

    // ── 2. Missed post detection: cut-off passed, still not approved ─────────
    // cut-off = publishDate - reviewCutoffHours
    // We query: publishDate <= now + reviewCutoffHours AND status NOT published/approved
    const missedPosts = await db
        .select({
            post:      scheduledPosts,
            userId:    aiAssistants.userId,
            assistantName: aiAssistants.name,
            cutoffHours: aiAssistants.reviewCutoffHours,
        })
        .from(scheduledPosts)
        .innerJoin(aiAssistants, eq(scheduledPosts.assistantId, aiAssistants.id))
        .where(and(
            sql`${scheduledPosts.status} IN ('draft','in_review')`,
            // publish_date - (review_cutoff_hours * interval '1 hour') <= now
            sql`${scheduledPosts.publishDate} - (${aiAssistants.reviewCutoffHours} * interval '1 hour') <= ${now}`,
        ));

    let missedCount = 0;
    for (const { post, userId, assistantName, cutoffHours } of missedPosts) {
        const publishDt    = new Date(post.publishDate);
        const publishLabel = publishDt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

        await db.update(scheduledPosts)
            .set({ status: 'missed', missedAt: now, updatedAt: now })
            .where(and(
                eq(scheduledPosts.id, post.id),
                sql`${scheduledPosts.status} IN ('draft','in_review')`,
            ));

        await db.insert(notifications).values({
            userId,
            type: 'post_missed',
            title: 'Post not published — approval window passed',
            message: `${post.platform} post scheduled for ${publishLabel} was not approved in time and has not been published. You can reschedule it from your Missed Posts tab.`,
        }).catch(() => {});

        const [user] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        if (user) {
            sendEmail({
                to: user.email,
                subject: `Missed post: ${post.platform} scheduled for ${publishLabel}`,
                html: `<p>Hi ${user.firstName || 'there'},</p>
                       <p>Your <strong>${post.platform}</strong> post scheduled for <strong>${publishLabel}</strong> via <em>${assistantName}</em> was not approved before the ${cutoffHours}-hour cut-off window and has <strong>not been published</strong>.</p>
                       <p>You can reschedule, publish immediately (still requires approval), or archive it from your <a href="${process.env.BASE_URL || ''}/workspace.html#review-queue-missed">Missed Posts tab</a>.</p>
                       <p>The Be More Swan Team</p>`,
            }).catch(() => {});
        }

        missedCount++;
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, redAlertsSent, missedCount }),
    };
};
