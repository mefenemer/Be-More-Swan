// netlify/functions/get-in-progress-assistants.ts
// Feeds the "Onboarding" cards on the Dashboard and My Team views (US1).
// Returns the in-progress items for the active organisation:
//   - kind 'draft'      → an onboarding_drafts row (status draft / setup_incomplete)
//   - kind 'validation' → an ai_assistants row still provisioning (status ai_validation) or failed
//
// GET only. Auth: aura_session cookie + active-org membership.

import { Handler } from '@netlify/functions';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, onboardingDrafts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { provisioningBlockInfo } from '../../src/utils/assistant-lifecycle';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    try {
        // Drafts: those owned by the org, plus the caller's own (covers legacy null-org rows).
        const drafts = await db.select({
            id: onboardingDrafts.id,
            onboardingPath: onboardingDrafts.onboardingPath,
            roleKey: onboardingDrafts.roleKey,
            displayName: onboardingDrafts.displayName,
            currentStep: onboardingDrafts.currentStep,
            updatedAt: onboardingDrafts.updatedAt,
        }).from(onboardingDrafts)
            .where(or(eq(onboardingDrafts.organisationId, orgId), eq(onboardingDrafts.userId, userId)))
            .orderBy(desc(onboardingDrafts.updatedAt));

        // Validation: assistants still being provisioned, that failed, or that a compliance gate
        // blocked (needs user action). RLS-enforced via withTenant, matching get-assistants.ts.
        const validating = await withTenant(orgId, (tx) => tx.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            provisioningStatus: aiAssistants.provisioningStatus,
            provisioningBlockedReason: aiAssistants.provisioningBlockedReason,
        }).from(aiAssistants)
            .where(and(
                eq(aiAssistants.organisationId, orgId),
                inArray(aiAssistants.provisioningStatus, ['pending', 'failed', 'blocked']),
            )));

        const items = [
            ...drafts.map(d => ({
                kind: 'draft' as const,
                draftId: d.id,
                onboardingPath: d.onboardingPath,
                roleKey: d.roleKey,
                displayName: d.displayName,
                currentStep: d.currentStep,
                updatedAt: d.updatedAt,
            })),
            ...validating.map(a => ({
                kind: 'validation' as const,
                assistantId: a.id,
                name: a.name,
                role: a.role,
                provisioningStatus: a.provisioningStatus,
                // Only set for blocked rows — { reason, title, message, cta } drives the
                // "Action required" card + CTA on the dashboard.
                blocked: a.provisioningStatus === 'blocked'
                    ? { reason: a.provisioningBlockedReason, ...provisioningBlockInfo(a.provisioningBlockedReason) }
                    : null,
            })),
        ];

        return { statusCode: 200, body: JSON.stringify({ items }) };
    } catch (e) {
        console.error('get-in-progress-assistants error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) };
    }
};
