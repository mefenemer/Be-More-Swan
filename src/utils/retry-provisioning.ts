// src/utils/retry-provisioning.ts
// Re-trigger path for gate-blocked assistants (see db/assistant-provisioning-blocked.sql).
//
// When a user satisfies a precondition that previously blocked provisioning (accepts ToS / DPA,
// adds AI disclosure, etc.), we reset the matching blocked assistants back to 'pending' and re-fire
// provision-assistant-background. That function re-evaluates EVERY gate from scratch, so it either
// advances the assistant to ready_for_work or re-blocks it with whatever is still missing — the
// reset is therefore self-correcting and safe to call broadly.
//
// Fire-and-forget delivery uses the same awaited-fetch-to-a-background-function pattern as
// onboarding.ts (a plain fire-and-forget fetch is dropped on Lambda freeze).

import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { aiAssistants } from '../../db/schema';
import { withUpdatedAt } from '../../db/client';

export interface RetryProvisioningOpts {
    baseUrl: string;
    /** Limit to one assistant (explicit "Retry setup" action). */
    assistantId?: number;
    /** Limit to an org (org-wide gate like DPA). */
    organisationId?: number;
    /** Limit to a user (user-wide gate like ToS). */
    userId?: number;
    /** Which provisioning_status values to retry. Defaults to ['blocked']; the explicit endpoint
     *  also passes 'failed' so a transient provisioning failure can be retried by hand. */
    statuses?: string[];
}

/**
 * Reset the matching blocked/failed assistants to 'pending' and re-fire the background provisioner.
 * Returns the number of assistants re-triggered.
 */
export async function retryBlockedAssistants(
    db: PostgresJsDatabase<any>,
    opts: RetryProvisioningOpts,
): Promise<number> {
    if (!opts.baseUrl) return 0;
    const statuses = opts.statuses?.length ? opts.statuses : ['blocked'];

    const conds = [inArray(aiAssistants.provisioningStatus, statuses)];
    if (opts.assistantId) conds.push(eq(aiAssistants.id, opts.assistantId));
    if (opts.organisationId) conds.push(eq(aiAssistants.organisationId, opts.organisationId));
    if (opts.userId) conds.push(eq(aiAssistants.userId, opts.userId));

    const rows = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(...conds));
    if (!rows.length) return 0;

    // Reset to 'pending' so provision-assistant-background's `provisioning_status = 'pending'`
    // completion guard passes, and clear the stale reason. The trigger re-derives lifecycle as
    // 'provisioning' from the pending state.
    await db.update(aiAssistants)
        .set(withUpdatedAt({ provisioningStatus: 'pending', provisioningBlockedReason: null }))
        .where(and(...conds));

    await Promise.all(rows.map(r =>
        fetch(`${opts.baseUrl}/.netlify/functions/provision-assistant-background`, {
            method: 'POST',
            body: JSON.stringify({ assistantId: r.id }),
        }).catch(() => { /* delivery best-effort; status already reset so a later retry can re-fire */ }),
    ));

    return rows.length;
}
