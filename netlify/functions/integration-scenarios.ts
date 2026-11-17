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
//   GET  /api/integrations/options?picker=         → choices for a recipe setting (Jira/Asana projects,
//                                                    Slack channels) from the workspace's connection
//
// Recipes listed in src/config/recipe-settings.ts carry their real settings (pickers) and plain-words
// description instead of the catalogue's field-mapping form, and only ONE task tool (Jira or Asana) can
// be switched on per assistant: switching one on switches the other off.

import { Handler } from '@netlify/functions';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import {
    integrationProviders, integrationScenarios, activeScenarios,
    workspaceIntegrations, integrationApiCalls, featureRequests, featureRequestVotes,
} from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';
import {
    PICKER_PROVIDER, RECIPE_DESCRIPTIONS, RECIPE_SETTINGS, TASK_TOOL_RECIPES, cleanRecipeSettings, type RecipePicker,
} from '../../src/config/recipe-settings';
import { getFreshAccessToken, IntegrationError } from '../../src/utils/workspace-integrations';
import { listAsanaProjects, listJiraProjects } from '../../src/utils/pm-tickets';
import { listSlackChannels } from '../../src/utils/slack-channels';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Providers whose Tier-1 recipes activate without a connected integration: they resolve a
// connection at run time if one exists (e.g. Gmail) and otherwise use a built-in fallback,
// so the library must not gate them behind a "Connect first" step.
const CONNECTION_OPTIONAL_PROVIDERS = new Set(['email']);

/** Last path segment of the original /api/integrations/:resource URL. */
function resourceOf(event: { rawUrl?: string; path?: string }): string {
    const raw = event.rawUrl || event.path || '';
    const pathOnly = raw.split('?')[0].replace(/\/$/, '');
    return pathOnly.split('/').pop() || '';
}

/**
 * One task tool per assistant: switch off the OTHER task-tool recipes it has on. Returns the titles
 * switched off, so the page can say so ("Tasks now go to Asana; Jira is off").
 */
async function switchOffOtherTaskTools(db: ReturnType<typeof getDb>, organisationId: number, assistantId: number, keepScenarioId: number): Promise<string[]> {
    const others = await db.select({ id: integrationScenarios.id, title: integrationScenarios.title, key: integrationScenarios.scenarioKey })
        .from(integrationScenarios).where(inArray(integrationScenarios.scenarioKey, [...TASK_TOOL_RECIPES]));
    const ids = others.filter((o) => o.id !== keepScenarioId).map((o) => o.id);
    if (!ids.length) return [];
    const off = await db.update(activeScenarios).set({ isEnabled: false, updatedAt: new Date() })
        .where(and(
            eq(activeScenarios.organisationId, organisationId),
            eq(activeScenarios.assistantId, assistantId),
            inArray(activeScenarios.scenarioId, ids),
            eq(activeScenarios.isEnabled, true),
        )).returning({ scenarioId: activeScenarios.scenarioId });
    return off.map((o) => others.find((x) => x.id === o.scenarioId)?.title ?? 'the other task tool');
}

export default withLambda(async (event) => {
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
                    // Code-defined settings (pickers) and wording for the recipes the code reads them from.
                    description: RECIPE_DESCRIPTIONS[scenario.scenarioKey] ?? scenario.description,
                    settings: RECIPE_SETTINGS[scenario.scenarioKey] ?? null,
                    taskTool: TASK_TOOL_RECIPES.includes(scenario.scenarioKey),
                    providerName: provider?.displayName ?? scenario.providerKey,
                    providerCategory: provider?.category ?? null,
                    roadmapVotes: roadmapVotes ?? null,
                    connection: connectedByProvider.get(scenario.providerKey) ?? null,
                    connectionOptional: CONNECTION_OPTIONAL_PROVIDERS.has(scenario.providerKey),
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

        // ── GET options: the choices for a recipe setting, read from the workspace's own connection ──
        if (event.httpMethod === 'GET' && resource === 'options') {
            const picker = String(params.picker || '') as RecipePicker;
            const provider = PICKER_PROVIDER[picker];
            if (!provider) return json(400, { error: 'Unknown picker.' });
            try {
                const token = await getFreshAccessToken(db, organisationId, provider);
                if (picker === 'jira_projects') {
                    const projects = await listJiraProjects(token.accessToken, token.tenantId ?? null);
                    return json(200, { options: projects.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })) });
                }
                if (picker === 'asana_projects') {
                    const projects = await listAsanaProjects(token.accessToken);
                    return json(200, { options: projects.map((p) => ({ value: p.id, label: p.name })) });
                }
                const channels = await listSlackChannels(token.accessToken);
                return json(200, { options: channels.map((c) => ({ value: c.value, label: c.main ? `${c.label} (main channel)` : c.label, main: c.main })) });
            } catch (err) {
                if (err instanceof IntegrationError) return json(409, { error: `Connect ${provider === 'jira' ? 'Jira' : provider === 'asana' ? 'Asana' : 'Slack'} first.`, code: 'not_connected' });
                console.error('[integration-scenarios] options failed', picker, err);
                return json(502, { error: 'Couldn’t read the list from that tool just now. Try again in a moment.' });
            }
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
            let fieldMappings = (body.fieldMappings && typeof body.fieldMappings === 'object') ? body.fieldMappings as Record<string, unknown> : {};
            // A recipe with code-defined settings saves only those (a Jira key upper-cased, required ones present).
            if (RECIPE_SETTINGS[scenario.scenarioKey]) {
                const cleaned = cleanRecipeSettings(scenario.scenarioKey, fieldMappings);
                if (!cleaned.ok) return json(400, { error: cleaned.error });
                fieldMappings = cleaned.mappings;
            }

            // Tier-1 native recipes need a connected OAuth grant; Tier-2 needs a webhook URL.
            // Connection-optional providers (e.g. email) activate with neither — they resolve a
            // connection at run time or fall back to a built-in sender.
            if (scenario.tier === 2) {
                if (!webhookUrl) return json(400, { error: 'A webhook URL is required for this scenario.' });
            } else if (!integrationId && !CONNECTION_OPTIONAL_PROVIDERS.has(scenario.providerKey)) {
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
            const switchedOff = TASK_TOOL_RECIPES.includes(scenario.scenarioKey)
                ? await switchOffOtherTaskTools(db, organisationId, assistantId, scenario.id)
                : [];
            return json(200, { active: row, switchedOff });
        }

        // ── POST toggle: enable/disable ──
        if (event.httpMethod === 'POST' && resource === 'toggle') {
            const id = Number(body.activeScenarioId);
            const isEnabled = Boolean(body.isEnabled);
            if (!id) return json(400, { error: 'activeScenarioId is required.' });
            const [row] = await db.update(activeScenarios).set({ isEnabled, updatedAt: new Date() })
                .where(and(eq(activeScenarios.id, id), eq(activeScenarios.organisationId, organisationId))).returning();
            if (!row) return json(404, { error: 'Active scenario not found.' });
            let switchedOff: string[] = [];
            if (isEnabled) {
                const [sc] = await db.select({ key: integrationScenarios.scenarioKey }).from(integrationScenarios).where(eq(integrationScenarios.id, row.scenarioId)).limit(1);
                if (sc && TASK_TOOL_RECIPES.includes(sc.key)) switchedOff = await switchOffOtherTaskTools(db, organisationId, row.assistantId, row.scenarioId);
            }
            return json(200, { active: row, switchedOff });
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
});
