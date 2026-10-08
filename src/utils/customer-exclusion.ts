// src/utils/customer-exclusion.ts
// Keep a campaign's lead searches away from companies the business already sells to.
// docs/campaign-orchestrator-plan.md §9.2.
//
// ── Why at RUN time, not when the search is created ─────────────────────────
// A search created by a campaign order can run daily for months. Copying today's customer list
// into its guardrails would freeze it: a deal marked won next week would still be hunted as a
// prospect. So the exclusion is resolved fresh on every run, from two live sources:
//   1. companies marked WON in Conversations (assistant_records.data.dealOutcome — the current
//      truth; the revenue ledger is append-only and may hold a later correction), joined to the
//      domain their lead was discovered under;
//   2. the campaign's own "also leave out" list (campaigns.audience.excludeDomains), for customers
//      the platform never saw — most businesses' customer list predates this product.
//
// ── Which searches it applies to ────────────────────────────────────────────
// Only a search a campaign ORDER points at (run_lead_search creates it, narrow_targeting tightens
// it — both record it as the order's artefact). A search the user built by hand in Find New Leads
// keeps exactly the guardrails they gave it; this module never reaches into it.
//
// ⚠️ It fails OPEN, with a loud log. The alternative — refusing to run the search — would stop a
// campaign over a transient read error, and every discovered lead still lands in a review queue
// for a human to approve before anyone is contacted.

import { and, eq, sql } from 'drizzle-orm';
import { assistantRecords, campaignOrders, campaigns, discoveredLeads, discoveryCampaigns } from '../../db/schema';
import { normaliseAudience, normaliseCompanyDomain } from '../config/campaign-audience';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

/** More customers than this is not a list we hold in a Lambda per run; the newest wins. */
const MAX_CUSTOMER_DOMAINS = 5000;

/** Domains of companies this organisation has marked won. */
export async function wonCustomerDomains(db: Db, organisationId: number): Promise<string[]> {
    const rows = await db
        .selectDistinct({ domain: discoveredLeads.domain })
        .from(discoveredLeads)
        .innerJoin(assistantRecords, eq(assistantRecords.id, discoveredLeads.assistantRecordId))
        .where(and(
            eq(assistantRecords.organisationId, organisationId),
            sql`${assistantRecords.data} -> 'dealOutcome' ->> 'outcome' = 'won'`,
            sql`${discoveredLeads.domain} IS NOT NULL`,
        ))
        .limit(MAX_CUSTOMER_DOMAINS);
    return rows.map((r) => normaliseCompanyDomain(r.domain)).filter((d): d is string => !!d);
}

/**
 * Every domain one discovery search must skip because of the campaigns it serves. [] when it
 * serves none, or none of them asks for an exclusion. Never throws.
 */
export async function campaignExclusionsForSearch(db: Db, discoveryCampaignId: number): Promise<string[]> {
    try {
        const linked = await db
            .selectDistinct({
                organisationId: campaigns.organisationId,
                audience: campaigns.audience,
                excludeExistingCustomers: campaigns.excludeExistingCustomers,
            })
            .from(campaignOrders)
            .innerJoin(campaigns, eq(campaigns.id, campaignOrders.campaignId))
            // The org check is the IDOR guard: an order and the search it names must belong to the
            // same organisation, or a forged artefact id could pull another tenant's customers in.
            .innerJoin(discoveryCampaigns, and(
                eq(discoveryCampaigns.id, campaignOrders.artefactId),
                eq(discoveryCampaigns.organisationId, campaigns.organisationId),
            ))
            .where(and(
                eq(campaignOrders.artefactKind, 'discovery_campaign'),
                eq(campaignOrders.artefactId, discoveryCampaignId),
                // A finished campaign's search may still run on its own cadence; the customers
                // are still customers. Only an archived campaign stops speaking for its searches.
                sql`${campaigns.status} <> 'archived'`,
            ));
        if (!linked.length) return [];

        const out = new Set<string>();
        for (const c of linked) {
            for (const d of normaliseAudience(c.audience)?.excludeDomains ?? []) out.add(d);
        }
        if (linked.some((c) => c.excludeExistingCustomers)) {
            for (const d of await wonCustomerDomains(db, linked[0].organisationId)) out.add(d);
        }
        return [...out];
    } catch (err) {
        console.error('[customer-exclusion] could not resolve exclusions — search runs WITHOUT them', { discoveryCampaignId, err });
        return [];
    }
}

