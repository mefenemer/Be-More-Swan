// src/utils/gamification.ts
// US3.1 — Milestone engine. Evaluates a workspace's all-time progress against the
// admin-configured thresholds and grants rewards exactly once:
//   - 100 leads  → +1 bonus referral token (drops into the Reward Vault)   (AC3.1.3)
//   - 50 hours   → beta_access = true (Beta Program + pre-release catalog)  (AC3.1.2)
// Each grant is logged in reward_audits (AC4.2.1); the unique (org, trigger_event)
// constraint is the dedup, so it fires once and never double-spends. Honours the
// global emergency-stop flag (AC4.2.3) — when paused, Time Saved still shows but no
// grants happen.

import { and, count, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { leads, scheduledPosts, taskRuns, organisations, rewardAudits, notifications } from '../../db/schema';
import { getTimeMultipliers, getMilestones, areRewardsPaused } from './platform-config';

type Db = ReturnType<typeof getDb>;

/** Evaluate + grant milestone rewards for an org. Safe to call on every dashboard load. */
export async function evaluateMilestones(db: Db, orgId: number, notifyUserId: number): Promise<void> {
    if (await areRewardsPaused()) return; // AC4.2.3

    const [mult, milestones] = await Promise.all([getTimeMultipliers(), getMilestones()]);

    const [leadsRow, postsRow, tasksRow] = await Promise.all([
        db.select({ n: count() }).from(leads).where(eq(leads.organisationId, orgId)),
        db.select({ n: count() }).from(scheduledPosts).where(eq(scheduledPosts.organisationId, orgId)),
        db.select({ n: count() }).from(taskRuns).where(and(eq(taskRuns.organisationId, orgId), eq(taskRuns.status, 'completed'))),
    ]);

    const leadsCount = Number(leadsRow[0]?.n ?? 0);
    const totalMinutes =
        leadsCount * mult.leads_generated +
        Number(postsRow[0]?.n ?? 0) * mult.content_drafted +
        Number(tasksRow[0]?.n ?? 0) * mult.tasks_completed;
    const hours = totalMinutes / 60;

    // AC3.1.3 — 100 leads → bonus referral token
    if (leadsCount >= milestones.leads_for_token) {
        await grant(db, orgId, notifyUserId, 'referral_token', `milestone:${milestones.leads_for_token}_leads`,
            (tx) => tx.update(organisations)
                .set({ bonusReferralTokens: sql`${organisations.bonusReferralTokens} + 1` })
                .where(eq(organisations.id, orgId)),
            `🎉 Milestone reached — ${milestones.leads_for_token} leads generated! A bonus referral token has been added to your Reward Vault.`);
    }

    // AC3.1.2 — 50 hours → Beta access
    if (hours >= milestones.hours_for_beta) {
        await grant(db, orgId, notifyUserId, 'beta_access', `milestone:${milestones.hours_for_beta}_hours`,
            (tx) => tx.update(organisations).set({ betaAccess: true }).where(eq(organisations.id, orgId)),
            `🚀 Milestone reached — ${milestones.hours_for_beta} hours saved! You've unlocked the Beta Program and early access to pre-release assistants.`);
    }
}

/**
 * Grant a reward once. The reward_audits insert (unique on org+trigger) is the gate:
 * if it conflicts, the milestone was already granted → no-op. The whole thing runs in a
 * transaction so a failed apply rolls back the audit row (retried next time).
 */
async function grant(
    db: Db,
    orgId: number,
    notifyUserId: number,
    rewardType: 'referral_token' | 'beta_access',
    triggerEvent: string,
    apply: (tx: Db) => Promise<unknown>,
    message: string,
): Promise<void> {
    try {
        await db.transaction(async (tx) => {
            const inserted = await tx.insert(rewardAudits)
                .values({ organisationId: orgId, rewardType, triggerEvent })
                .onConflictDoNothing({ target: [rewardAudits.organisationId, rewardAudits.triggerEvent] })
                .returning({ id: rewardAudits.id });
            if (inserted.length === 0) return; // already granted — skip

            await apply(tx as unknown as Db);
            await tx.insert(notifications).values({
                userId: notifyUserId,
                type: 'milestone',
                title: 'Milestone Unlocked',
                message,
                isRead: false,
            });
        });
    } catch (e) {
        console.warn(`[gamification] grant ${triggerEvent} failed (non-blocking):`, e);
    }
}
