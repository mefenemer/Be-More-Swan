// integration-scenarios.ts — Integrations Hub API for the Scenario Library.
// Exposed as /api/integrations/:resource (netlify.toml rewrite). All routes are
// org-scoped via requireTenant; active scenarios are scoped PER ASSISTANT.
//
// Resources:
//   GET  /api/integrations/scenarios?assistantId=  → library + this assistant's active state
//   GET  /api/integrations/logs?assistantId=       → recent execution log lines
//   POST /api/integrations/activate                → create/update an active_scenarios row
//   POST /api/integrations/toggle                  → enable/disable an active scenario
//   POST /api/integrations/deactivate              → remove an active scenario
//   POST /api/integrations/upvote                  → Tier-3 roadmap upvote (feature_request_votes)

import { Handler } from '@netlify/functions';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import {
    integrationProviders, integrationScenarios, activeScenarios,
    workspaceIntegrations, integrationApiCalls, featureRequests, featureRequestVotes,
} from '../../db/schema';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Last path segment of the original /api/integrations/:resource URL. */
function resourceOf(event: { rawUrl?: string; path?: string }): string {
    const raw = event.rawUrl || event.path || '';
    const pathOnly = raw.split('?')[0].replace(/\/$/, '');
    return pathOnly.split('/').pop() || '';
}

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    const resource = resourceOf(event);
    const params = event.queryStringParameters || {};
    let body: Record<string, unknown> = {};
    if (event.body) { try { body = JSON.parse(event.body); } catch { return json(400, { error: 'Invalid JSON body.' }); } }

    try {
        // ── GET scenarios: the library, annotated with this assistant's active state ──
        if (event.httpMethod === 'GET' && resource === 'scenarios') {
            const assistantId = Number(params.assistantId) || null;

            const scenarios = await db
                .select({ scenario: integrationScenarios, provider: integrationProviders, roadmapVotes: featureRequests.voteCount })
                .from(integrationScenarios)
                .leftJoin(integrationProviders, eq(integrationScenarios.providerKey, integrationProviders.providerKey))
                .leftJoin(featureRequests, eq(integrationScenarios.roadmapFeatureId, featureRequests.id))
                .orderBy(integrationScenarios.tier, integrationScenarios.sortOrder);

            const active = assistantId
                ? await db.select().from(activeScenarios)
                    .where(and(eq(activeScenarios.organisationId, organisationId), eq(activeScenarios.assistantId, assistantId)))
                : [];
            const activeByScenario = new Map(active.map((a) => [a.scenarioId, a]));

            // Which providers this workspace has connected (for the "Connect first" gate).
            const connected = await db.select({ id: workspaceIntegrations.id, provider: workspaceIntegrations.provider, status: workspaceIntegrations.status })
                .from(workspaceIntegrations).where(eq(workspaceIntegrations.organisationId, organisationId));
            const connectedByProvider = new Map(connected.map((c) => [c.provider, c]));

            return json(200, {
                scenarios: scenarios.map(({ scenario, provider, roadmapVotes }) => ({
                    ...scenario,
                    providerName: provider?.displayName ?? scenario.providerKey,
                    providerCategory: provider?.category ?? null,
                    roadmapVotes: roadmapVotes ?? null,
                    connection: connectedByProvider.get(scenario.providerKey) ?? null,
                    active: activeByScenario.get(scenario.id) ?? null,
                })),
            });
        }

        // ── GET logs: recent execution lines for this assistant's active scenarios ──
        if (event.httpMethod === 'GET' && resource === 'logs') {
            const assistantId = Number(params.assistantId) || null;
            if (!assistantId) return json(400, { error: 'assistantId is required.' });

            const rows = await db
                .select({
                    id: integrationApiCalls.id,
                    endpoint: integrationApiCalls.endpoint,
                    httpStatus: integrationApiCalls.httpStatus,
                    calledAt: integrationApiCalls.calledAt,
                    scenarioTitle: integrationScenarios.title,
                    scenarioKey: integrationScenarios.scenarioKey,
                })
                .from(integrationApiCalls)
                .innerJoin(activeScenarios, eq(integrationApiCalls.activeScenarioId, activeScenarios.id))
                .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
                .where(and(eq(activeScenarios.organisationId, organisationId), eq(activeScenarios.assistantId, assistantId)))
                .orderBy(desc(integrationApiCalls.calledAt))
                .limit(50);
            return json(200, { logs: rows });
        }

        // ── POST activate: turn a recipe on (or update its mapping) for an assistant ──
        if (event.httpMethod === 'POST' && resource === 'activate') {
            const scenarioId = Number(body.scenarioId);
            const assistantId = Number(body.assistantId);
            if (!scenarioId || !assistantId) return json(400, { error: 'scenarioId and assistantId are required.' });

            const [scenario] = await db.select().from(integrationScenarios).where(eq(integrationScenarios.id, scenarioId)).limit(1);
            if (!scenario) return json(404, { error: 'Scenario not found.' });
            if (scenario.tier === 3 || scenario.status !== 'available') return json(409, { error: 'This scenario is on the roadmap and cannot be activated yet.' });

            const integrationId = body.integrationId != null ? Number(body.integrationId) : null;
            const webhookUrl = typeof body.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : null;
            const fieldMappings = (body.fieldMappings && typeof body.fieldMappings === 'object') ? body.fieldMappings as Record<string, unknown> : {};

            // Tier-1 native recipes need a connected OAuth grant; Tier-2 needs a webhook URL.
            if (scenario.tier === 2) {
                if (!webhookUrl) return json(400, { error: 'A webhook URL is required for this scenario.' });
            } else if (!integrationId) {
                return json(400, { error: `Connect ${scenario.providerKey} first, then activate this scenario.` });
            }

            // Verify the chosen connection belongs to this org.
            if (integrationId) {
                const [wi] = await db.select({ id: workspaceIntegrations.id }).from(workspaceIntegrations)
                    .where(and(eq(workspaceIntegrations.id, integrationId), eq(workspaceIntegrations.organisationId, organisationId))).limit(1);
                if (!wi) return json(403, { error: 'That connection does not belong to your workspace.' });
            }

            const [row] = await db.insert(activeScenarios).values({
                organisationId, assistantId, scenarioId, integrationId, webhookUrl, fieldMappings, isEnabled: true,
            }).onConflictDoUpdate({
                target: [activeScenarios.assistantId, activeScenarios.scenarioId],
                set: { integrationId, webhookUrl, fieldMappings, isEnabled: true, updatedAt: new Date() },
            }).returning();
            return json(200, { active: row });
        }

        // ── POST toggle: enable/disable ──
        if (event.httpMethod === 'POST' && resource === 'toggle') {
            const id = Number(body.activeScenarioId);
            const isEnabled = Boolean(body.isEnabled);
            if (!id) return json(400, { error: 'activeScenarioId is required.' });
            const [row] = await db.update(activeScenarios).set({ isEnabled, updatedAt: new Date() })
                .where(and(eq(activeScenarios.id, id), eq(activeScenarios.organisationId, organisationId))).returning();
            if (!row) return json(404, { error: 'Active scenario not found.' });
            return json(200, { active: row });
        }

        // ── POST deactivate: remove ──
        if (event.httpMethod === 'POST' && resource === 'deactivate') {
            const id = Number(body.activeScenarioId);
            if (!id) return json(400, { error: 'activeScenarioId is required.' });
            await db.delete(activeScenarios).where(and(eq(activeScenarios.id, id), eq(activeScenarios.organisationId, organisationId)));
            return json(200, { success: true });
        }

        // ── POST upvote: Tier-3 roadmap vote via the existing feature-request system ──
        if (event.httpMethod === 'POST' && resource === 'upvote') {
            const scenarioId = Number(body.scenarioId);
            if (!scenarioId) return json(400, { error: 'scenarioId is required.' });
            const [scenario] = await db.select().from(integrationScenarios).where(eq(integrationScenarios.id, scenarioId)).limit(1);
            if (!scenario?.roadmapFeatureId) return json(409, { error: 'This scenario has no roadmap entry to upvote.' });

            const inserted = await db.insert(featureRequestVotes)
                .values({ featureId: scenario.roadmapFeatureId, userId })
                .onConflictDoNothing({ target: [featureRequestVotes.featureId, featureRequestVotes.userId] })
                .returning({ id: featureRequestVotes.id });
            if (inserted.length > 0) {
                await db.update(featureRequests).set({ voteCount: sql`${featureRequests.voteCount} + 1` })
                    .where(eq(featureRequests.id, scenario.roadmapFeatureId));
            }
            const [fr] = await db.select({ voteCount: featureRequests.voteCount }).from(featureRequests).where(eq(featureRequests.id, scenario.roadmapFeatureId)).limit(1);
            return json(200, { voted: true, voteCount: fr?.voteCount ?? 0, alreadyVoted: inserted.length === 0 });
        }

        return json(404, { error: `Unknown integrations resource "${resource}".` });
    } catch (err) {
        console.error('[integration-scenarios] failure:', err);
        return json(500, { error: 'The Integrations Hub request failed unexpectedly.' });
    }
};
