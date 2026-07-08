// process-webhook-events.ts — downstream consumer for the webhook intake layer.
// Scheduled (see netlify.toml) and also POST-invokable for manual draining.
//
// For each `received` event: claim it atomically, resolve the owning assistant (via the
// connection's assistantId), enforce the connection-map sandbox
// (isServiceAllowedForAssistant) BEFORE any handler runs, then dispatch to the
// provider/eventType handler. No connectors are wired yet, so unhandled events are marked
// 'ignored' — connectors plug in by adding a handler to WEBHOOK_HANDLERS.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { webhookEvents, systemConnections, activeScenarios, integrationScenarios, discoveredLeads } from '../../db/schema';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';
import { normaliseDomain } from '../../src/utils/scenario-engine';
import { withLambda } from '@netlify/aws-lambda-compat';

const BATCH = 50;

type Db = ReturnType<typeof getDb>;
type WebhookEvent = typeof webhookEvents.$inferSelect;

// ── Integration Scenario Library — inbound "Feedback Loop" (Scenario Type B) ─────
// A CRM deal-stage webhook (HubSpot/Salesforce) lands in webhook_events; if the tenant
// has an enabled inbound recipe for that provider, we reverse-map the external stage to a
// BMS outcome (CLOSED_WON/CLOSED_LOST) and record it on the matching discovered_lead so
// the discovery AI learns which prospects actually converted. Runs BEFORE the legacy
// systemConnections routing; returns true when it owned the event.

/** Read a dot-path (e.g. 'properties.dealstage') out of an arbitrary payload. */
function readPath(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[key] : undefined, obj);
}

interface FeedbackTriggerConfig {
    on?: string;
    stagePath?: string;
    identifierPath?: string;
    stageMap?: Record<string, string>;
}

async function handleFeedbackLoop(db: Db, ev: WebhookEvent): Promise<boolean> {
    if (ev.organisationId == null) return false;

    // Enabled inbound recipes for this org + provider.
    const recipes = await db
        .select({ active: activeScenarios, scenario: integrationScenarios })
        .from(activeScenarios)
        .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
        .where(and(
            eq(activeScenarios.organisationId, ev.organisationId),
            eq(activeScenarios.isEnabled, true),
            eq(integrationScenarios.providerKey, ev.provider),
            eq(integrationScenarios.scenarioType, 'feedback_loop'),
        ));
    if (recipes.length === 0) return false;

    for (const { scenario } of recipes) {
        const cfg = (scenario.triggerConfig ?? {}) as FeedbackTriggerConfig;
        const stageRaw = String(readPath(ev.payload, cfg.stagePath ?? 'properties.dealstage') ?? '').trim().toLowerCase();
        const outcome = cfg.stageMap?.[stageRaw];
        if (!outcome) continue; // stage not a terminal outcome we track

        const identifier = String(readPath(ev.payload, cfg.identifierPath ?? 'properties.email') ?? '').trim();
        if (!identifier) continue;

        // Match the discovered lead by email (exact) or normalised domain.
        const isEmail = identifier.includes('@');
        const domain = normaliseDomain(isEmail ? identifier.split('@')[1] : identifier);
        const [lead] = await db.select().from(discoveredLeads)
            .where(and(
                eq(discoveredLeads.organisationId, ev.organisationId),
                isEmail ? eq(discoveredLeads.contactEmail, identifier) : eq(discoveredLeads.domain, domain),
            )).limit(1);
        if (!lead) continue;

        const signals = { ...((lead.signals as Record<string, unknown>) ?? {}), crmOutcome: outcome, crmStage: stageRaw, outcomeAt: new Date().toISOString() };
        await db.update(discoveredLeads)
            .set({ signals, updatedAt: new Date() })
            .where(eq(discoveredLeads.id, lead.id));
    }
    return true;
}

// Connector handlers register here, keyed by provider. A handler only runs AFTER the
// sandbox check passes. Throw to mark the event 'failed' (kept for inspection/retry).
const WEBHOOK_HANDLERS: Record<string, (event: WebhookEvent) => Promise<void>> = {
    // slack:   async (event) => { ... },
    // zendesk: async (event) => { ... },
};

async function finish(db: ReturnType<typeof getDb>, id: number, status: 'processed' | 'ignored' | 'failed', error?: string) {
    await db.update(webhookEvents)
        .set({ status, error: error ?? null, processedAt: new Date() })
        .where(eq(webhookEvents.id, id));
}

export default withLambda(async () => {
    const db = getDb();

    const pending = await db.select().from(webhookEvents)
        .where(eq(webhookEvents.status, 'received'))
        .orderBy(webhookEvents.receivedAt)
        .limit(BATCH);

    let processed = 0, ignored = 0, failed = 0;

    for (const ev of pending) {
        // Atomic claim — only one runner may move a row out of 'received'.
        const claimed = await db.update(webhookEvents)
            .set({ status: 'processing' })
            .where(and(eq(webhookEvents.id, ev.id), eq(webhookEvents.status, 'received')))
            .returning({ id: webhookEvents.id });
        if (claimed.length === 0) continue; // another runner took it

        try {
            // Integration Scenario Library feedback loop (Type B) — owns CRM deal-stage
            // events when the tenant has an enabled inbound recipe; workspace-integration
            // based, so it runs before the systemConnections routing below.
            if (await handleFeedbackLoop(db, ev)) { await finish(db, ev.id, 'processed'); processed++; continue; }

            // Route to the owning assistant via the connection.
            if (!ev.connectionId) { await finish(db, ev.id, 'ignored', 'no_connection'); ignored++; continue; }
            const [conn] = await db.select({
                assistantId: systemConnections.assistantId,
                organisationId: systemConnections.organisationId,
            }).from(systemConnections).where(eq(systemConnections.id, ev.connectionId)).limit(1);

            if (!conn?.assistantId) { await finish(db, ev.id, 'ignored', 'no_assistant'); ignored++; continue; }

            // Sandbox: the assistant's role must permit this provider's connection.
            const assistant = await resolveAssistantRole(db, conn.organisationId, conn.assistantId);
            if (!assistant || !isServiceAllowedForAssistant(ev.provider, assistant)) {
                await finish(db, ev.id, 'ignored', 'sandbox_denied'); ignored++; continue;
            }

            const handlerFn = WEBHOOK_HANDLERS[ev.provider];
            if (!handlerFn) { await finish(db, ev.id, 'ignored', 'no_handler'); ignored++; continue; }

            await handlerFn(ev);
            await finish(db, ev.id, 'processed'); processed++;
        } catch (err) {
            console.error(`[process-webhook-events] event ${ev.id} failed:`, err);
            await finish(db, ev.id, 'failed', (err as Error)?.message?.slice(0, 500) ?? 'error'); failed++;
        }
    }

    return { statusCode: 200, body: JSON.stringify({ claimed: pending.length, processed, ignored, failed }) };
});
