// Meeting follow-ups go ONLY from the user's own Gmail or Outlook (owner, 2026-11-17): "if they do not connect
// Outlook or Gmail then they cannot email". Be More Swan never sends an email for a customer from its own
// domain, so the follow-up action can't be switched on, and the chat's approve card warns, until a mailbox
// is connected. One check for the Connections list, the save/toggle gate and the chat card.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { activeScenarios, integrationScenarios, workspaceIntegrations } from '../../db/schema';
import { MAILBOX_PROVIDERS } from './connection-map';

type Db = ReturnType<typeof getDb>;

/** The recipe provider whose actions send email — they need a connected mailbox, not a provider grant of their own. */
export const MAILBOX_RECIPE_PROVIDER = 'email';

/** What the page and the server say when no mailbox is connected. */
export const NO_MAILBOX_MESSAGE = 'Connect Gmail or Outlook first — follow-ups are only sent from your own inbox.';

/** The workspace's connected Gmail or Outlook (first found), or null. */
export async function connectedMailbox(db: Db, organisationId: number): Promise<{ id: number; provider: string; status: string } | null> {
    const rows = await db.select({ id: workspaceIntegrations.id, provider: workspaceIntegrations.provider, status: workspaceIntegrations.status })
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, organisationId),
            inArray(workspaceIntegrations.provider, [...MAILBOX_PROVIDERS]),
            eq(workspaceIntegrations.status, 'active'),
        ));
    return rows.find((r) => r.provider === 'gmail') ?? rows[0] ?? null;
}

/**
 * True when this assistant's follow-up action is switched on but no mailbox is connected — approving a
 * meeting would not send the follow-up. False on any read failure (the warning is advisory; the send
 * itself refuses without a mailbox).
 */
export async function followupBlockedByNoMailbox(db: Db, organisationId: number, assistantId: number): Promise<boolean> {
    try {
        const [on] = await db.select({ id: activeScenarios.id })
            .from(activeScenarios)
            .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
            .where(and(
                eq(activeScenarios.organisationId, organisationId),
                eq(activeScenarios.assistantId, assistantId),
                eq(activeScenarios.isEnabled, true),
                eq(integrationScenarios.providerKey, MAILBOX_RECIPE_PROVIDER),
            )).limit(1);
        if (!on) return false;
        return !(await connectedMailbox(db, organisationId));
    } catch (err) {
        console.error('[mailbox-connected] could not check the follow-up mailbox (non-fatal)', err);
        return false;
    }
}
