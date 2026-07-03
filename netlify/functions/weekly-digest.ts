// netlify/functions/weekly-digest.ts
// US-GAP-6.3.1: Weekly Usage Digest Email
//
// Scheduled every Monday at 08:00 UTC (schedule: "0 8 * * 1")
// Sends a personalised weekly activity digest to active users who:
//   - have at least one provisioned assistant (SC1)
//   - had at least one task_run in the last 7 days (SC3 suppression)
//   - have not opted out via emailPreferences.weekly_digest = false (SC4)
//   - have an 'active' plan (SC5 — exclude 'cancelled' / 'past_due')

import type { Handler } from '@netlify/functions';
import { eq, and, gte, count, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userProfiles, plans, masterPlans, aiAssistants, taskRuns, scheduledPosts } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { isEmailEnabled } from '../../src/utils/notification-prefs';

const BASE_URL = process.env.BASE_URL || '';

async function runWeeklyDigest() {
    const db   = getDb();
    const now  = new Date();
    const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // All active users with active plans and at least one assistant
    const eligibleRows = await db
        .select({
            userId:          users.id,
            email:           users.email,
            firstName:       users.firstName,
            planId:          plans.id,
            masterPlanId:    plans.masterPlanId,
            planStatus:      plans.status,
            monthlyTaskLimit: masterPlans.monthlyTaskLimit,
            emailPrefs:      userProfiles.emailPreferences,
        })
        .from(users)
        .innerJoin(plans, and(eq(plans.userId, users.id), eq(plans.status, 'active')))
        .leftJoin(masterPlans, eq(masterPlans.id, plans.masterPlanId))
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.status, 'active'));

    let sent = 0;
    let skipped = 0;

    for (const row of eligibleRows) {
        // SC4: opt-out check. Honour the new "Assistant Tasks & Summaries" email category
        // (account settings → Notification Preferences) and the legacy weekly_digest key, so
        // a user who opted out under either mechanism stays opted out.
        const prefs = (row.emailPrefs || {}) as Record<string, boolean>;
        if (prefs.weekly_digest === false || !isEmailEnabled(prefs, 'assistant_task')) { skipped++; continue; }

        // SC1: must have at least one provisioned assistant
        const activeAssistants = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name, isActive: aiAssistants.isActive, assistantRole: (aiAssistants as any).assistantRole })
            .from(aiAssistants)
            .where(eq(aiAssistants.userId, row.userId));

        if (activeAssistants.length === 0) { skipped++; continue; }

        // SC3: must have task_runs in last 7 days
        const [taskStats] = await db
            .select({ weekCount: count() })
            .from(taskRuns)
            .where(and(eq(taskRuns.userId, row.userId), gte(taskRuns.createdAt, week)));

        const weeklyTaskCount = taskStats?.weekCount ?? 0;
        if (weeklyTaskCount === 0) { skipped++; continue; }

        // Month-to-date task count (for usage vs limit)
        const [monthStats] = await db
            .select({ monthCount: count() })
            .from(taskRuns)
            .where(and(eq(taskRuns.userId, row.userId), gte(taskRuns.createdAt, monthStart)));
        const monthlyTaskCount = monthStats?.monthCount ?? 0;

        // Posts scheduled/published in last 7 days (for Social Media users, SC2b)
        const [postStats] = await db
            .select({ postCount: count() })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.userId, row.userId),
                gte(scheduledPosts.createdAt, week),
                inArray(scheduledPosts.status, ['scheduled', 'published']),
            ));
        const weeklyPostCount = postStats?.postCount ?? 0;

        // Build assistant status lines
        const assistantLines = activeAssistants
            .map(a => `<li>${a.name} — <strong style="color:${a.isActive ? '#059669' : '#9ca3af'}">${a.isActive ? 'Active' : 'Paused'}</strong></li>`)
            .join('');

        const taskLimitLine = row.monthlyTaskLimit != null
            ? `<p>📊 <strong>This month's usage:</strong> ${monthlyTaskCount} of ${row.monthlyTaskLimit} tasks used</p>`
            : `<p>📊 <strong>This month's tasks:</strong> ${monthlyTaskCount} completed</p>`;

        const postsLine = weeklyPostCount > 0
            ? `<p>📅 <strong>Posts scheduled/published this week:</strong> ${weeklyPostCount}</p>`
            : '';

        const name = row.firstName || 'there';

        await sendEmail({
            to: row.email,
            subject: `Your Be More Swan weekly digest — ${weeklyTaskCount} task${weeklyTaskCount === 1 ? '' : 's'} completed`,
            html: `<p>Hi ${name},</p>
                   <p>Here's what your Be More Swan assistants have been up to this week:</p>
                   <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:16px 0;">
                     <p>✅ <strong>Tasks completed (last 7 days):</strong> ${weeklyTaskCount}</p>
                     ${postsLine}
                     ${taskLimitLine}
                     <p>🤖 <strong>Your assistants:</strong></p>
                     <ul style="margin:4px 0;padding-left:1.2rem;line-height:1.8">${assistantLines}</ul>
                   </div>
                   <p style="margin-top:20px;">
                     <a href="${BASE_URL}/workspace.html" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                       View Full Activity →
                     </a>
                   </p>
                   <p style="margin-top:16px;font-size:0.8rem;color:#9ca3af;">
                     You're receiving this because you have weekly digests enabled.
                     <a href="${BASE_URL}/workspace.html#notifications" style="color:#9ca3af;">Manage preferences</a>
                   </p>
                   <p>The Be More Swan Team</p>`,
        }).then(() => { sent++; }).catch(err => {
            console.warn(`[weekly-digest] Email failed for userId=${row.userId}:`, err);
            skipped++;
        });
    }

    console.log(`[weekly-digest] Done — sent=${sent}, skipped=${skipped}`);
}

export const handler: Handler = async () => {
    try {
        await runWeeklyDigest();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[weekly-digest]', err);
        return { statusCode: 500 };
    }
};
