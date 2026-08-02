// src/utils/lead-handoff.ts
// The ONE mapping from an approved lead record to an Integration Scenario Library handoff.
//
// Extracted from assistant-records.ts when the Signal Inbox gained a BATCH approve (Phase 1a):
// two approval surfaces now exist, and a lead approved from the inbox must fire exactly the same
// outbound push as one approved from the Review Queue. Duplicating this field mapping would mean
// the two surfaces silently diverge the first time either is edited — the same "two writers, one
// invariant" failure the revenue ledger avoids by having a single recordEvent().
//
// assistant-records.ts keeps its own MEETING branch inline; only the lead path is shared, because
// only the lead path has two callers.
//
// Best-effort by contract: enqueueScenarioTrigger swallows its own errors, and the discovered_leads
// enrichment lookup is wrapped, so approval never fails because a handoff could not be composed.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { discoveredLeads } from '../../db/schema';
import { enqueueScenarioTrigger, type TriggerSubject } from './scenario-engine';

type Db = ReturnType<typeof getDb>;

export interface LeadRecordForHandoff {
    id: number;
    aiAssistantId: number;
    title: string | null;
    status: string | null;
    data: unknown;
}

/**
 * Fire the outbound "Handoff" push for a lead that has just gone live (newStatus QUALIFIED).
 *
 * Field precedence is deliberate: the record's own `data` wins, and the linked discovered_leads row
 * fills gaps. The record is what a human just looked at and may have edited; the discovery row is
 * the canonical machine-collected version. Reversing this would let a stale scrape overwrite a
 * correction someone made in the Review Queue.
 */
export async function enqueueLeadHandoff(db: Db, orgId: number, record: LeadRecordForHandoff): Promise<void> {
    const data = (record.data && typeof record.data === 'object') ? record.data as Record<string, unknown> : {};

    const fields: Record<string, unknown> = {
        company: record.title ?? undefined,
        rating: record.status ?? undefined,
        aiSummary: data.summary ?? data.aiSummary ?? data.reason ?? data.rationale,
        attribution: data.source ?? data.matchedQuery ?? 'Be More Swan',
        contactName: data.contactName ?? data.contact_name,
        contactEmail: data.contactEmail ?? data.email,
        domain: data.domain,
        score: data.score,
    };

    // Leads carry canonical company/contact/score on the linked discovered_leads row.
    try {
        const [dl] = await db.select({
            companyName: discoveredLeads.companyName, domain: discoveredLeads.domain,
            contactName: discoveredLeads.contactName, contactEmail: discoveredLeads.contactEmail,
            score: discoveredLeads.score,
        }).from(discoveredLeads)
            .where(and(eq(discoveredLeads.organisationId, orgId), eq(discoveredLeads.assistantRecordId, record.id)))
            .limit(1);
        if (dl) {
            fields.company = fields.company ?? dl.companyName;
            fields.domain = fields.domain ?? dl.domain;
            fields.contactName = fields.contactName ?? dl.contactName;
            fields.contactEmail = fields.contactEmail ?? dl.contactEmail;
            fields.score = fields.score ?? dl.score;
        }
    } catch { /* discovery not in play for this lead — the record's own data still maps */ }

    const subject: TriggerSubject = { recordType: 'lead', recordId: record.id, newStatus: 'QUALIFIED', fields };
    await enqueueScenarioTrigger(db, {
        organisationId: orgId,
        assistantId: record.aiAssistantId,
        triggerEvent: 'lead.status_changed',
        subject,
    });
}
