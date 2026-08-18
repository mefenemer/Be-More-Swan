import { Handler } from '@netlify/functions';
import { eq, and, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, dpaAcceptances, masterAssistants } from '../../db/schema';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { CURRENT_DPA_VERSION } from './accept-dpa';
import { requireTenant } from '../../src/utils/tenant';
import { AUTONOMOUS_DRAFT_PLATFORMS, describeAutoPublishVolume } from '../../src/utils/publish-policy';
import { resolveHorizonDays } from '../../src/config/posting-cadence';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'Assistant ID required.' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    // US-ADM-3.2.1: Global AI kill switch check
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    // RLS-enforced: tenant-data queries run under withTenant (app_user + app.current_org).
    return withTenant(orgId, async (tx) => {
        const [row] = await tx.select({
            id: aiAssistants.id,
            // The user's chosen name for THEIR assistant — stable, never follows a rename.
            name: aiAssistants.name,
            // The ROLE label. master_assistants.name is the live, admin-editable source;
            // ai_assistant_job_role is only a hire-time snapshot that goes stale on rename, so it's
            // just the fallback for legacy rows with no masterAssistantId.
            role: sql<string | null>`coalesce(${masterAssistants.name}, ${aiAssistants.aiAssistantJobRole})`,
            status: aiAssistants.provisioningStatus,
            isActive: aiAssistants.isActive,
            // Canonical lifecycle state (assistant-lifecycle-epic) — distinct from the master
            // assistant's lifecycleState (draft/review/live) joined below.
            lifecycleStatus: aiAssistants.lifecycleStatus,
            // Issue #191 — reinstate window: the detail page's archived banner shows the
            // countdown to permanent deletion from these.
            archivedAt: aiAssistants.archivedAt,
            scheduledDeletionAt: aiAssistants.scheduledDeletionAt,
            onboardingContext: aiAssistants.onboardingContext,
            configuration: aiAssistants.configuration,
            draftHorizonDays: aiAssistants.draftHorizonDays,
            reviewNotifPreference: aiAssistants.reviewNotifPreference,
            masterAssistantId: aiAssistants.masterAssistantId,
            // Drives the role-aware dashboard (AssistantDashboardRegistry) on the detail page.
            roleKey: masterAssistants.roleKey,
            disclosureText: aiAssistants.disclosureText,
            organisationId: aiAssistants.organisationId,
            lifecycleState: masterAssistants.lifecycleState,
            replacementAssistantId: masterAssistants.replacementAssistantId,
            replacementName: masterAssistants.name,
        }).from(aiAssistants)
            .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
            .where(and(eq(aiAssistants.id, parseInt(assistantId)), eq(aiAssistants.organisationId, orgId)))
            .limit(1);

        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

        // US-GDPR-1.1.1: Block if organisation has not accepted the current DPA version
        if (row.organisationId) {
            const [dpa] = await tx
                .select({ id: dpaAcceptances.id })
                .from(dpaAcceptances)
                .where(and(
                    eq(dpaAcceptances.organisationId, row.organisationId),
                    eq(dpaAcceptances.version, CURRENT_DPA_VERSION),
                ))
                .limit(1);
            if (!dpa) {
                return { statusCode: 403, body: JSON.stringify({ error: 'DPA acceptance required.', code: 'DPA_REQUIRED' }) };
            }
        }

        // onboardingContext is the STRUCTURED jsonb object captured during onboarding
        // (target_audience, tone_of_voice, content_pillars, posting_frequency, …). The detail
        // page reads it as an object to populate the Configuration fields, so return it as-is.
        // (A previous version concatenated a confidentiality string onto it, coercing the object
        // to "[object Object]…" and blanking every structured field. The model's actual system
        // prompt — the thing that suffix protected — is aiAssistants.systemPrompt, not this
        // display payload, and is never returned here.)
        return { statusCode: 200, body: JSON.stringify({
                // Assistant id — the detail page passes this to the Data Hub / Knowledge Base
                // tabs (init bails without it) and the role's primary-action chat link.
                id: row.id,
                context: row.onboardingContext ?? {},
                configuration: row.configuration,
                // Platforms an autonomous drafter actually exists for. The Autopilot mode card
                // renders a live toggle only for these; everything else is shown disabled. Served
                // from the backend so the UI can't drift from what the drafter really does.
                autoPublishPlatforms: [...AUTONOMOUS_DRAFT_PLATFORMS],
                // The unattended-publish volume this assistant's own posting schedule implies.
                // Derived server-side from the same helper that computes the enforced ceiling, so
                // the sentence the user reads can't disagree with the limit actually applied.
                autoPublishVolumeText: describeAutoPublishVolume(row.onboardingContext),
                draftHorizonDays: resolveHorizonDays(row),
                reviewNotifPreference: row.reviewNotifPreference ?? 'immediate',
                name: row.name,
                role: row.role || 'Digital Assistant',
                status: row.status || 'pending',
                isActive: row.isActive,
                lifecycleStatus: row.lifecycleStatus || 'provisioning',
                archivedAt: row.archivedAt ?? null,
                scheduledDeletionAt: row.scheduledDeletionAt ?? null,
                // null for legacy assistants with no master role — the frontend registry
                // falls back to the social_media_manager (default) dashboard.
                roleKey: row.roleKey ?? null,
                disclosureText: row.disclosureText ?? null,
                dpaAccepted: true,
                lifecycleState: row.lifecycleState ?? 'live',
                replacementAssistantId: row.replacementAssistantId ?? null,
            }) };
    });
});