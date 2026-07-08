// suppression-sync.ts — Integration Scenario Library, Scenario Type C ("Suppression
// List" sync: external CRM ➔ BMS). Scheduled daily (see netlify.toml).
//
// For every enabled suppression_sync recipe it pulls the tenant's active client domains
// from the external CRM and upserts them into suppression_list, so the autonomous
// discovery AI never prospects an existing customer. Domains are normalised exactly like
// discovered_leads (via normaliseDomain) so the discovery guard is a plain join.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { activeScenarios, integrationScenarios, suppressionList, workspaceIntegrations } from '../../db/schema';
import { getFreshAccessToken, isIntegrationProvider, type IntegrationProvider } from '../../src/utils/workspace-integrations';
import { normaliseDomain } from '../../src/utils/scenario-engine';
import { logApiCall } from '../../src/utils/vault';

type Db = ReturnType<typeof getDb>;

// Per-provider client-domain fetchers. Adding a provider = one entry here; the drain loop
// below is provider-agnostic. Each returns the domains of the tenant's existing customers.
type DomainFetcher = (db: Db, userId: number, organisationId: number) => Promise<string[]>;

const DOMAIN_FETCHERS: Record<string, DomainFetcher> = {
    hubspot: async (db, userId, organisationId) => {
        const { accessToken } = await getFreshAccessToken(db, organisationId, 'hubspot');
        const domains: string[] = [];
        let after: string | undefined;
        // Page through companies whose lifecyclestage is 'customer'.
        for (let page = 0; page < 20; page++) {
            const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] }],
                    properties: ['domain'],
                    limit: 100,
                    ...(after ? { after } : {}),
                }),
            });
            await logApiCall(db, { userId, endpoint: 'hubapi.com/crm/v3/objects/companies/search', httpStatus: res.status });
            if (!res.ok) break;
            const data: { results?: Array<{ properties?: { domain?: string } }>; paging?: { next?: { after?: string } } } = await res.json().catch(() => ({}));
            for (const r of data.results ?? []) {
                if (r.properties?.domain) domains.push(r.properties.domain);
            }
            after = data.paging?.next?.after;
            if (!after) break;
        }
        return domains;
    },
    // salesforce / pipedrive / … register here as they are built.
};

async function resolveActorUserId(db: Db, organisationId: number, integrationId: number | null): Promise<number | null> {
    if (integrationId == null) return null;
    const [wi] = await db.select({ connectedBy: workspaceIntegrations.connectedBy })
        .from(workspaceIntegrations).where(eq(workspaceIntegrations.id, integrationId)).limit(1);
    return wi?.connectedBy ?? null;
}

export const handler: Handler = async () => {
    const db = getDb();

    const recipes = await db
        .select({ active: activeScenarios, scenario: integrationScenarios })
        .from(activeScenarios)
        .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
        .where(and(
            eq(activeScenarios.isEnabled, true),
            eq(integrationScenarios.scenarioType, 'suppression_sync'),
        ));

    let synced = 0, added = 0, skipped = 0;

    for (const { active, scenario } of recipes) {
        const providerKey = scenario.providerKey;
        const fetcher = DOMAIN_FETCHERS[providerKey];
        if (!fetcher || !isIntegrationProvider(providerKey as IntegrationProvider)) { skipped++; continue; }

        const userId = await resolveActorUserId(db, active.organisationId, active.integrationId);
        if (userId == null) { skipped++; continue; }

        try {
            const raw = await fetcher(db, userId, active.organisationId);
            const domains = [...new Set(raw.map(normaliseDomain).filter(Boolean))];
            for (const domain of domains) {
                const inserted = await db.insert(suppressionList).values({
                    organisationId: active.organisationId,
                    domain,
                    reason: 'existing_customer',
                    source: 'crm_sync',
                    sourceScenarioId: active.id,
                }).onConflictDoNothing({ target: [suppressionList.organisationId, suppressionList.domain] }).returning({ id: suppressionList.id });
                if (inserted.length > 0) added++;
            }
            await db.update(activeScenarios).set({ lastFiredAt: new Date() }).where(eq(activeScenarios.id, active.id));
            synced++;
        } catch (err) {
            console.error(`[suppression-sync] recipe ${active.id} (${providerKey}) failed:`, err);
            skipped++;
        }
    }

    return { statusCode: 200, body: JSON.stringify({ recipes: recipes.length, synced, domainsAdded: added, skipped }) };
};
