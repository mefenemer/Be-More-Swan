// netlify/functions/poll-goal-telemetry.ts
// SMART Goals — Feature 4 / US4.1 + US1.2. Scheduled worker (hourly cron) that, for each
// active goal due a refresh, fetches the current metric value, appends a goal_telemetry row,
// and recomputes the goal's status via the run-rate engine.
//
//   AC4.1.1 tier-based cadence  — each goal polled at most once per its tier's cadence.
//   AC4.1.2 secure auth         — third-party tokens decrypted from the vault per request.
//   AC4.3.1 rate-limit backoff  — 429s retried with exponential backoff before giving up.
//   AC4.3.2 stale-data flag     — no fresh data for >48h flips the goal to data_disconnected.
//   AC4.3.3 alerting            — a critical_action notification fires when that happens.
//
// Owner-path (getDb) + manual org filter, like ingest-instagram-insights.

import { Handler } from '@netlify/functions';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    goals, goalTelemetry, aiAssistants, systemConnections,
    scheduledPosts, leads, plans, masterPlans, notifications,
} from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { connectionDisplayName, getGoalMetric, pollCadenceHours, RUN_RATE_THRESHOLDS } from '../../src/config/goal-metrics';
import { computeGoalProgress } from '../../src/utils/goal-progress';

const GRAPH_VERSION = 'v19.0';
const BATCH = 200;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type FetchResult = { value: number | null; disconnected: boolean };

// ── Instagram account follower count (the one live third-party call) ────────────
async function fetchIgFollowers(igUserId: string, token: string): Promise<FetchResult> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}?fields=followers_count&access_token=${token}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url);
        if (res.status === 429) {                       // AC4.3.1 — exponential backoff before retry
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) return { value: null, disconnected: false };
        const body = await res.json().catch(() => null) as { followers_count?: number } | null;
        return { value: typeof body?.followers_count === 'number' ? body.followers_count : null, disconnected: false };
    }
    return { value: null, disconnected: false };         // exhausted retries — treat as transient, not disconnected
}

type LiConn = { id: number; vaultRefKey: string | null; metadata: any };

// ── LinkedIn GET with the same 429-backoff + auth handling as the IG path ───────
async function liFetch(url: string, token: string): Promise<{ ok: boolean; disconnected: boolean; body: any }> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' } });
        if (res.status === 429) {                        // AC4.3.1 — exponential backoff before retry
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.status === 401 || res.status === 403) return { ok: false, disconnected: true, body: null };
        if (!res.ok) return { ok: false, disconnected: false, body: null };
        return { ok: true, disconnected: false, body: await res.json().catch(() => null) };
    }
    return { ok: false, disconnected: false, body: null };   // exhausted retries — transient
}

// ── LinkedIn organisation follower count (org URN resolved once, then cached on the connection) ──
async function fetchLinkedInFollowers(db: any, conn: LiConn): Promise<FetchResult> {
    if (!conn.vaultRefKey) return { value: null, disconnected: true };
    const secret = await getSecret(db, conn.vaultRefKey);
    const token = (secret?.token as string | undefined) ?? null;
    if (!token) return { value: null, disconnected: true };

    // Resolve the administered organisation URN, caching it so we skip the ACL call next time.
    const meta = (conn.metadata as Record<string, any>) ?? {};
    let orgUrn: string | null = typeof meta.organizationUrn === 'string' ? meta.organizationUrn : null;
    if (!orgUrn) {
        const acl = await liFetch('https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization))', token);
        if (acl.disconnected) return { value: null, disconnected: true };
        if (!acl.ok) return { value: null, disconnected: false };
        orgUrn = (acl.body?.elements?.[0]?.organization as string | undefined) ?? null;
        if (!orgUrn) return { value: null, disconnected: false };   // no administered org yet — transient, token is fine
        await db.update(systemConnections)
            .set({ metadata: { ...meta, organizationUrn: orgUrn }, updatedAt: new Date() })
            .where(eq(systemConnections.id, conn.id))
            .catch(() => {});
    }

    // firstDegreeSize = the org's follower count. Requires r_organization_social.
    const orgId = orgUrn.split(':').pop();
    const net = await liFetch(`https://api.linkedin.com/v2/networkSizes/urn:li:organization:${orgId}?edgeType=CompanyFollowedByMember`, token);
    if (net.disconnected) return { value: null, disconnected: true };
    if (!net.ok) return { value: null, disconnected: false };
    return { value: typeof net.body?.firstDegreeSize === 'number' ? net.body.firstDegreeSize : null, disconnected: false };
}

async function fetchMetric(
    db: any,
    goal: any,
    conns: { ig: { externalUserId: string | null; vaultRefKey: string | null } | null; li: LiConn | null },
): Promise<FetchResult> {
    const metric = getGoalMetric(goal.metricKey);
    if (!metric) return { value: null, disconnected: false };
    const igConn = conns.ig;

    switch (goal.metricKey) {
        case 'instagram_followers': {
            if (!igConn?.externalUserId || !igConn.vaultRefKey) return { value: null, disconnected: true };
            const secret = await getSecret(db, igConn.vaultRefKey);
            const token = (secret?.token as string | undefined) ?? null;
            if (!token) return { value: null, disconnected: true };
            return fetchIgFollowers(igConn.externalUserId, token);
        }
        case 'instagram_reach': {
            const [row] = await db.execute(sql`
                SELECT COALESCE(SUM(reach), 0)::int AS v FROM post_insights
                WHERE assistant_id = ${goal.assistantId} AND organisation_id = ${goal.organisationId}
                  AND published_at >= now() - interval '30 days'`);
            return { value: Number((row as any)?.v ?? 0), disconnected: false };
        }
        case 'instagram_engagement_rate': {
            const [row] = await db.execute(sql`
                SELECT COALESCE(SUM(total_interactions),0)::float AS inter, COALESCE(SUM(reach),0)::float AS reach
                FROM post_insights
                WHERE assistant_id = ${goal.assistantId} AND organisation_id = ${goal.organisationId}
                  AND published_at >= now() - interval '30 days'`);
            const r = row as any;
            const rate = r && r.reach > 0 ? (r.inter / r.reach) * 100 : 0;
            return { value: Math.round(rate * 100) / 100, disconnected: false };
        }
        case 'linkedin_followers': {
            if (!conns.li) return { value: null, disconnected: true };
            return fetchLinkedInFollowers(db, conns.li);
        }
        case 'qualified_leads': {
            // "Qualified" = leads that progressed to a won/converted state for this workspace.
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(leads)
                .where(and(eq(leads.organisationId, goal.organisationId), eq(leads.status, 'converted')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }
        case 'content_published': {
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.assistantId, goal.assistantId), eq(scheduledPosts.status, 'published')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }
        default:
            return { value: null, disconnected: false };
    }
}

export async function pollGoalTelemetry(): Promise<{ goals: number; polled: number; skipped: number; disconnected: number }> {
    const db = getDb();
    const now = new Date();

    const activeGoals = await db
        .select()
        .from(goals)
        .where(eq(goals.isActive, true))
        .limit(BATCH);

    if (!activeGoals.length) return { goals: 0, polled: 0, skipped: 0, disconnected: 0 };

    // Per-org polling cadence (AC4.1.1) — one tier lookup per org.
    const orgIds = [...new Set(activeGoals.map(g => g.organisationId))];
    const tierRows = await db
        .select({ orgId: plans.organisationId, tierKey: masterPlans.tierKey })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(inArray(plans.organisationId, orgIds), eq(plans.status, 'active')));
    const tierByOrg = new Map<number, string | null>(tierRows.map(r => [r.orgId as number, r.tierKey]));

    // One Instagram + one LinkedIn connection per org (for follower polling).
    const igByOrg = new Map<number, { externalUserId: string | null; vaultRefKey: string | null }>();
    const liByOrg = new Map<number, LiConn>();
    for (const orgId of orgIds) {
        const [ig] = await db
            .select({ externalUserId: systemConnections.externalUserId, vaultRefKey: systemConnections.vaultRefKey })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, orgId),
                eq(systemConnections.serviceName, 'instagram'),
                eq(systemConnections.status, 'active'),
                eq(systemConnections.isActive, true),
            ))
            .limit(1);
        if (ig) igByOrg.set(orgId, ig);

        const [li] = await db
            .select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, orgId),
                eq(systemConnections.serviceName, 'linkedin'),
                eq(systemConnections.status, 'active'),
                eq(systemConnections.isActive, true),
            ))
            .limit(1);
        if (li) liByOrg.set(orgId, li);
    }

    let polled = 0, disconnectedCount = 0, skipped = 0;

    await Promise.allSettled(activeGoals.map(async (goal) => {
        const cadenceMs = pollCadenceHours(tierByOrg.get(goal.organisationId)) * 3600_000;
        const lastAt = await db
            .select({ recordedAt: goalTelemetry.recordedAt })
            .from(goalTelemetry)
            .where(eq(goalTelemetry.goalId, goal.id))
            .orderBy(desc(goalTelemetry.recordedAt))
            .limit(1);
        const lastTelemetryAt: Date | null = lastAt[0]?.recordedAt ?? null;

        // Throttle by tier cadence.
        if (lastTelemetryAt && now.getTime() - lastTelemetryAt.getTime() < cadenceMs) { skipped++; return; }

        const { value, disconnected } = await fetchMetric(db, goal, {
            ig: igByOrg.get(goal.organisationId) ?? null,
            li: liByOrg.get(goal.organisationId) ?? null,
        });

        if (value != null) {
            const startValue = goal.startValue == null ? value : Number(goal.startValue);
            await db.insert(goalTelemetry).values({
                goalId: goal.id, organisationId: goal.organisationId, metricValue: String(value), source: 'poll',
            });
            const progress = computeGoalProgress({
                startValue,
                latestValue: value,
                targetValue: Number(goal.targetValue),
                createdAt: goal.createdAt,
                targetDate: goal.targetDate,
                direction: getGoalMetric(goal.metricKey)?.direction ?? 'increase',
                lastTelemetryAt: now,           // we just recorded a fresh point
                now,
            });
            await db.update(goals).set({
                latestValue: String(value),
                startValue: String(startValue),
                status: progress.status,
                statusUpdatedAt: now,
                updatedAt: now,
            }).where(eq(goals.id, goal.id));
            polled++;
            return;
        }

        // Couldn't fetch. If the connection is gone AND data is already stale, flag + alert (AC4.3.2/3).
        const staleCutoff = RUN_RATE_THRESHOLDS.staleDataHours * 3600_000;
        const isStale = !lastTelemetryAt || (now.getTime() - lastTelemetryAt.getTime() > staleCutoff);
        if (disconnected && isStale && goal.status !== 'data_disconnected') {
            await db.update(goals).set({ status: 'data_disconnected', statusUpdatedAt: now, updatedAt: now }).where(eq(goals.id, goal.id));
            disconnectedCount++;
            const metric = getGoalMetric(goal.metricKey);
            const integration = connectionDisplayName(metric?.connectionService) ?? 'your data source';
            if (goal.createdByUserId) {
                await db.insert(notifications).values({
                    userId: goal.createdByUserId,
                    type: 'goal_data_disconnected',
                    title: 'Goal tracking paused',
                    message: `We lost connection to ${integration}. Please re-authenticate so your assistant can continue tracking its goals.`,
                    isRead: false,
                }).catch(() => {});
            }
        }
    }));

    return { goals: activeGoals.length, polled, skipped, disconnected: disconnectedCount };
}

export const handler: Handler = async () => {
    const result = await pollGoalTelemetry();
    return { statusCode: 200, body: JSON.stringify(result) };
};
