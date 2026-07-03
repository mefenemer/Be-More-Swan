// netlify/functions/autonomous-goal-optimizer.ts
// SMART Goals — US3.3 Autonomous Optimization Mode (highest tier). Daily cron: for each
// assistant with autonomousGoalSeeking ON whose org is still on an eligible tier, if any goal
// is off_track (AC3.3.2) the LLM picks the single most impactful brief field from the allowed
// set (AUTONOMOUS_TUNABLE_FIELDS — brand voice / audience / content strategy / posting frequency)
// and rewrites it. The change is applied to onboardingContext (the store the UI + generation use),
// written to the audit log, and surfaced as a notification (AC3.3.3).
//
// Allow-list is deliberately limited to free-text brief fields — hard rules / guardrails are
// never auto-edited. Posting frequency is a free-text cadence directive, not a hard scheduler
// flip, with a realistic range nudged in the prompt. One field per run keeps the change auditable.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, goals, auditLogs, notifications } from '../../db/schema';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { tierAllows, AUTONOMOUS_TUNABLE_FIELDS, funnelDiagnosticFor } from '../../src/config/goal-metrics';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { gatewayGenerate } from '../../src/lib/ai-gateway';

const BATCH = 50;

export const handler: Handler = async () => {
    if (await isGlobalAiDisabled()) return { statusCode: 200, body: JSON.stringify({ skipped: 'ai_disabled' }) };
    const db = getDb();

    const candidates = await db
        .select({
            id: aiAssistants.id, name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole,
            organisationId: aiAssistants.organisationId, userId: aiAssistants.userId, onboardingContext: aiAssistants.onboardingContext,
        })
        .from(aiAssistants)
        .where(eq(aiAssistants.autonomousGoalSeeking, true))
        .limit(BATCH);

    let adjusted = 0;
    const tierAllowedByOrg = new Map<number, boolean>();

    for (const a of candidates) {
        // Eligibility can lapse after a downgrade — re-check the tier each run.
        let allowed = tierAllowedByOrg.get(a.organisationId);
        if (allowed === undefined) {
            allowed = tierAllows('autonomous', await getActiveTierKeyByOrg(db, a.organisationId));
            tierAllowedByOrg.set(a.organisationId, allowed);
        }
        if (!allowed) continue;

        const offTrack = await db
            .select({ id: goals.id, metricKey: goals.metricKey })
            .from(goals)
            .where(and(
                eq(goals.assistantId, a.id),
                eq(goals.organisationId, a.organisationId),
                eq(goals.status, 'off_track'),
                eq(goals.isActive, true),
            ))
            .limit(1);
        if (!offTrack.length) continue;

        // The brief fields the UI + generation read/write live in onboardingContext (NOT
        // configuration.inputs) — see assemble-blueprint.ts / _detailCollect. Read & write there
        // so autonomous changes actually take effect and show on the detail page.
        const ctx = (a.onboardingContext as Record<string, any>) || {};

        // Ask the LLM to pick the single most impactful allowed field and rewrite it.
        const fieldList = Object.entries(AUTONOMOUS_TUNABLE_FIELDS)
            .map(([key, label]) => `- ${key} (${label}): ${ctx[key] ? String(ctx[key]) : '(unset)'}`)
            .join('\n');

        // US-02 — bias the rewrite toward the funnel stage where the off-track metric is leaking.
        const funnel = funnelDiagnosticFor(offTrack[0].metricKey);
        let field = '';
        let newValue = '';
        try {
            const { text } = await gatewayGenerate({
                system: `An AI ${a.role || 'assistant'} is off-track on its growth goal. From the brief fields below, pick the `
                    + `SINGLE field whose improvement would most help recover the goal, and rewrite it. `
                    + (funnel ? `The goal is a ${funnel.stage} metric, so favour changes that pull these levers: ${funnel.focus.join('; ')}. ` : '')
                    + `Respond ONLY with JSON: `
                    + `{"field":"<one of: ${Object.keys(AUTONOMOUS_TUNABLE_FIELDS).join(', ')}>","value":"<rewritten text>"}. `
                    + `If you choose posting_frequency, keep the cadence realistic — between "2 times a week" and "twice a day".`,
                messages: [{ role: 'user', content: `Brief fields:\n${fieldList}` }],
                maxTokens: 300,
            });
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                field = String(parsed.field || '');
                newValue = String(parsed.value || '').trim();
            }
        } catch { continue; }

        // Only accept a field on the allow-list with a real, changed value.
        if (!AUTONOMOUS_TUNABLE_FIELDS[field] || !newValue || newValue === (ctx[field] || '')) continue;

        const previousValue: string = ctx[field] || '';
        const label = AUTONOMOUS_TUNABLE_FIELDS[field];
        const newCtx = { ...ctx, [field]: newValue };
        await db.update(aiAssistants).set({ onboardingContext: newCtx, updatedAt: new Date() }).where(eq(aiAssistants.id, a.id));

        // AC3.3.3 — audit trail + user notification.
        await db.insert(auditLogs).values({
            userId: a.userId,
            actionType: 'AUTONOMOUS_OPTIMIZE',
            resourceType: 'ai_assistants',
            resourceId: String(a.id),
            previousState: { [field]: previousValue },
            newState: { [field]: newValue },
        }).catch(() => {});
        await db.insert(notifications).values({
            userId: a.userId,
            type: 'goal_autonomous_adjustment',
            title: 'Autonomous adjustment made',
            message: `Assistant ${a.name} automatically adjusted its ${label} to improve engagement. View Changes.`,
            isRead: false,
        }).catch(() => {});
        adjusted++;
    }

    return { statusCode: 200, body: JSON.stringify({ candidates: candidates.length, adjusted }) };
};
