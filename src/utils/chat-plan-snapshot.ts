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
import { aiVideoPriceText, basicWorkCharged, type TaskCosts, type WorkKind } from '../config/task-weights';
import { getTaskCosts } from './task-costs';
import { changeSummary, longDate, upcomingChange, type ChangeRow } from './task-cost-changes';

type Db = ReturnType<typeof getDb>;

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Everyday work, in the order chat lists it. */
const EVERYDAY_WORK: ReadonlyArray<[WorkKind, string]> = [
    ['social_post', 'post'], ['blog_article', 'article'], ['email_issue', 'email'], ['email_campaign', 'email flow'],
    ['lead_search', 'lead search'], ['outreach_email', 'outreach email'], ['site_audit', 'website check that re-scores'],
    ['site_draft', 'website draft'], ['site_words', 'website copy rewrite'], ['flyer_words', 'flyer words'],
    ['ai_voiceover', 'AI voiceover'], ['background_removal', 'background removal'], ['mentor_research', 'Business Mentor research'],
    ['mentor_strategy', 'drafted plan'], ['mentor_review', 'weekly review'],
];

/** "each post, article or email is 1; each lead search is 2", from today's costs. */
function everydayCosts(costs: TaskCosts): string {
    const byCost = new Map<number, string[]>();
    for (const [kind, words] of EVERYDAY_WORK) {
        const n = costs.weights[kind];
        byCost.set(n, [...(byCost.get(n) ?? []), words]);
    }
    return [...byCost.entries()].map(([n, words]) => {
        const last = words.pop();
        return `each ${words.length ? `${words.join(', ')} or ${last}` : last} is ${n}`;
    }).join('; ');
}

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
    costs: TaskCosts;
    upcoming?: ChangeRow | null;
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
            ? `- What costs a task: ${everydayCosts(f.costs)}; a set of AI images is ${f.costs.weights.ai_image} (up to 4 options), an AI video ${aiVideoPriceText(f.costs)}, AI music ${f.costs.weights.ai_music}; an X post with a link ${f.costs.weights.x_link_post} on top of the post's own task. ${basicWorkCharged() ? `Chatting with you is ${f.costs.weights.chat_messages} task per ${f.costs.chatMessagesPerTask} messages, each editing helper is ${f.costs.weights.editing_helper}, a Brand Designer round using stock, branded cards or flyer pages is ${f.costs.weights.design_round}, and a design's first download is ${f.costs.weights.finished_design} (there is also a fair daily limit on chat and helpers).` : 'Chatting with you costs none (there is a fair daily limit).'} These are today's figures: where anything else you know states a cost, this wins.${f.upcoming ? `\n- A change to these starts on ${longDate(f.upcoming.effectiveDate)}: ${changeSummary(f.upcoming.items)} The workspace owner reviews and accepts it when they open the workspace. You cannot accept it for them.` : ''}`
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
        const [costs, upcoming] = await Promise.all([getTaskCosts(now), upcomingChange(db)]);
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
            costs,
            upcoming,
        });
    } catch (err) {
        console.error('[chat-plan-snapshot] read failed (non-fatal)', err);
        return 'YOUR WORKSPACE’S PLAN AND TASKS: could not be read this turn — if asked, say so and point them to the Billing page; never guess a number.';
    }
}
