// netlify/functions/goal-ai.ts
// SMART Goals — Feature 3 (premium AI). Three actions, all premium-tier gated (AC3.1.1):
//   action=recommend  { goalId }                      → AC3.1.2/3.1.3: 1–3 actionable recommendations.
//   action=strategy   { goalId }                      → US-03: plain-text diagnosis (AC3.2) + a
//                                                        field-by-field Current→Suggested strategy
//                                                        rewrite the UI diffs (AC3.3) and applies in
//                                                        one click (AC3.4).
//   action=rewrite    { assistantId, field, text }    → AC3.2.2: goal-aware rewrite of one brief field.
//   action=rationale  { assistantId, title?, objective?,
//                       metricKey?, targetValue?, targetDate? }
//                                                     → drafts the goal builder's "Why does this
//                                                        matter?" from the half-built goal. No
//                                                        goalId: it runs BEFORE the goal is saved.
// The LLM only ever sees a hidden prompt assembled here (goal + trajectory + current brief).

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { goals, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { funnelDiagnosticFor, getGoalMetric, strategyChanges, tierAllows, TUNABLE_BRIEF_FIELDS, WAND_REWRITABLE_FIELDS, type GoalAiFeature } from '../../src/config/goal-metrics';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { withLambda } from '@netlify/aws-lambda-compat';
import { parseModelJson, parseModelJsonArray } from '../../src/utils/model-json';

const json = (statusCode: number, payload: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

const FIELD_LABELS = WAND_REWRITABLE_FIELDS;

function goalSummary(goal: any): string {
    const metric = getGoalMetric(goal.metricKey);
    const target = Number(goal.targetValue);
    const latest = goal.latestValue != null ? Number(goal.latestValue) : null;
    const due = new Date(goal.targetDate).toISOString().slice(0, 10);
    return `Goal: reach ${target.toLocaleString()} ${metric?.unit ?? ''} of "${metric?.label ?? goal.metricKey}" by ${due}. `
        + `Current value: ${latest != null ? latest.toLocaleString() : 'unknown'}. Status: ${goal.status}.`;
}

async function gate(db: any, orgId: number, feature: GoalAiFeature): Promise<{ error: any } | null> {
    if (await isGlobalAiDisabled()) return { error: json(503, { error: 'AI features are temporarily unavailable.' }) };
    const tierKey = await getActiveTierKeyByOrg(db, orgId);
    if (!tierAllows(feature, tierKey)) {
        return { error: json(402, { error: 'This AI feature requires a higher plan.', code: 'UPGRADE_REQUIRED' }) };
    }
    return null;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    // ── action=recommend — 1–3 fixes for a goal that's off pace ──────────────
    if (body.action === 'recommend') {
        const blocked = await gate(db, orgId, 'recommendations');
        if (blocked) return blocked.error;

        const goalId = Number(body.goalId);
        if (!goalId) return json(400, { error: 'goalId is required.' });

        const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
        if (!goal || goal.organisationId !== orgId) return json(404, { error: 'Goal not found.' });

        const [assistant] = await db
            .select({ name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, goal.assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);

        // Brief fields live in onboardingContext (the store the UI + generation use).
        const ctx = (assistant?.onboardingContext as Record<string, any>) ?? {};
        const brief = [
            `Role: ${assistant?.role ?? 'assistant'}`,
            ctx.tone_of_voice ? `Brand voice: ${ctx.tone_of_voice}` : '',
            ctx.target_audience ? `Audience: ${ctx.target_audience}` : '',
            ctx.content_pillars ? `Content strategy: ${ctx.content_pillars}` : '',
            ctx.posting_frequency ? `Posting frequency: ${ctx.posting_frequency}` : '',
        ].filter(Boolean).join('\n');

        // US-02 AC2.2–AC2.4 — steer the diagnosis by the metric's funnel stage so the tactical
        // recommendations match WHERE the funnel is leaking (awareness vs interaction vs action).
        const funnel = funnelDiagnosticFor(goal.metricKey);
        const system = 'You are a growth strategist for an AI marketing assistant. A measurable goal is OFF TRACK. '
            + (funnel
                ? `This is a ${funnel.stage} metric, so the funnel is leaking at that stage. Diagnose the likely cause and `
                  + `draw your fixes from these levers for this stage: ${funnel.focus.join('; ')}. `
                : 'Diagnose the likely cause from the goal trajectory and brief. ')
            + 'Return 1 to 3 SPECIFIC, actionable changes to the assistant\'s brief that would get the metric back on '
            + 'track. Each recommendation is one sentence, concrete, and references what to change and why. '
            + 'Respond ONLY with a JSON array of strings.';
        const userMsg = `${goalSummary(goal)}\n\nCurrent brief:\n${brief || '(no brief details set)'}`;

        let recommendations: string[] = [];
        try {
            const { text } = await gatewayGenerate({ system, messages: [{ role: 'user', content: userMsg }], maxTokens: 500 });
            recommendations = parseModelJsonArray<string>(text) ?? [];
        } catch { /* fall through to graceful error below */ }

        recommendations = (recommendations || []).filter(r => typeof r === 'string' && r.trim()).slice(0, 3);
        if (!recommendations.length) return json(502, { error: 'Could not generate recommendations. Please try again.' });
        return json(200, { recommendations, funnelStage: funnel?.stage ?? null });
    }

    // ── action=strategy — US-03 one-click fix: plain-text diagnosis (AC3.2) + a
    //    Current→Suggested rewrite of every strategy field (AC3.3) the UI applies at once (AC3.4) ──
    if (body.action === 'strategy') {
        const blocked = await gate(db, orgId, 'recommendations');
        if (blocked) return blocked.error;

        const goalId = Number(body.goalId);
        if (!goalId) return json(400, { error: 'goalId is required.' });

        const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
        if (!goal || goal.organisationId !== orgId) return json(404, { error: 'Goal not found.' });

        const [assistant] = await db
            .select({ id: aiAssistants.id, role: aiAssistants.aiAssistantJobRole, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, goal.assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return json(404, { error: 'Assistant not found.' });

        const actx = (assistant.onboardingContext as Record<string, any>) ?? {};
        // The strategy set the diff/apply works over (Brand Voice, Audience, Content Strategy).
        const fieldKeys = Object.keys(TUNABLE_BRIEF_FIELDS);
        const current: Record<string, string> = {};
        for (const k of fieldKeys) current[k] = String(actx[k] ?? '').trim();

        const funnel = funnelDiagnosticFor(goal.metricKey);
        const system = 'You are a growth strategist for an AI marketing assistant. A measurable goal is OFF TRACK. '
            + (funnel
                ? `This is a ${funnel.stage} metric, so the funnel is leaking at that stage. `
                  + `Draw your fixes from these levers for this stage: ${funnel.focus.join('; ')}. `
                : 'Diagnose the likely cause from the goal and current strategy. ')
            + 'First write a short plain-English diagnosis (2–3 sentences, no jargon) of why this goal is most '
            + 'likely failing. Then rewrite the strategy fields so they would get the metric back on track — only '
            + 'change a field when a change genuinely helps, otherwise return its current text unchanged. '
            + 'Respond ONLY with JSON of the form '
            + `{"diagnosis": string, "fields": {${fieldKeys.map(k => `"${k}": string`).join(', ')}}}.`;
        const currentBlock = fieldKeys
            .map(k => `${TUNABLE_BRIEF_FIELDS[k]}:\n${current[k] || '(empty)'}`)
            .join('\n\n');
        const userMsg = `${goalSummary(goal)}\n\nRole: ${assistant.role ?? 'assistant'}\n\nCurrent strategy:\n${currentBlock}`;

        let parsed: any = null;
        try {
            const { text } = await gatewayGenerate({ system, messages: [{ role: 'user', content: userMsg }], maxTokens: 700 });
            parsed = parseModelJson(text);
        } catch { /* fall through to graceful error below */ }

        const diagnosis = typeof parsed?.diagnosis === 'string' ? parsed.diagnosis.trim() : '';
        const suggested = (parsed?.fields && typeof parsed.fields === 'object') ? parsed.fields : null;
        // AC3.3 — only surface fields that actually changed; an unchanged field has nothing to diff.
        // strategyChanges is the shared SoT helper, so this matches what the tests lock.
        const changes = strategyChanges(current, suggested);

        if (!diagnosis && !changes.length) return json(502, { error: 'Could not generate a strategy fix. Please try again.' });
        return json(200, { diagnosis, funnelStage: funnel?.stage ?? null, changes });
    }

    // ── action=rewrite — goal-aware rewrite of one brief field (magic wand) ───
    if (body.action === 'rewrite') {
        const blocked = await gate(db, orgId, 'magicWand');
        if (blocked) return blocked.error;

        const assistantId = Number(body.assistantId);
        const field = String(body.field || '');
        const currentText = String(body.text || '');
        if (!assistantId || !FIELD_LABELS[field]) return json(400, { error: 'assistantId and a valid field are required.' });

        const [assistant] = await db
            .select({ id: aiAssistants.id, role: aiAssistants.aiAssistantJobRole })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return json(404, { error: 'Assistant not found.' });

        const activeGoals = await db
            .select().from(goals)
            .where(and(eq(goals.assistantId, assistantId), eq(goals.organisationId, orgId), eq(goals.isActive, true)));
        const goalText = activeGoals.length ? activeGoals.map(goalSummary).join('\n') : 'No active goals set.';

        const system = `You optimise one field of an AI assistant's brief to better achieve the assistant's goals. `
            + `Rewrite the "${FIELD_LABELS[field]}" field so it is sharper and more likely to hit the goals below. `
            + `Keep it concise and practical. Respond ONLY with the rewritten field text — no preamble, no quotes.`;
        const userMsg = `Assistant role: ${assistant.role ?? 'assistant'}\n\nGoals:\n${goalText}\n\n`
            + `Current "${FIELD_LABELS[field]}":\n${currentText || '(empty)'}`;

        try {
            const { text } = await gatewayGenerate({ system, messages: [{ role: 'user', content: userMsg }], maxTokens: 400 });
            const suggestion = text.trim();
            if (!suggestion) return json(502, { error: 'Could not generate a suggestion. Please try again.' });
            return json(200, { suggestion, field });
        } catch {
            return json(502, { error: 'Could not generate a suggestion. Please try again.' });
        }
    }

    // ── action=rationale — draft the goal builder's "Why does this matter?" ──
    // The one field on the SMART form that steers generation (assemble-blueprint reads
    // goals.rationale), and the one users leave blank because it asks for prose rather than a
    // number. This drafts it FROM the numbers they have already typed, so the button can be
    // pressed halfway through building a goal — there is no goalId yet, and asking for one would
    // put the suggestion after the save, which is after the moment it is useful.
    if (body.action === 'rationale') {
        const blocked = await gate(db, orgId, 'magicWand');
        if (blocked) return blocked.error;

        const assistantId = Number(body.assistantId);
        if (!assistantId) return json(400, { error: 'assistantId is required.' });

        const [assistant] = await db
            .select({ name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return json(404, { error: 'Assistant not found.' });

        const actx = (assistant.onboardingContext as Record<string, any>) ?? {};
        const metric = getGoalMetric(String(body.metricKey || ''));
        const target = Number(body.targetValue);
        const date = String(body.targetDate || '').slice(0, 10);

        // Everything the user has filled in so far. A half-built goal is normal here, so each line
        // is dropped when empty rather than sent as "undefined" for the model to reason about.
        const draft = [
            body.title ? `Goal name: ${String(body.title).slice(0, 200)}` : '',
            body.objective ? `Objective: ${String(body.objective)}` : '',
            metric ? `Target metric: ${metric.label}` : '',
            Number.isFinite(target) && target > 0
                ? `Target value: ${target.toLocaleString()} ${metric?.unit ?? ''}`.trim() : '',
            /^\d{4}-\d{2}-\d{2}$/.test(date) ? `Target date: ${date}` : '',
        ].filter(Boolean).join('\n');

        const business = [
            `Role: ${assistant.role ?? 'assistant'}`,
            actx.target_audience ? `Audience: ${actx.target_audience}` : '',
            actx.content_pillars ? `Content strategy: ${actx.content_pillars}` : '',
            actx.problem_statement ? `Their bottleneck: ${actx.problem_statement}` : '',
            actx.service_offerings ? `Products & services: ${actx.service_offerings}` : '',
        ].filter(Boolean).join('\n');

        // Written in the USER'S voice, because it lands in a textarea they own and will edit —
        // a suggestion phrased as advice ("you should focus on…") has to be rewritten before it
        // can be saved, which is most of the work the button was meant to remove.
        const system = 'You write the business rationale behind a marketing goal, for the owner of the '
            + 'business to use as their own. Explain in 2 to 4 sentences WHY this goal matters commercially '
            + 'and what would change for the business if it were hit — the context an AI assistant needs to '
            + 'choose topics, formats and calls to action. Write in the FIRST PERSON PLURAL ("we"), plainly '
            + 'and concretely, with no jargon and no preamble. Never restate the target number or the '
            + 'deadline; those are already on the form. Respond ONLY with the rationale text.';
        const userMsg = `${business || 'Role: assistant'}\n\nThe goal being set:\n${draft || '(nothing filled in yet)'}`;

        try {
            const { text } = await gatewayGenerate({ system, messages: [{ role: 'user', content: userMsg }], maxTokens: 400 });
            // maxlength on the textarea is 600; trim here so the field never silently truncates
            // a suggestion the user was shown in full.
            const suggestion = text.trim().slice(0, 600);
            if (!suggestion) return json(502, { error: 'Could not generate a suggestion. Please try again.' });
            return json(200, { suggestion, assistantName: assistant.name ?? null });
        } catch {
            return json(502, { error: 'Could not generate a suggestion. Please try again.' });
        }
    }

    return json(400, { error: 'Unknown action.' });
});
