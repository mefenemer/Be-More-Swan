// src/utils/goal-connections.ts
// Which third-party services an organisation has connected, as goal metrics need them — moved out of
// manage-goals.ts (2026-10-22) so the chat's goal card (src/utils/chat-goals.ts) gates a metric on
// exactly the same rule as the endpoint the click calls: a card can never offer a goal the Results tab
// would refuse with "Connect X first".

import { and, eq } from 'drizzle-orm';
import { systemConnections, workspaceIntegrations } from '../../db/schema';

/** Active third-party services connected for this org (lowercased serviceName). */
export async function connectedServices(db: any, orgId: number): Promise<string[]> {
    const rows = await db
        .selectDistinct({ serviceName: systemConnections.serviceName })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ));

    // Connections live in TWO tables. Social accounts (instagram, linkedin, x…) are rows in
    // system_connections; everything OAuthed through the integrations directory — Search Console,
    // HubSpot, Xero, Gmail… — is a workspace_integrations row keyed by `provider`. Gating only on
    // system_connections meant a metric backed by an integration could never become available no
    // matter what the user connected, which is why `search_clicks` needs this union.
    const integrations = await db
        .selectDistinct({ provider: workspaceIntegrations.provider })
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, orgId),
            eq(workspaceIntegrations.status, 'active'),
        ));

    return [
        ...rows.map((r: any) => String(r.serviceName).toLowerCase()),
        ...integrations.map((r: any) => String(r.provider).toLowerCase()),
    ];
}
