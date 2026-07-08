// src/utils/scenario-engine.ts
// Integration Scenario Library — the shared engine used by the outbound job processor
// (process-scenario-jobs.ts), the inbound feedback loop (process-webhook-events.ts) and
// the suppression sync (suppression-sync.ts).
//
// The library reuses existing primitives: workspace_integrations for the OAuth grant,
// the sync-action ACTION_HANDLERS registry for outbound execution, and webhook_events
// for inbound intake. This module only adds the recipe glue: enqueue a trigger, match
// enabled recipes, and map BMS fields ⇆ external fields per the user's stored JSONB map.
//
// Design: docs/integration-scenario-library-plan.md.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { activeScenarios, integrationScenarios, scenarioJobs } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// Canonical BMS outbound trigger events (extend as new triggers are added).
export type TriggerEvent = 'lead.status_changed';

export interface TriggerSubject {
    recordType: string;                  // 'lead'
    recordId?: number;                   // assistant_records.id / discovered_leads.id
    newStatus?: string;                  // 'QUALIFIED' | 'MEETING_BOOKED' | 'CLOSED_WON' | 'CLOSED_LOST'
    // Flat bag of BMS canonical fields recipes map FROM (e.g. company, contactEmail, aiSummary).
    fields: Record<string, unknown>;
}

/** Normalise a domain the SAME way discovered_leads does: lowercase, strip protocol,
 *  path and a leading www. Shared by the suppression sync and the discovery guard. */
export function normaliseDomain(input: string): string {
    return String(input)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '')
        .replace(/[^a-z0-9.-]/g, '');
}

/**
 * Enqueue an outbound scenario job. Call this at the BMS write-path seam where a lead
 * changes status (e.g. the Review Queue approval handler). Fire-and-forget by design:
 * it never throws into the caller — a failed enqueue must never fail the user's action.
 */
export async function enqueueScenarioTrigger(
    db: Db,
    input: { organisationId: number; assistantId: number | null; triggerEvent: TriggerEvent; subject: TriggerSubject },
): Promise<void> {
    try {
        await db.insert(scenarioJobs).values({
            jobId: `scn_${input.organisationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            organisationId: input.organisationId,
            assistantId: input.assistantId ?? null,
            triggerEvent: input.triggerEvent,
            subject: input.subject as unknown as Record<string, unknown>,
            status: 'queued',
        });
    } catch (err) {
        console.error('[scenario-engine] enqueue failed (non-fatal):', err);
    }
}

// ── Recipe matching ─────────────────────────────────────────────────────────────

export interface MatchedScenario {
    active: typeof activeScenarios.$inferSelect;
    scenario: typeof integrationScenarios.$inferSelect;
}

interface TriggerConfig { on?: string; when?: string[] }

/**
 * Resolve the enabled outbound recipes that should fire for a job: the tenant's
 * active_scenarios (scoped to the job's assistant) whose scenario is an outbound/two-way
 * handoff and whose trigger_config matches the event + status. Filtering the `when`
 * array is done in JS (small N per assistant) rather than a jsonb query for clarity.
 */
export async function getMatchingOutboundScenarios(
    db: Db,
    organisationId: number,
    assistantId: number | null,
    triggerEvent: string,
    newStatus: string | undefined,
): Promise<MatchedScenario[]> {
    const where = assistantId != null
        ? and(eq(activeScenarios.organisationId, organisationId), eq(activeScenarios.isEnabled, true), eq(activeScenarios.assistantId, assistantId))
        : and(eq(activeScenarios.organisationId, organisationId), eq(activeScenarios.isEnabled, true));

    const rows = await db
        .select({ active: activeScenarios, scenario: integrationScenarios })
        .from(activeScenarios)
        .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
        .where(where);

    return rows.filter(({ scenario }) => {
        if (scenario.direction !== 'outbound' && scenario.direction !== 'two_way') return false;
        if (scenario.scenarioType !== 'handoff_push') return false;
        const cfg = (scenario.triggerConfig ?? {}) as TriggerConfig;
        if (cfg.on && cfg.on !== triggerEvent) return false;
        if (Array.isArray(cfg.when) && cfg.when.length > 0) {
            return newStatus != null && cfg.when.includes(newStatus);
        }
        return true;
    });
}

// ── Field mapping ───────────────────────────────────────────────────────────────

interface DiffFieldOut { fieldName: string; propertyName: string; newValue: unknown }

/**
 * Build the `data_diff_view`-shaped payload that the record-update ACTION_HANDLERS
 * (hubspot_update_record / salesforce_update_record) consume, applying the user's
 * field map: fieldMappings maps a BMS field name → the external property name.
 * Identity fields (recordName/recordEmail/objectType) are taken from the subject.
 */
export function buildDiffPayload(
    subject: TriggerSubject,
    fieldMappings: Record<string, unknown>,
): Record<string, unknown> {
    const f = subject.fields ?? {};
    const fields: DiffFieldOut[] = Object.entries(fieldMappings)
        .filter(([bmsField]) => f[bmsField] !== undefined && f[bmsField] !== null && f[bmsField] !== '')
        .map(([bmsField, propertyName]) => ({
            fieldName: bmsField,
            propertyName: String(propertyName),
            newValue: f[bmsField],
        }));

    return {
        recordName: f.company ?? f.companyName ?? f.contactName ?? f.name ?? '',
        recordEmail: f.contactEmail ?? f.email ?? '',
        objectType: (f.contactEmail ?? f.email) ? 'contact' : 'company',
        fields,
    };
}

/**
 * Build a flat mapped object for the Tier-2 universal webhook: each mapped BMS field is
 * emitted under its external key, plus a small standard envelope so downstream Zapier /
 * Make scenarios have stable context.
 */
export function buildWebhookPayload(
    subject: TriggerSubject,
    fieldMappings: Record<string, unknown>,
): Record<string, unknown> {
    const f = subject.fields ?? {};
    const mapped: Record<string, unknown> = {};
    for (const [bmsField, externalKey] of Object.entries(fieldMappings)) {
        if (f[bmsField] !== undefined) mapped[String(externalKey)] = f[bmsField];
    }
    return {
        event: 'lead.status_changed',
        status: subject.newStatus ?? null,
        recordType: subject.recordType,
        recordId: subject.recordId ?? null,
        data: mapped,
    };
}
