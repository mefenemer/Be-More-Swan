// manage-assistant.ts
// PATCH  ?id=N  { action: "pause" | "resume" }  → toggle isActive
// DELETE ?id=N                                   → soft-delete (isActive=false, status=cancelled)
//
// Edit is handled client-side: redirect to onboarding with ?edit=assistantId
// so the user can modify their blueprint/setup answers.

import { Handler } from '@netlify/functions';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, taskRuns } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { transitionAssistantStatus } from '../../src/utils/assistant-lifecycle';

export const handler: Handler = async (event) => {
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

                if (!['pause', 'resume'].includes(action)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'action must be "pause" or "resume".' }) };
                }

                const existing = await findAssistant();
                if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

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

                // AC5.2 state transition: archived is reachable from every state. The helper audits
                // it and sets isActive=false; we also keep the legacy provisioningStatus='cancelled'
                // so older consumers still treat it as gone. (IDOR already verified above; the helper
                // runs on the owner db.)
                await transitionAssistantStatus(db, id, 'archived', { reason: 'user_archive', actorUserId: ctx.userId });
                await db.update(aiAssistants)
                    .set({ provisioningStatus: 'cancelled', updatedAt: new Date() })
                    .where(eq(aiAssistants.id, id));

                // AC5.2 purge: hard-delete queued / in-flight task runs so nothing more executes.
                // (There is no separate AI session-token store; non-terminal task_runs are the
                // active "sessions".) Completed/failed/terminated history is preserved (AC5.3).
                await db.delete(taskRuns).where(and(
                    eq(taskRuns.assistantId, id),
                    inArray(taskRuns.status, ['pending', 'running', 'reviewing', 'suspended']),
                ));

                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, lifecycleStatus: 'archived' }),
                };
            }

            return { statusCode: 405, body: 'Method Not Allowed' };

        } catch (err: any) {
            console.error('[manage-assistant] Error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
        }
    });
};
