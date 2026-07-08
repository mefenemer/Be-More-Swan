// process-scenario-jobs.ts — outbound drain for the Integration Scenario Library
// (Scenario Type A, "Handoff" push: BMS ➔ external tool).
//
// Scheduled every minute (see netlify.toml) and POST-invokable for manual draining,
// mirroring process-discovery-jobs. For each queued scenario_jobs row it:
//   1. atomically claims the row,
//   2. resolves the tenant's enabled outbound recipes for the job's assistant + trigger,
//   3. maps the subject → payload per each recipe's stored field map, and
//   4. executes it — Tier 1 via the shared ACTION_HANDLERS registry (runAction), Tier 2
//      by POSTing the mapped payload to the recipe's universal webhook URL.
// Partial failures retry with backoff (attempt/next_retry_at); a job only fails terminally
// after max_attempts.

import { Handler } from '@netlify/functions';
import { and, eq, lte, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { activeScenarios, scenarioJobs, users, workspaceIntegrations } from '../../db/schema';
import { runAction } from './sync-action';
import {
    getMatchingOutboundScenarios,
    buildActionPayload,
    buildWebhookPayload,
    type TriggerSubject,
} from '../../src/utils/scenario-engine';
import { logApiCall } from '../../src/utils/vault';

const BATCH = 25;
const RETRY_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes between attempts

type Db = ReturnType<typeof getDb>;

/** A valid user id is required for the integration_api_calls audit row. Prefer the
 *  integration's connector; fall back to any member of the org. */
async function resolveActorUserId(db: Db, organisationId: number, integrationId: number | null): Promise<number | null> {
    if (integrationId != null) {
        const [wi] = await db.select({ connectedBy: workspaceIntegrations.connectedBy })
            .from(workspaceIntegrations).where(eq(workspaceIntegrations.id, integrationId)).limit(1);
        if (wi?.connectedBy) return wi.connectedBy;
    }
    const [u] = await db.select({ id: users.id }).from(users)
        .where(eq(users.organisationId, organisationId)).orderBy(users.id).limit(1);
    return u?.id ?? null;
}

async function fail(db: Db, job: typeof scenarioJobs.$inferSelect, message: string) {
    const attempt = job.attempt + 1;
    const terminal = attempt >= job.maxAttempts;
    await db.update(scenarioJobs).set({
        status: terminal ? 'failed' : 'queued',
        attempt,
        nextRetryAt: terminal ? null : new Date(Date.now() + RETRY_BACKOFF_MS),
        errorMessage: message.slice(0, 500),
        updatedAt: new Date(),
    }).where(eq(scenarioJobs.id, job.id));
}

async function processJob(db: Db, job: typeof scenarioJobs.$inferSelect): Promise<'completed' | 'retried' | 'failed'> {
    const subject = (job.subject ?? {}) as unknown as TriggerSubject;
    const matches = await getMatchingOutboundScenarios(
        db, job.organisationId, job.assistantId ?? null, job.triggerEvent, subject.newStatus,
    );

    if (matches.length === 0) {
        await db.update(scenarioJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(scenarioJobs.id, job.id));
        return 'completed';
    }

    const errors: string[] = [];
    for (const { active, scenario } of matches) {
        try {
            const mappings = (active.fieldMappings ?? {}) as Record<string, unknown>;

            // Tier 2 universal webhook — POST the mapped envelope to the user's catch URL.
            if (active.webhookUrl) {
                const res = await fetch(active.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(buildWebhookPayload(subject, mappings)),
                });
                const actorId = await resolveActorUserId(db, job.organisationId, active.integrationId);
                if (actorId) {
                    await logApiCall(db, {
                        userId: actorId,
                        integrationId: active.integrationId ?? null,
                        activeScenarioId: active.id,
                        endpoint: (() => { try { return new URL(active.webhookUrl!).host; } catch { return 'webhook'; } })(),
                        httpStatus: res.status,
                    });
                }
                if (!res.ok) errors.push(`${scenario.scenarioKey}: webhook ${res.status}`);
                continue;
            }

            // Tier 1 native — dispatch through the shared ACTION_HANDLERS registry.
            if (!scenario.actionType) { errors.push(`${scenario.scenarioKey}: no actionType`); continue; }
            const actorId = await resolveActorUserId(db, job.organisationId, active.integrationId);
            if (actorId == null) { errors.push(`${scenario.scenarioKey}: no actor user`); continue; }

            const payload = buildActionPayload(scenario.actionType, subject, mappings);
            const result = await runAction(db, actorId, job.organisationId, scenario.actionType, payload);
            await logApiCall(db, {
                userId: actorId,
                integrationId: active.integrationId ?? null,
                activeScenarioId: active.id,
                endpoint: `scenario/${scenario.scenarioKey}`,
                httpStatus: result.statusCode,
            });
            if (result.statusCode >= 400) {
                const body = (() => { try { return JSON.parse(result.body as string); } catch { return {}; } })();
                errors.push(`${scenario.scenarioKey}: ${body.error ?? result.statusCode}`);
            }
        } catch (err) {
            errors.push(`${scenario.scenarioKey}: ${(err as Error)?.message ?? 'error'}`);
        }
    }

    // Mark the fired recipes regardless of individual outcome so the UI shows activity.
    await db.update(activeScenarios).set({ lastFiredAt: new Date() })
        .where(and(eq(activeScenarios.organisationId, job.organisationId),
            job.assistantId != null ? eq(activeScenarios.assistantId, job.assistantId) : sql`true`));

    if (errors.length > 0) {
        await fail(db, job, errors.join(' | '));
        return job.attempt + 1 >= job.maxAttempts ? 'failed' : 'retried';
    }
    await db.update(scenarioJobs).set({ status: 'completed', errorMessage: null, updatedAt: new Date() }).where(eq(scenarioJobs.id, job.id));
    return 'completed';
}

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();

    const pending = await db.select().from(scenarioJobs)
        .where(and(
            eq(scenarioJobs.status, 'queued'),
            or(isNull(scenarioJobs.nextRetryAt), lte(scenarioJobs.nextRetryAt, now)),
        ))
        .orderBy(scenarioJobs.createdAt)
        .limit(BATCH);

    let completed = 0, retried = 0, failed = 0;

    for (const job of pending) {
        // Atomic claim — only one runner may move a row out of 'queued'.
        const claimed = await db.update(scenarioJobs)
            .set({ status: 'processing', updatedAt: new Date() })
            .where(and(eq(scenarioJobs.id, job.id), eq(scenarioJobs.status, 'queued')))
            .returning({ id: scenarioJobs.id });
        if (claimed.length === 0) continue;

        try {
            const outcome = await processJob(db, job);
            if (outcome === 'completed') completed++;
            else if (outcome === 'retried') retried++;
            else failed++;
        } catch (err) {
            console.error(`[process-scenario-jobs] job ${job.id} crashed:`, err);
            await fail(db, job, (err as Error)?.message ?? 'crash');
            failed++;
        }
    }

    return { statusCode: 200, body: JSON.stringify({ claimed: pending.length, completed, retried, failed }) };
};
