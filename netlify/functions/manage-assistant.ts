// manage-assistant.ts
// PATCH  ?id=N  { action: "pause" | "resume" | "reinstate" }  → toggle isActive / undo an archive
// DELETE ?id=N                                                 → archive (14-day reinstate window, then purged)
//
// Edit is handled client-side: redirect to onboarding with ?edit=assistantId
// so the user can modify their blueprint/setup answers.

import { Handler } from '@netlify/functions';
import { eq, and, inArray, count, asc, isNull } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, taskRuns, notifications, masterPlans, organisations, plans } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { effectiveLimit, type FeatureOverrides } from '../../src/utils/plan-features';
import { requireTenant } from '../../src/utils/tenant';
import { transitionAssistantStatus } from '../../src/utils/assistant-lifecycle';
import { withLambda } from '@netlify/aws-lambda-compat';

// Issue #191: archiving starts a 14-day reinstate window before purge-archived-assistants.ts
// (daily cron) permanently deletes the assistant and all of its associated data.
const ARCHIVE_GRACE_PERIOD_DAYS = 14;

export default withLambda(async (event) => {
    const db = getDb();
    // Managing a shared assistant (pause/resume/delete) is an owner/admin action within the org.
    const ctx = await requireTenant(event, db, { roles: ['owner', 'admin'] });
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const qs = event.queryStringParameters || {};
    const id = parseInt(qs.id || '');
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    // RLS-enforced: all assistant reads/writes run under withTenant (app_user + app.current_org).
    return withTenant(orgId, async (tx) => {
        // Resolve the assistant within the active organisation (member-shared ownership).
        const findAssistant = async () => {
            const [row] = await tx
                .select()
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, id), eq(aiAssistants.organisationId, orgId)));
            return row ?? null;
        };

        try {
            // ── PATCH: pause / resume ─────────────────────────────────
            if (event.httpMethod === 'PATCH') {
                const body = JSON.parse(event.body || '{}');
                const action: string = body.action || '';

                if (!['pause', 'resume', 'reinstate'].includes(action)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'action must be "pause", "resume" or "reinstate".' }) };
                }

                const existing = await findAssistant();
                if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

                // Issue #191 — Reinstate: undo an archive within its 14-day grace window,
                // subject to the same plan assistant-limit gate as hiring a new one.
                if (action === 'reinstate') {
                    if (existing.lifecycleStatus !== 'archived') {
                        return { statusCode: 409, body: JSON.stringify({ error: 'Only archived assistants can be reinstated.' }) };
                    }
                    const scheduledDeletionAt = existing.scheduledDeletionAt instanceof Date
                        ? existing.scheduledDeletionAt
                        : existing.scheduledDeletionAt ? new Date(existing.scheduledDeletionAt as unknown as string) : null;
                    if (scheduledDeletionAt && scheduledDeletionAt.getTime() <= Date.now()) {
                        return { statusCode: 410, body: JSON.stringify({ error: 'This assistant and its data have already been permanently deleted and cannot be reinstated.' }) };
                    }

                    // Capacity gate — mirrors hire-assistant.ts's "server-side twin" of check-capacity.
                    const [planRow] = await tx
                        .select({ assistantLimit: masterPlans.assistantLimit, featureOverrides: plans.featureOverrides })
                        .from(plans)
                        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                        .where(and(eq(plans.userId, ctx.userId), inArray(plans.status, ['active', 'past_due'])))
                        .orderBy(asc(plans.status), asc(plans.startedAt))
                        .limit(1);
                    // Plan Features: prefer a "new subscribers only" frozen snapshot over the live master limit.
                    let assistantLimit: number | null = effectiveLimit(
                        planRow?.featureOverrides as FeatureOverrides | null, 'assistantLimit', planRow?.assistantLimit ?? null);
                    if (assistantLimit !== null) {
                        const [org] = await tx
                            .select({ bonusAssistants: organisations.bonusAssistants })
                            .from(organisations)
                            .where(eq(organisations.id, orgId))
                            .limit(1);
                        assistantLimit += org?.bonusAssistants ?? 0;

                        const [{ value: occupied }] = await tx
                            .select({ value: count() })
                            .from(aiAssistants)
                            .where(and(
                                eq(aiAssistants.organisationId, orgId),
                                inArray(aiAssistants.lifecycleStatus, ['provisioning', 'ready_for_work', 'working']),
                            ));
                        if (occupied >= assistantLimit) {
                            return { statusCode: 409, body: JSON.stringify({ error: "Your plan's assistant limit has been reached. Upgrade your plan or archive another assistant before reinstating this one.", code: 'CAPACITY' }) };
                        }
                    }

                    const result = await transitionAssistantStatus(db, id, 'paused', { reason: 'user_reinstate', actorUserId: ctx.userId });
                    if (!result.ok) return { statusCode: 409, body: JSON.stringify({ error: result.error }) };
                    await tx.update(aiAssistants)
                        .set({ provisioningStatus: 'complete', archivedAt: null, scheduledDeletionAt: null, updatedAt: new Date() })
                        .where(eq(aiAssistants.id, id));

                    // Issue #191 follow-up: close out the original archive notification (it was
                    // left open/unresolved so its "View & Reinstate" CTA stayed usable — see
                    // notification-actions.ts) and confirm the reinstatement so the user isn't
                    // left wondering whether the action actually took effect.
                    await db.update(notifications)
                        .set({ isRead: true, readAt: new Date(), resolvedAt: new Date() })
                        .where(and(
                            eq(notifications.userId, ctx.userId),
                            eq(notifications.type, 'assistant_archived'),
                            eq(notifications.assistantId, id),
                            isNull(notifications.resolvedAt),
                        )).catch(() => {});
                    await createNotification(db, 'assistant_reinstated', {
                        userId: ctx.userId,
                        context: { assistant: { name: existing.name } },
                        metadata: { assistantId: id },
                        assistantId: id,
                    });

                    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, lifecycleStatus: 'paused' }) };
                }

                // US4 (AC4.2/4.3): user pause is a canonical working → paused transition. The helper
                // sets isActive=false (immediate halt of outgoing actions/polling) and audits it.
                // IDOR is already verified above; the helper runs on the owner db (RLS-bypassing).
                if (action === 'pause') {
                    const result = await transitionAssistantStatus(db, id, 'paused', { reason: 'user_pause', actorUserId: ctx.userId });
                    if (!result.ok) return { statusCode: 409, body: JSON.stringify({ error: result.error }) };
                    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, lifecycleStatus: 'paused' }) };
                }

                // US-GOV-3.1.1: Block resume if disclosure is missing (EU AI Act Art. 52)
                if (action === 'resume' && !existing.disclosureText?.trim()) {
                    return {
                        statusCode: 422,
                        body: JSON.stringify({
                            error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).',
                            code: 'DISCLOSURE_MISSING',
                        }),
                    };
                }

                // Resume (legacy/direct path, kept for API back-compat). The UI now resumes a
                // paused assistant through the Kick-Off summary (kickoff-assistant.ts, AC4.4).
                const [updated] = await tx
                    .update(aiAssistants)
                    .set({ isActive: true, updatedAt: new Date() })
                    .where(eq(aiAssistants.id, id))
                    .returning();

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assistant: updated }),
                };
            }

            // ── DELETE: archive (US6 — Safe Archiving / End of Life) ──
            if (event.httpMethod === 'DELETE') {
                const existing = await findAssistant();
                if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

                // Issue #191: archiving now opens a 14-day reinstate window (rather than being
                // immediately terminal) — archivedAt/scheduledDeletionAt drive both the reinstate
                // gate above and purge-archived-assistants.ts's hard-delete sweep.
                const now = new Date();
                const scheduledDeletionAt = new Date(now.getTime() + ARCHIVE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

                // AC5.2 state transition: archived is reachable from every state. The helper audits
                // it and sets isActive=false; we also keep the legacy provisioningStatus='cancelled'
                // so older consumers still treat it as gone. (IDOR already verified above; the helper
                // runs on the owner db.)
                await transitionAssistantStatus(db, id, 'archived', { reason: 'user_archive', actorUserId: ctx.userId });
                await db.update(aiAssistants)
                    .set({ provisioningStatus: 'cancelled', archivedAt: now, scheduledDeletionAt, updatedAt: now })
                    .where(eq(aiAssistants.id, id));

                // AC5.2 purge: hard-delete queued / in-flight task runs so nothing more executes.
                // (There is no separate AI session-token store; non-terminal task_runs are the
                // active "sessions".) Completed/failed/terminated history is preserved (AC5.3).
                await db.delete(taskRuns).where(and(
                    eq(taskRuns.assistantId, id),
                    inArray(taskRuns.status, ['pending', 'running', 'reviewing', 'suspended']),
                ));

                // Issue #191: notify the user, with a link to the archived assistant's detail page
                // (where the reinstate banner lives) and the deletion deadline spelled out.
                const deletionDateLabel = scheduledDeletionAt.toISOString().slice(0, 10);
                await createNotification(db, 'assistant_archived', {
                    userId: ctx.userId,
                    context: { assistant: { name: existing.name }, archive: { deletion_date: deletionDateLabel, grace_days: ARCHIVE_GRACE_PERIOD_DAYS } },
                    metadata: { assistantId: id, scheduledDeletionAt: scheduledDeletionAt.toISOString() },
                    assistantId: id,
                });

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, lifecycleStatus: 'archived', scheduledDeletionAt: scheduledDeletionAt.toISOString() }),
                };
            }

            return { statusCode: 405, body: 'Method Not Allowed' };

        } catch (err: any) {
            console.error('[manage-assistant] Error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
        }
    });
});
