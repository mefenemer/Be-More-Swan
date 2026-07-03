// get-assistant-readiness.ts
// GET ?id=<assistantId>
// Returns the Kick Off Meeting readiness checklist for a specific assistant — the items
// the user confirms before the assistant starts working (Board Room). Each item's done-flag
// is derived from real rows; `allRequiredDone` gates the Kick Off action in the UI.

import { Handler } from '@netlify/functions';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, systemConnections, contentRules, tosAcceptances, dpaAcceptances, masterAssistants, riskAssessments } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { provisioningBlockInfo } from '../../src/utils/assistant-lifecycle';
import { checkProhibitedUsePatterns } from '../../src/utils/tos-gate';
import { CURRENT_TOS_VERSION } from './accept-tos';
import { CURRENT_DPA_VERSION } from './accept-dpa';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

type Db = ReturnType<typeof getDb>;

/**
 * Compute the Kick Off Meeting readiness checklist for one assistant — the items the user
 * confirms before it starts working (Board Room). Shared between this endpoint's handler and
 * the Setup Wizard (get-wizard-state), where the same items render as the sub-tasks of the
 * "Preparing your assistant" step. Returns the full payload, or null if the assistant doesn't
 * belong to the org (IDOR-guarded). Throws on DB errors — callers degrade as they see fit.
 */
export async function computeAssistantReadiness(db: Db, orgId: number, assistantId: number) {
        const result = await withTenant(orgId, async (tx) => {
            // ── IDOR guard: assistant must belong to the caller's organisation ──
            const [assistant] = await tx.select({
                id: aiAssistants.id,
                name: aiAssistants.name,
                role: aiAssistants.aiAssistantJobRole,
                userId: aiAssistants.userId,
                masterAssistantId: aiAssistants.masterAssistantId,
                isActive: aiAssistants.isActive,
                provisioningStatus: aiAssistants.provisioningStatus,
                provisioningBlockedReason: aiAssistants.provisioningBlockedReason,
                lifecycleStatus: aiAssistants.lifecycleStatus,
                configuration: aiAssistants.configuration,
                onboardingContext: aiAssistants.onboardingContext,
                systemPrompt: aiAssistants.systemPrompt,
                disclosureText: aiAssistants.disclosureText,
                prohibitedUseAcknowledged: aiAssistants.prohibitedUseAcknowledged,
                updatedAt: aiAssistants.updatedAt,
            }).from(aiAssistants)
              .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
              .limit(1);
            if (!assistant) return null;

            const exists = async (rows: Promise<{ id: number }[]>) => (await rows).length > 0;
            const [hasHealthyConnection, hasRule] = await Promise.all([
                // ≥1 *healthy* connection (active + status='active', not expired/failed). Mirrors the
                // kick-off gate (kickoff-assistant.ts) so this item can't read green while kick-off
                // would 422 NO_CONNECTION on a stale token.
                exists(tx.select({ id: systemConnections.id }).from(systemConnections).where(and(
                    eq(systemConnections.organisationId, orgId),
                    eq(systemConnections.isActive, true),
                    eq(systemConnections.status, 'active'),
                )).limit(1)),
                // ≥1 guardrail/rule configured for this assistant.
                exists(tx.select({ id: contentRules.id }).from(contentRules).where(and(
                    eq(contentRules.assistantId, assistantId),
                    eq(contentRules.isActive, true),
                )).limit(1)),
            ]);
            // US3 AC3.1: active connection service names for the Kick-Off summary screen.
            const connRows = await tx.select({ serviceName: systemConnections.serviceName })
                .from(systemConnections)
                .where(and(eq(systemConnections.organisationId, orgId), eq(systemConnections.isActive, true)));
            const connections = connRows.map(r => r.serviceName).filter(Boolean);

            // US5 AC5.2: connections that need reconnecting (drives the system_paused diagnostic).
            const brokenRows = await tx.select({ serviceName: systemConnections.serviceName })
                .from(systemConnections)
                .where(and(
                    eq(systemConnections.organisationId, orgId),
                    inArray(systemConnections.status, ['expired', 'failed', 'revoked', 'token_refresh_failed']),
                ));
            const brokenConnections = [...new Set(brokenRows.map(r => r.serviceName).filter(Boolean))];
            return { assistant, hasHealthyConnection, hasRule, connections, brokenConnections };
        });

        if (!result) return null;
        const { assistant, hasHealthyConnection, hasRule, connections, brokenConnections } = result;

        // US5 AC5.2: when system_paused, surface WHY + which fix the user needs. Derived on read
        // (no extra column): billing/limit come from provisioningStatus, otherwise a broken
        // OAuth connection. The client renders the red "Attention Required" panel + targeted CTA.
        let attention: { kind: string; services: string[] } | null = null;
        if (assistant.lifecycleStatus === 'system_paused') {
            if (assistant.provisioningStatus === 'paused_payment') {
                attention = { kind: 'billing', services: [] };
            } else if (assistant.provisioningStatus === 'paused_limit') {
                attention = { kind: 'limit', services: [] };
            } else if (brokenConnections.length) {
                attention = { kind: 'connection', services: brokenConnections };
            }
            // else: still system_paused but the cause looks resolved (e.g. user reconnected) →
            // leave attention null so the normal Kick-Off card lets them start again (US5 recovery).
        }

        // Brand & strategy is configured once the onboarding context / configuration is populated.
        const oc = (assistant.onboardingContext as Record<string, unknown> | null) || {};
        const cfg = (assistant.configuration as Record<string, unknown> | null) || {};
        const brandConfigured = Object.keys(oc).length > 0 || Object.keys(cfg).length > 0;
        const disclosureDone = Boolean(assistant.disclosureText?.trim());

        // ── Compliance readiness ────────────────────────────────────────────────────────────
        // These are the gates provision-assistant-background enforces before an assistant reaches
        // ready_for_work (ToS, DPA, prohibited-use ack, EU high-risk conformity). Surfacing them in
        // the same checklist makes it the single list of everything required to put the assistant to
        // work. Each done-flag is `<real evidence> || provisioned`: reaching provisioningStatus
        // 'complete' provably means every provisioning gate already passed, so an assistant that's
        // ready_for_work never shows a false "not done" (and kick-off itself only re-gates disclosure
        // + connection). When provisioning is *blocked*, the dedicated panel above takes over the UI.
        const provisioned = assistant.provisioningStatus === 'complete';

        const [tosRow, dpaRow] = await Promise.all([
            assistant.userId
                ? db.select({ id: tosAcceptances.id }).from(tosAcceptances).where(and(
                    eq(tosAcceptances.userId, assistant.userId),
                    eq(tosAcceptances.version, CURRENT_TOS_VERSION),
                  )).limit(1)
                : Promise.resolve([] as { id: number }[]),
            db.select({ id: dpaAcceptances.id }).from(dpaAcceptances).where(and(
                eq(dpaAcceptances.organisationId, orgId),
                eq(dpaAcceptances.version, CURRENT_DPA_VERSION),
            )).limit(1),
        ]);
        const tosDone = tosRow.length > 0 || provisioned;
        const dpaDone = dpaRow.length > 0 || provisioned;

        // Prohibited-use ack only applies when the system prompt trips a regulated-category pattern.
        const prohibitedUseDetected = assistant.systemPrompt
            ? checkProhibitedUsePatterns(assistant.systemPrompt).detected
            : false;
        const ackDone = Boolean(assistant.prohibitedUseAcknowledged) || provisioned;

        // Conformity assessment only applies to High-Risk master assistants (EU AI Act).
        let conformityApplicable = false;
        let conformityDone = true;
        if (assistant.masterAssistantId) {
            const [master] = await db.select({ riskClassification: masterAssistants.riskClassification })
                .from(masterAssistants).where(eq(masterAssistants.id, assistant.masterAssistantId)).limit(1);
            if (master?.riskClassification === 'high_risk') {
                conformityApplicable = true;
                const [assessment] = await db.select({ id: riskAssessments.id }).from(riskAssessments).where(and(
                    eq(riskAssessments.masterAssistantId, assistant.masterAssistantId),
                    eq(riskAssessments.organisationId, orgId),
                    eq(riskAssessments.approvalStatus, 'approved'),
                )).limit(1);
                // `|| provisioned` covers non-EU high-risk orgs, which clear provisioning without an
                // assessment (the gate is EU-jurisdiction-only) — they shouldn't read as not-done.
                conformityDone = Boolean(assessment) || provisioned;
            }
        }

        // required: must pass before the assistant can be kicked off. brand_strategy is recommended
        // (not enforced at kick-off), so it no longer gates allRequiredDone.
        const items = [
            { key: 'brand_strategy', label: 'Brand & strategy configured', done: brandConfigured, required: false,
              hint: 'Complete the onboarding form so your assistant knows your brand and goals (recommended).' },
            { key: 'connections', label: 'Tools connected', done: hasHealthyConnection, required: true,
              hint: 'Connect at least one account — and reconnect any expired ones — so your assistant can do its work.' },
            { key: 'disclosure', label: 'AI disclosure acknowledged', done: disclosureDone, required: true,
              hint: 'Enter the disclosure caption in the Guardrails tab — the text appended to every post to declare AI-generated content (this is separate from the general AI disclaimer you may have already accepted).' },
            { key: 'tos', label: 'Terms of Service accepted', done: tosDone, required: true,
              hint: 'Accept the current Terms of Service before this assistant can be activated.' },
            { key: 'dpa', label: 'Data Processing Agreement accepted', done: dpaDone, required: true,
              hint: 'Your organisation must accept the Data Processing Agreement (GDPR) before activation.' },
        ];
        if (prohibitedUseDetected) {
            items.push({ key: 'prohibited_use', label: 'Prohibited-use compliance acknowledged', done: ackDone, required: true,
              hint: "This assistant's instructions touch regulated categories — review the Terms (clauses 10.3 & 11.4) and acknowledge compliance." });
        }
        if (conformityApplicable) {
            items.push({ key: 'conformity', label: 'Conformity assessment approved', done: conformityDone, required: true,
              hint: 'This assistant is High Risk under the EU AI Act and needs an approved conformity assessment for EU deployment.' });
        }
        items.push({ key: 'guardrails', label: 'Guardrails & rules set', done: hasRule, required: false,
          hint: 'Add at least one rule to steer tone and content (recommended).' });

        const allRequiredDone = items.filter(i => i.required).every(i => i.done);

        // A gate blocked provisioning — surface the specific, actionable reason so the client can
        // render a "fix this" panel + Retry instead of a perpetual "setting up" spinner.
        const blocked = assistant.provisioningStatus === 'blocked'
            ? { reason: assistant.provisioningBlockedReason, ...provisioningBlockInfo(assistant.provisioningBlockedReason) }
            : null;

        return {
            assistantId,
            status: assistant.provisioningStatus,
            isActive: assistant.isActive,
            lifecycleStatus: assistant.lifecycleStatus,
            blocked,
            // "working" once the assistant is provisioned and active.
            working: assistant.isActive && assistant.provisioningStatus === 'complete',
            workingSince: assistant.updatedAt,
            // US5 AC5.2: non-null only when system_paused — { kind, services }.
            attention,
            // US3 AC3.1: Kick-Off summary — what the user reviews before confirming.
            summary: {
                name: assistant.name,
                directive: assistant.role || 'Digital Assistant',
                connections,
            },
            items,
            allRequiredDone,
        };
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const idParam = event.queryStringParameters?.id;
    const assistantId = idParam ? parseInt(idParam, 10) : NaN;
    if (!assistantId || Number.isNaN(assistantId)) {
        return json(400, { error: 'id parameter is required.' });
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    try {
        const result = await computeAssistantReadiness(db, ctx.organisationId, assistantId);
        if (!result) return json(404, { error: 'Assistant not found.' });
        return json(200, result);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        // Table not yet migrated — degrade gracefully rather than 500.
        if (msg.includes('relation') && msg.includes('does not exist')) {
            return json(200, { assistantId, items: [], allRequiredDone: false, working: false });
        }
        console.error('[get-assistant-readiness]', err);
        return json(500, { error: 'Failed to load readiness.' });
    }
};
