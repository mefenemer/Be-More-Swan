// src/utils/chat-plan-snapshot.ts
// The workspace's plan and this month's task balance, as a block for every assistant's chat prompt.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// "How many tasks do I have left?" and "what plan am I on?" got a guess: no chat prompt carried the
// plan, and the only sign of the allowance was the upgrade card once it had already run out. The
// assistants also quote costs ("uses 1 task from their monthly allowance") with no idea whether that
// task exists. The parity audit of 2026-10-22 listed this gap.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Read per turn, every role. The plan is resolved the way the cap check resolves it (task-credit.ts
// resolveTaskLimit: this organisation's active plan, else past_due, with frozen feature overrides),
// and the balance comes from task-balance.ts — the same computation as the workspace's usage bar
// (check-capacity.ts) — so the chat cannot disagree with the page. Read-only: plans are changed on
// the Billing page, never from chat.
//
// ⚠️ Never throws.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { masterPlans, plans } from '../../db/schema';
import { effectiveLimit, type FeatureOverrides } from './plan-features';
import { isUnifiedTaskMetering } from './task-metering-flag';
import { nextResetAt, readTaskUsage, tasksRemaining } from './task-balance';
import { TASK_WEIGHTS, aiVideoPriceText } from '../config/task-weights';

type Db = ReturnType<typeof getDb>;

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Pure: the block from already-read facts. Exported for tests. */
export function formatPlanBlock(f: {
    planName: string | null;
    status: 'active' | 'past_due' | null;
    gracePeriodEndsAt: Date | null;
    monthlyTaskLimit: number | null;
    taskCount: number;
    bonusTasks: number;
    tasksInFlight: number;
    unified: boolean;
    now: Date;
}): string {
    const head = 'YOUR WORKSPACE’S PLAN AND TASKS (read this turn — the same figures as the usage bar and the Billing page; never estimate a number that is not here). Plans are changed on the Billing page, never in this chat:';
    if (!f.status) {
        return `${head}\n- No active plan. No tasks can run until they choose one on the Billing page.`;
    }
    const left = tasksRemaining(f.monthlyTaskLimit, f);
    const lines = [
        `- Plan: ${f.planName ?? 'their current plan'}${f.status === 'past_due'
            ? ` — a payment failed${f.gracePeriodEndsAt ? `; everything keeps running until ${fmtDate(f.gracePeriodEndsAt)}` : ''}. They can update their card on the Billing page.`
            : '.'}`,
        f.monthlyTaskLimit === null
            ? `- Tasks this month: ${f.taskCount} used. This plan has no monthly task limit.`
            : `- Tasks this month: ${f.taskCount} used of ${f.monthlyTaskLimit}${f.bonusTasks ? `, plus ${f.bonusTasks} bonus task${f.bonusTasks === 1 ? '' : 's'} that never expire` : ''}${f.tasksInFlight ? ` (${f.tasksInFlight} held for AI media still being made)` : ''}. ${left} left.`,
        `- The allowance resets on ${fmtDate(nextResetAt(f.now))}. When it runs out, work stops until then — nothing is ever charged extra, and there is no top-up to buy.`,
        f.unified
            ? `- What costs a task: each post, article, email, email flow, lead search, outreach email, website check that re-scores, website draft or website copy rewrite is 1; an AI image is ${TASK_WEIGHTS.ai_image}, an AI video ${aiVideoPriceText()}, AI music ${TASK_WEIGHTS.ai_music}; an X post with a link ${TASK_WEIGHTS.x_link_post}. Chatting with you costs none (there is a fair daily limit).`
            : '- Each chat message, and each piece of work an assistant does, uses 1 task.',
    ];
    return `${head}\n${lines.join('\n')}`;
}

export async function buildPlanSnapshot(db: Db, organisationId: number, now: Date = new Date()): Promise<string> {
    try {
        const [plan] = await db
            .select({
                status: plans.status, gracePeriodEndsAt: plans.gracePeriodEndsAt, featureOverrides: plans.featureOverrides,
                planName: masterPlans.name, monthlyTaskLimit: masterPlans.monthlyTaskLimit,
            })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.organisationId, organisationId), inArray(plans.status, ['active', 'past_due'])))
            // 'active' sorts before 'past_due', so an active plan always wins (task-credit.ts).
            .orderBy(asc(plans.status), asc(plans.startedAt))
            .limit(1);
        const [usage, unified] = plan
            ? await Promise.all([readTaskUsage(db, organisationId), isUnifiedTaskMetering(organisationId)])
            : [{ taskCount: 0, tokenCount: 0, bonusTasks: 0, tasksInFlight: 0 }, false];
        return formatPlanBlock({
            planName: plan?.planName ?? null,
            status: plan ? (plan.status === 'past_due' ? 'past_due' : 'active') : null,
            gracePeriodEndsAt: plan?.gracePeriodEndsAt ? new Date(plan.gracePeriodEndsAt) : null,
            monthlyTaskLimit: plan
                ? effectiveLimit(plan.featureOverrides as FeatureOverrides | null, 'monthlyTaskLimit', plan.monthlyTaskLimit ?? null)
                : null,
            ...usage,
            unified,
            now,
        });
    } catch (err) {
        console.error('[chat-plan-snapshot] read failed (non-fatal)', err);
        return 'YOUR WORKSPACE’S PLAN AND TASKS: could not be read this turn — if asked, say so and point them to the Billing page; never guess a number.';
    }
}
