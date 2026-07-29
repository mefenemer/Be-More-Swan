import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, auditLogs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'PUT') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // 1. Auth + resolve the active organisation (member-shared assistant ownership).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId: currentUserId, organisationId: orgId } = ctx;

    // 2. Payload Extraction
    const { assistantId, newContext, newConfiguration, newName, appliedDefaults, disclosureText } = JSON.parse(event.body || '{}');

    if (!assistantId || !newContext) return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters.' }) };

    try {
        // RLS-enforced: the whole unit of work runs under withTenant (app_user + app.current_org).
        await withTenant(orgId, async (tx) => {
            // Fetch Previous State
            const [existingAssistant] = await tx.select()
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);

            if (!existingAssistant) throw new Error("Assistant not found.");

            // US-GOV-3.1.1: Reject save if trying to clear disclosure on an active assistant
            if (disclosureText !== undefined && !disclosureText?.trim() && existingAssistant.isActive) {
                throw new Error('DISCLOSURE_REQUIRED: AI disclosure text cannot be removed from an active assistant (EU AI Act Art. 52).');
            }

            // This endpoint REPLACES onboardingContext wholesale, so any caller that doesn't
            // round-trip a key silently drops it. That's tolerable for descriptive fields, but
            // publishPolicy governs whether posts publish without human review — the onboarding
            // wizard (assistant-onboarding-shell.js) sends only its own answers, so re-running
            // setup would quietly reset a deployer's auto-publish choice. Carry it across when the
            // caller didn't mention it; an explicit value (even {}) still wins.
            // trigger_type/content_source are carried for the same reason: they are asked once, in
            // the social wizard's Operational Setup step, and the blueprint reads them from here —
            // so a partial save from any other surface must not erase them.
            const CARRY_ACROSS = ['publishPolicy', 'trigger_type', 'content_source'];
            const mergedContext = { ...newContext };
            const existingCtx = (existingAssistant.onboardingContext as Record<string, unknown> | null) ?? {};
            for (const key of CARRY_ACROSS) {
                if (!Object.prototype.hasOwnProperty.call(mergedContext, key)
                    && Object.prototype.hasOwnProperty.call(existingCtx, key)) {
                    mergedContext[key] = existingCtx[key];
                }
            }

            // Perform the Update
            const updatePayload: any = { onboardingContext: mergedContext, updatedAt: new Date() };
            if (newConfiguration) updatePayload.configuration = newConfiguration;
            if (newName) updatePayload.name = newName;
            if (disclosureText !== undefined) updatePayload.disclosureText = disclosureText;
            if (appliedDefaults !== undefined) {
                // Merge appliedDefaults into existing configuration rather than overwrite
                const existingConfig = existingAssistant.configuration as any || {};
                updatePayload.configuration = {
                    ...existingConfig,
                    ...(newConfiguration || {}),
                    appliedDefaults: {
                        ...(existingConfig.appliedDefaults || {}),
                        ...appliedDefaults,
                    },
                };
            }
            await tx.update(aiAssistants)
                .set(updatePayload)
                .where(eq(aiAssistants.id, assistantId));

            // SCENARIO 5: Create Immutable Audit Log
            await tx.insert(auditLogs).values({
                userId: currentUserId,
                actionType: 'UPDATE_CONTEXT',
                resourceType: 'aiAssistants',
                resourceId: assistantId.toString(),
                previousState: existingAssistant.onboardingContext,
                newState: mergedContext,
                ipAddress: event.headers['x-nf-client-connection-ip'] || 'unknown',
            });
        });

        // Recompile the blueprint so this edit actually reaches generation.
        //
        // Generation drives off the COMPILED blueprint sections, not the live rows — so before this,
        // an edit here changed what the profile displayed while drafts carried on being written from
        // whatever the sections held when they were last assembled. Some fields hid the lag because
        // the worker reads them live (platform_strategy, brand hashtags, operational setup); the
        // rest — audience, tone, pillars, offerings, objective, strict rules — simply did not apply
        // until something else happened to trigger a recompile.
        //
        // It also keeps the STORED blueprint an honest record of what produced a post, which it
        // could not be while half its inputs were read live and half from a stale snapshot.
        //
        // Data assembly only, no LLM call, so it is cheap enough to run on every save. Best-effort
        // exactly as in reject-post.ts: a recompile failure must never fail the user's save — the
        // edit is already committed, and the next recompile picks it up.
        try {
            await assembleBlueprint(assistantId, `user-${currentUserId}`, 'context_update');
        } catch (e) {
            console.warn('[update-assistant-context] blueprint recompile failed (context still saved):', e instanceof Error ? e.message : e);
        }

        // If the user just supplied AI disclosure text, re-trigger this assistant in case it was
        // parked at provisioning_status='blocked' on the disclosure gate (best-effort; the
        // background fn re-evaluates every gate, so it advances or re-blocks accordingly).
        if (typeof disclosureText === 'string' && disclosureText.trim()) {
            const baseUrl = resolveBaseUrl(event.headers);
            if (baseUrl) {
                await retryBlockedAssistants(db, { baseUrl, assistantId, organisationId: orgId }).catch(() => {});
            }
        }

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error: any) {
        if (error?.message?.startsWith('DISCLOSURE_REQUIRED')) {
            return { statusCode: 422, body: JSON.stringify({ error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).', code: 'DISCLOSURE_MISSING' }) };
        }
        console.error('Update Context Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update context.' }) };
    }
});