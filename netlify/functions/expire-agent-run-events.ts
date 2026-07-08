// netlify/functions/expire-agent-run-events.ts
// US-GOV-4.2.2: Scheduled daily retention purge for agent_run_events.
// - Deletes agent_run_events older than 6 months (respects legal holds)
// - Retains agentRunSummaries for 2 years
// - Logs purge count, date range, and deletedAt
// Schedule: runs daily at 04:00 UTC

import type { Handler } from '@netlify/functions';
import { and, eq, lt, inArray, notInArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { agentRunEvents, agentRunSummaries, legalHolds, adminAuditLog } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const SIX_MONTHS_MS  = 6  * 30 * 24 * 60 * 60 * 1000;
const TWO_YEARS_MS   = 2  * 365 * 24 * 60 * 60 * 1000;

async function runExpiry() {
    const db = getDb();
    const now = new Date();
    const eventsCutoff   = new Date(now.getTime() - SIX_MONTHS_MS);
    const summaryCutoff  = new Date(now.getTime() - TWO_YEARS_MS);

    // Load all organisations with an active legal hold — exempt from deletion
    const holds = await db.select({ organisationId: legalHolds.organisationId })
        .from(legalHolds)
        .where(eq(legalHolds.isActive, true));
    const heldOrgIds = [...new Set(holds.map(h => h.organisationId))];

    // ── 1. Purge agent_run_events older than 6 months ──────────────────────────
    let eventsDeleted = 0;
    try {
        const conditions: any[] = [lt(agentRunEvents.createdAt, eventsCutoff)];
        if (heldOrgIds.length > 0) {
            conditions.push(notInArray(agentRunEvents.organisationId, heldOrgIds));
        }

        const deleted = await db.delete(agentRunEvents)
            .where(and(...conditions))
            .returning({ id: agentRunEvents.id });
        eventsDeleted = deleted.length;
    } catch (err: any) {
        console.error('[expire-agent-run-events] Event purge failed:', err?.message);
    }

    // ── 2. Purge agentRunSummaries older than 2 years ──────────────────────────
    let summariesDeleted = 0;
    try {
        const sumConditions: any[] = [lt(agentRunSummaries.createdAt, summaryCutoff)];
        if (heldOrgIds.length > 0) {
            sumConditions.push(notInArray(agentRunSummaries.organisationId, heldOrgIds));
        }

        const deleted = await db.delete(agentRunSummaries)
            .where(and(...sumConditions))
            .returning({ id: agentRunSummaries.id });
        summariesDeleted = deleted.length;
    } catch (err: any) {
        console.error('[expire-agent-run-events] Summary purge failed:', err?.message);
    }

    // ── 3. Log the purge run ────────────────────────────────────────────────────
    if (eventsDeleted > 0 || summariesDeleted > 0) {
        await db.insert(adminAuditLog).values({
            adminId: null,
            action: 'retention_purge',
            targetType: 'agent_run_events',
            targetId: null,
            metadata: {
                eventsDeleted,
                summariesDeleted,
                eventsCutoff: eventsCutoff.toISOString(),
                summaryCutoff: summaryCutoff.toISOString(),
                heldOrgIds,
                deletedAt: now.toISOString(),
            },
            ipAddress: 'scheduled_job',
        }).catch(() => {});
    }

    console.log(`[expire-agent-run-events] Purged ${eventsDeleted} events, ${summariesDeleted} summaries. Legal holds exempt: ${heldOrgIds.length} org(s).`);
    return { eventsDeleted, summariesDeleted, heldOrgs: heldOrgIds.length };
}

export default withLambda(async () => {
    const result = await runExpiry();
    return { statusCode: 200, body: JSON.stringify(result) };
});
