// hire-assistant.ts — instant hire for schema-driven Digital Assistants.
// POST { roleKey: string } → { assistantId, name, roleKey, alreadyHired? }
//
// Creates the org's aiAssistants instance for a catalogue role WITHOUT the Social Media
// Manager blueprint flow (onboarding.ts): schema-driven roles
// (see src/config/assistant-onboarding-schemas.js) capture their configuration AFTER hire
// via AssistantOnboardingShell → update-assistant-context. The row is inserted with
// provisioningStatus 'complete' + isActive=true, which the lifecycle trigger
// (db/assistant-lifecycle-status.sql) derives to 'working' — so the assistant is
// immediately chattable through chat-orchestrator.
//
// Gates (parity with the existing hire paths):
//   • DPA accepted at current version (US-GDPR-1.1.1, same as onboarding.ts)
//   • Plan assistant limit + referral bonus (mirrors check-capacity's live lifecycle count)
//   • Status (src/utils/assistant-go-live.ts hireDecision): coming-soon roles are NEVER hireable —
//     they are teasers, mostly unbuilt. Beta roles need the org's Beta access or the user's
//     US-AUD-2.3.1 task milestone. Live roles are open.
//
// If the org has already hired this role, responds 200 with the existing instance and
// alreadyHired=true so the setup page can re-run configuration against it instead of
// erroring — re-saving onboardingContext is idempotent and audit-logged server-side.

import { Handler } from '@netlify/functions';
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { checkAssistantCapacity } from '../../src/utils/assistant-capacity';
import {
    aiAssistants,
    dpaAcceptances,
    masterAssistants,
    organisations,
    taskRuns,
} from '../../db/schema';
import { hireDecision, statusOf } from '../../src/utils/assistant-go-live';
import { requireTenant } from '../../src/utils/tenant';
import { createNotification } from '../../src/utils/notify';
import { checkRateLimit } from '../../src/utils/rate-limit';
import { dpaAcceptedVersionClause } from './accept-dpa';
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
                lifecycleState: masterAssistants.lifecycleState,
                milestoneTasksRequired: masterAssistants.milestoneTasksRequired,
            })
            .from(masterAssistants)
            .where(eq(masterAssistants.roleKey, roleKey))
            .limit(1);
        if (!master || !master.isActive) return json(404, { error: 'This role is not available in the catalogue.' });

        // Coming soon = not built: refused whatever the task count. Beta = built, early access: the
        // org's Beta access or the user's task milestone opens it. Same rule master-assistants and
        // milestone-progress use to show the "Hire" button (assistant-go-live.ts hireDecision).
        const status = statusOf(master);
        if (status === 'coming_soon') {
            return json(403, { error: `${master.name} is coming soon and can't be hired yet — turn on "Notify me" and we'll tell you when it launches.`, code: 'COMING_SOON' });
        }
        if (status === 'beta') {
            const [[org], [{ completedCount }]] = await Promise.all([
                db.select({ betaAccess: organisations.betaAccess }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
                db.select({ completedCount: count() }).from(taskRuns)
                    .where(and(eq(taskRuns.userId, userId), eq(taskRuns.status, 'completed'))),
            ]);
            const decision = hireDecision({
                status,
                betaAccess: org?.betaAccess ?? false,
                completedTasks: Number(completedCount) || 0,
                milestoneTasksRequired: master.milestoneTasksRequired,
            });
            if (!decision.ok) {
                return json(403, { error: `${master.name} is in early access — complete ${decision.required} tasks to unlock it.`, code: decision.code });
            }
        }

        // ── 2. US-GDPR-1.1.1: org must have accepted the DPA ──────────────
        const [dpa] = await db
            .select({ id: dpaAcceptances.id })
            .from(dpaAcceptances)
            .where(and(eq(dpaAcceptances.organisationId, orgId), dpaAcceptedVersionClause()))
            .limit(1);
        if (!dpa) {
            return json(403, { error: 'Please review and accept our Data Processing Agreement before hiring an assistant.', code: 'DPA_REQUIRED' });
        }

        // ── 3. Capacity gate (server-side twin of check-capacity's client gate) ───
        // Shared with onboarding.ts, which creates assistants too and had NO check at all — see
        // src/utils/assistant-capacity.ts for why a second copy was the wrong answer.
        const refusal = await checkAssistantCapacity(db, userId, orgId);
        if (refusal) return json(refusal.status, { error: refusal.error, code: refusal.code });

        // ── 4. One instance per role name per org ─────────────────────────────────
        // Names are unique per organisation; the instance takes the catalogue name.
        // Match on the master link, not the name. Keying this on LOWER(name) = LOWER(master.name)
        // meant an admin renaming the role broke the check: the hired row still carried the OLD
        // name, so nothing matched and the org could hire the same role twice (the
        // ai_assistants_org_name_unique constraint also keys on name, so it wouldn't catch it
        // either). masterAssistantId is stable across renames; the name fallback keeps legacy rows
        // that predate the FK working.
        const [existing] = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name, provisioningStatus: aiAssistants.provisioningStatus, lifecycleStatus: aiAssistants.lifecycleStatus })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.organisationId, orgId),
                or(
                    eq(aiAssistants.masterAssistantId, master.id),
                    sql`(${aiAssistants.configuration} ->> 'type') = ${master.roleKey}`,
                    and(isNull(aiAssistants.masterAssistantId), sql`LOWER(${aiAssistants.name}) = LOWER(${master.name})`),
                ),
            ))
            .limit(1);
        if (existing) {
            // Abandoned pre-payment rows are safe to replace (same rule as onboarding.ts).
            if (['pending', 'pending_payment'].includes(existing.provisioningStatus || '')) {
                await db.delete(aiAssistants).where(eq(aiAssistants.id, existing.id));
            } else if (existing.lifecycleStatus === 'archived') {
                return json(409, { error: `${master.name} was archived in your workspace — restore or rename it before re-hiring.`, code: 'ARCHIVED' });
            } else {
                // Already on the team: hand back the existing instance so setup can re-run. `name` is the
                // instance's OWN name (the user may have renamed it — the setup wizard's naming step
                // prefills from this); `roleName` is the catalogue role title.
                return json(200, { assistantId: existing.id, name: existing.name || master.name, roleName: master.name, roleKey: master.roleKey, alreadyHired: true });
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

        // Best-effort welcome notification (non-blocking; createNotification swallows errors).
        await createNotification(db, 'assistant_hired', {
            userId,
            context: { assistant: { name: master.name } },
            metadata: { assistantId: created.id, roleKey: master.roleKey },
        });

        return json(200, { assistantId: created.id, name: master.name, roleName: master.name, roleKey: master.roleKey });
    } catch (err: any) {
        // Unique (organisationId, name) race — another tab hired it first.
        if (err?.code === '23505' || err?.message?.includes('ai_assistants_org_name_unique')) {
            return json(409, { error: 'This assistant was just hired in another tab — refresh your workspace.', code: 'DUPLICATE' });
        }
        console.error('[hire-assistant]', err);
        return json(500, { error: 'Failed to hire this assistant. Please try again.' });
    }
});
