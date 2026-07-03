import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, auditLogs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';

export const handler: Handler = async (event) => {
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

            // Perform the Update
            const updatePayload: any = { onboardingContext: newContext, updatedAt: new Date() };
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
                newState: newContext,
                ipAddress: event.headers['x-nf-client-connection-ip'] || 'unknown',
            });
        });

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
};