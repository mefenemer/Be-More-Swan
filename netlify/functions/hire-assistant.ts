// hire-assistant.ts — instant hire for schema-driven Digital Assistants.
// POST { roleKey: string } → { assistantId, name, roleKey, alreadyHired? }
//
// Creates the org's aiAssistants instance for a catalogue role WITHOUT the Social Media
// Manager blueprint flow (onboarding.ts / create-checkout-intent.ts): schema-driven roles
// (see src/config/assistant-onboarding-schemas.js) capture their configuration AFTER hire
// via AssistantOnboardingShell → update-assistant-context. The row is inserted with
// provisioningStatus 'complete' + isActive=true, which the lifecycle trigger
// (db/assistant-lifecycle-status.sql) derives to 'working' — so the assistant is
// immediately chattable through chat-orchestrator.
//
// Gates (parity with the existing hire paths):
//   • DPA accepted at current version (US-GDPR-1.1.1, same as onboarding.ts)
//   • Plan assistant limit + referral bonus (mirrors check-capacity's live lifecycle count)
//   • comingSoon roles only when the US-AUD-2.3.1 milestone is unlocked
//
// If the org has already hired this role, responds 200 with the existing instance and
// alreadyHired=true so the setup page can re-run configuration against it instead of
// erroring — re-saving onboardingContext is idempotent and audit-logged server-side.

import { Handler } from '@netlify/functions';
import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants,
    dpaAcceptances,
    masterAssistants,
    masterPlans,
    notifications,
    organisations,
    plans,
    taskRuns,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { effectiveLimit, type FeatureOverrides } from '../../src/utils/plan-features';
import { checkRateLimit } from '../../src/utils/rate-limit';
import { CURRENT_DPA_VERSION } from './accept-dpa';
import { withLambda } from '@netlify/aws-lambda-compat';

// Instance default only — chat routes pick their own model per roleKey (chat-orchestrator ROUTES).
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    const rl = await checkRateLimit(db, 'hire-assistant', `user:${userId}`, { maxAttempts: 5, windowSecs: 60 });
    if (!rl.allowed) {
        return { statusCode: 429, headers: { 'Retry-After': String(rl.retryAfterSecs) }, body: JSON.stringify({ error: 'Too many requests. Please try again shortly.' }) };
    }

    let body: { roleKey?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const roleKey = (body.roleKey || '').trim();
    if (!roleKey) return json(400, { error: 'roleKey is required.' });

    try {
        // ── 1. Resolve the catalogue role ─────────────────────────────────────────
        const [master] = await db
            .select({
                id: masterAssistants.id,
                roleKey: masterAssistants.roleKey,
                name: masterAssistants.name,
                comingSoon: masterAssistants.comingSoon,
                isActive: masterAssistants.isActive,
                milestoneTasksRequired: masterAssistants.milestoneTasksRequired,
            })
            .from(masterAssistants)
            .where(eq(masterAssistants.roleKey, roleKey))
            .limit(1);
        if (!master || !master.isActive) return json(404, { error: 'This role is not available in the catalogue.' });

        // comingSoon roles are hireable only once the milestone unlock is earned
        // (same rule milestone-progress.ts uses to show the "Hire Role" button).
        if (master.comingSoon) {
            const [{ completedCount }] = await db
                .select({ completedCount: count() })
                .from(taskRuns)
                .where(and(eq(taskRuns.userId, userId), eq(taskRuns.status, 'completed')));
            const required = master.milestoneTasksRequired ?? 25;
            if ((Number(completedCount) || 0) < required) {
                return json(403, { error: `${master.name} is coming soon — complete ${required} tasks to unlock early access.`, code: 'COMING_SOON' });
            }
        }

        // ── 2. US-GDPR-1.1.1: org must have accepted the current DPA ──────────────
        const [dpa] = await db
            .select({ id: dpaAcceptances.id })
            .from(dpaAcceptances)
            .where(and(eq(dpaAcceptances.organisationId, orgId), eq(dpaAcceptances.version, CURRENT_DPA_VERSION)))
            .limit(1);
        if (!dpa) {
            return json(403, { error: 'Please review and accept our Data Processing Agreement before hiring an assistant.', code: 'DPA_REQUIRED' });
        }

        // ── 3. Capacity gate (server-side twin of check-capacity's client gate) ───
        // Assistants in provisioning/ready_for_work/working occupy a plan seat.
        // Scope by org OR user: an org member shares the owner's plan (which is keyed to
        // the owner's userId + the org id), so a userId-only lookup would wrongly find no
        // plan for members of a paid workspace.
        const [planRow] = await db
            .select({ assistantLimit: masterPlans.assistantLimit, featureOverrides: plans.featureOverrides })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(
                or(eq(plans.userId, userId), eq(plans.organisationId, orgId)),
                inArray(plans.status, ['active', 'past_due']),
            ))
            .orderBy(asc(plans.status), asc(plans.startedAt))
            .limit(1);
        // No active/past_due plan → HARD BLOCK. The free trial was removed (product decision):
        // a user with no paid plan can hire no assistants. Previously a missing plan resolved
        // to assistantLimit=null and skipped the gate entirely, granting unlimited free hires.
        if (!planRow) {
            return json(402, { error: 'Choose a plan to hire your first assistant.', code: 'NO_PLAN' });
        }
        // Plan Features: prefer a "new subscribers only" frozen snapshot over the live master limit.
        let assistantLimit: number | null = effectiveLimit(
            planRow.featureOverrides as FeatureOverrides | null, 'assistantLimit', planRow.assistantLimit ?? null);
        if (assistantLimit !== null) {
            const [org] = await db
                .select({ bonusAssistants: organisations.bonusAssistants })
                .from(organisations)
                .where(eq(organisations.id, orgId))
                .limit(1);
            assistantLimit += org?.bonusAssistants ?? 0;

            const [{ value: occupied }] = await db
                .select({ value: count() })
                .from(aiAssistants)
                .where(and(
                    eq(aiAssistants.organisationId, orgId),
                    inArray(aiAssistants.lifecycleStatus, ['provisioning', 'ready_for_work', 'working']),
                ));
            if (occupied >= assistantLimit) {
                return json(409, { error: "You've used all your assistant slots. Upgrade your plan to add more.", code: 'CAPACITY' });
            }
        }

        // ── 4. One instance per role name per org ─────────────────────────────────
        // Names are unique per organisation; the instance takes the catalogue name.
        const [existing] = await db
            .select({ id: aiAssistants.id, provisioningStatus: aiAssistants.provisioningStatus, lifecycleStatus: aiAssistants.lifecycleStatus })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.organisationId, orgId), sql`LOWER(${aiAssistants.name}) = LOWER(${master.name})`))
            .limit(1);
        if (existing) {
            // Abandoned pre-payment rows are safe to replace (same rule as onboarding.ts).
            if (['pending', 'pending_payment'].includes(existing.provisioningStatus || '')) {
                await db.delete(aiAssistants).where(eq(aiAssistants.id, existing.id));
            } else if (existing.lifecycleStatus === 'archived') {
                return json(409, { error: `${master.name} was archived in your workspace — restore or rename it before re-hiring.`, code: 'ARCHIVED' });
            } else {
                // Already on the team: hand back the existing instance so setup can re-run.
                return json(200, { assistantId: existing.id, name: master.name, roleKey: master.roleKey, alreadyHired: true });
            }
        }

        // ── 5. Create the instance ────────────────────────────────────────────────
        const [created] = await db.insert(aiAssistants).values({
            organisationId: orgId,
            userId,
            masterAssistantId: master.id,
            name: master.name,
            model: DEFAULT_MODEL,
            aiAssistantJobRole: master.name,
            systemPrompt: null, // chat-orchestrator ROUTES build the role prompt from onboardingContext
            configuration: { type: master.roleKey, active: true },
            onboardingContext: {}, // filled by AssistantOnboardingShell → update-assistant-context
            // EU AI Act Art. 50 default disclosure so the Kick Off readiness gate is pre-satisfied.
            disclosureText: `You're chatting with ${master.name}, an AI assistant. AI-generated responses may be inaccurate — always review important information before acting on it.`,
            isActive: true,
            provisioningStatus: 'complete', // lifecycle trigger derives 'working' — chattable immediately
        }).returning({ id: aiAssistants.id });

        // Best-effort welcome notification (non-blocking, same tone as onboarding.ts).
        try {
            await db.insert(notifications).values({
                userId,
                type: 'system',
                title: `${master.name} has joined your team`,
                message: `${master.name} is hired and ready — finish its setup to put it to work.`,
                metadata: { assistantId: created.id, roleKey: master.roleKey },
            });
        } catch (notifErr) {
            console.warn('[hire-assistant] Notification insert failed (non-blocking):', notifErr);
        }

        return json(200, { assistantId: created.id, name: master.name, roleKey: master.roleKey });
    } catch (err: any) {
        // Unique (organisationId, name) race — another tab hired it first.
        if (err?.code === '23505' || err?.message?.includes('ai_assistants_org_name_unique')) {
            return json(409, { error: 'This assistant was just hired in another tab — refresh your workspace.', code: 'DUPLICATE' });
        }
        console.error('[hire-assistant]', err);
        return json(500, { error: 'Failed to hire this assistant. Please try again.' });
    }
});
