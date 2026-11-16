/**
 * src/utils/search-trends-admin.ts — Admin ▸ System ▸ Search trends (docs/google-trends-plan.md §5 Phase 1:
 * "an Admin list shows terms, status and cost"). Is the weekly Google Trends refresh healthy, and what
 * does it cost? Shared data only: terms, their status and spend, and HOW MANY workspaces track each —
 * never which workspaces (an admin who needs that has the workspace pages).
 */

import { and, eq, gte, isNotNull, like, sql } from 'drizzle-orm';
import { aiUsageLog, orgTrendTerms, searchTrendTerms } from '../../db/schema';
import type { getDb } from '../../db/client';
import { REFRESH_EVERY_DAYS, TASK_GIVE_UP_HOURS } from './search-trends';

type Db = ReturnType<typeof getDb>;

export interface AdminTermRow {
    id: number;
    term: string;
    locationName: string;
    status: string;
    fetchedAt: string | null;
    taskOut: boolean;
    taskPostedAt: string | null;
    attempts: number;
    lastError: string | null;
    costUsd: number;
    tracking: number;
    suggested: number;
    peakMonths: number[];
    related: number;
    health: 'ok' | 'stale' | 'stuck' | 'failing' | 'waiting' | 'unused';
}

export interface AdminTrendsView {
    setUp: true;
    providerConfigured: boolean;
    totals: { terms: number; tracked: number; workspaces: number; ok: number; notEnoughData: number; pending: number; error: number; tasksOut: number; stale: number; stuck: number };
    spend: { usd30: number; usdAll: number; standard30: number; live30: number; lookups24h: number };
    terms: AdminTermRow[];
}

/**
 * How a term is doing. Pure.
 *   unused  — nobody approves it, so it is never refreshed (a look-up or a removed term);
 *   waiting — approved, never fetched yet;
 *   stuck   — a task has been out longer than TASK_GIVE_UP_HOURS;
 *   failing — the last attempts errored;
 *   stale   — fetched, but longer ago than the refresh period plus a day;
 *   ok      — otherwise.
 */
export function termHealth(r: { tracking: number; fetchedAt: Date | null; taskPostedAt: Date | null; taskOut: boolean; attempts: number; status: string }, now: Date): AdminTermRow['health'] {
    if (r.tracking === 0) return 'unused';
    if (r.taskOut && r.taskPostedAt && now.getTime() - r.taskPostedAt.getTime() > TASK_GIVE_UP_HOURS * 3_600_000) return 'stuck';
    if (r.attempts > 0 || r.status === 'error') return 'failing';
    if (!r.fetchedAt) return 'waiting';
    if (now.getTime() - r.fetchedAt.getTime() > (REFRESH_EVERY_DAYS + 1) * 86_400_000) return 'stale';
    return 'ok';
}

const HEALTH_ORDER: Record<AdminTermRow['health'], number> = { stuck: 0, failing: 1, stale: 2, waiting: 3, ok: 4, unused: 5 };

export async function loadAdminTrends(db: Db, providerConfigured: boolean, now: Date = new Date()): Promise<AdminTrendsView> {
    const counts = db.select({
        termId: orgTrendTerms.termId,
        tracking: sql<number>`count(*) filter (where ${orgTrendTerms.approvedAt} is not null)::int`.as('tracking'),
        suggested: sql<number>`count(*) filter (where ${orgTrendTerms.approvedAt} is null)::int`.as('suggested'),
    }).from(orgTrendTerms).groupBy(orgTrendTerms.termId).as('c');

    const rows = await db.select({
        id: searchTrendTerms.id, term: searchTrendTerms.term, locationName: searchTrendTerms.locationName, status: searchTrendTerms.status,
        fetchedAt: searchTrendTerms.fetchedAt, taskId: searchTrendTerms.taskId, taskPostedAt: searchTrendTerms.taskPostedAt,
        attempts: searchTrendTerms.attempts, lastError: searchTrendTerms.lastError, costUsdTotal: searchTrendTerms.costUsdTotal,
        peakMonths: searchTrendTerms.peakMonths, topQueries: searchTrendTerms.topQueries, risingQueries: searchTrendTerms.risingQueries,
        tracking: sql<number>`coalesce(${counts.tracking}, 0)::int`, suggested: sql<number>`coalesce(${counts.suggested}, 0)::int`,
    }).from(searchTrendTerms).leftJoin(counts, eq(counts.termId, searchTrendTerms.id)).limit(2000);

    const [{ workspaces }] = await db.select({ workspaces: sql<number>`count(distinct ${orgTrendTerms.organisationId})::int` })
        .from(orgTrendTerms).where(isNotNull(orgTrendTerms.approvedAt));

    // ⚠️ Inside a raw sql`` fragment a Date is sent as-is, and the driver can't serialise it (prod
    // 2026-11-16: "Failed query … params: Sat Oct 17 2026 14:34:55 GMT+0000"). Pass an ISO string and
    // cast, as review-requests.ts does. created_at is a naive UTC timestamp, so ::timestamp.
    const d30 = new Date(now.getTime() - 30 * 86_400_000);
    const d30Iso = d30.toISOString();
    const d1 = new Date(now.getTime() - 86_400_000);
    const [spend] = await db.select({
        usdAll: sql<string>`coalesce(sum(${aiUsageLog.costUsd}), 0)::text`,
        usd30: sql<string>`coalesce(sum(${aiUsageLog.costUsd}) filter (where ${aiUsageLog.createdAt} >= ${d30Iso}::timestamp), 0)::text`,
        standard30: sql<string>`coalesce(sum(${aiUsageLog.costUsd}) filter (where ${aiUsageLog.createdAt} >= ${d30Iso}::timestamp and ${aiUsageLog.model} = 'dataforseo-trends-standard'), 0)::text`,
        live30: sql<string>`coalesce(sum(${aiUsageLog.costUsd}) filter (where ${aiUsageLog.createdAt} >= ${d30Iso}::timestamp and ${aiUsageLog.model} = 'dataforseo-trends-live'), 0)::text`,
    }).from(aiUsageLog).where(like(aiUsageLog.model, 'dataforseo-%'));
    const [{ lookups24h }] = await db.select({ lookups24h: sql<number>`count(*)::int` }).from(aiUsageLog)
        .where(and(eq(aiUsageLog.model, 'dataforseo-trends-live'), gte(aiUsageLog.createdAt, d1)));

    const terms: AdminTermRow[] = rows.map((r) => {
        const taskOut = !!r.taskId;
        return {
            id: r.id, term: r.term, locationName: r.locationName, status: r.status,
            fetchedAt: r.fetchedAt ? r.fetchedAt.toISOString() : null, taskOut,
            taskPostedAt: r.taskPostedAt ? r.taskPostedAt.toISOString() : null,
            attempts: r.attempts, lastError: r.lastError, costUsd: Number(r.costUsdTotal) || 0,
            tracking: r.tracking, suggested: r.suggested,
            peakMonths: Array.isArray(r.peakMonths) ? r.peakMonths : [],
            related: (Array.isArray(r.topQueries) ? r.topQueries.length : 0) + (Array.isArray(r.risingQueries) ? r.risingQueries.length : 0),
            health: termHealth({ tracking: r.tracking, fetchedAt: r.fetchedAt, taskPostedAt: r.taskPostedAt, taskOut, attempts: r.attempts, status: r.status }, now),
        };
    }).sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || b.tracking - a.tracking || a.term.localeCompare(b.term));

    const count = (pred: (t: AdminTermRow) => boolean) => terms.filter(pred).length;
    return {
        setUp: true,
        providerConfigured,
        totals: {
            terms: terms.length, tracked: count((t) => t.tracking > 0), workspaces,
            ok: count((t) => t.status === 'ok'), notEnoughData: count((t) => t.status === 'not_enough_data'),
            pending: count((t) => t.status === 'pending'), error: count((t) => t.status === 'error'),
            tasksOut: count((t) => t.taskOut), stale: count((t) => t.health === 'stale'), stuck: count((t) => t.health === 'stuck'),
        },
        spend: { usd30: Number(spend?.usd30) || 0, usdAll: Number(spend?.usdAll) || 0, standard30: Number(spend?.standard30) || 0, live30: Number(spend?.live30) || 0, lookups24h },
        terms,
    };
}

/**
 * "Fetch again": clear a term's task, error and backoff and mark it due, so the next tick posts it.
 * The last good series and related searches stay until the new answer replaces them.
 */
export async function retryTrendTerm(db: Db, termId: number): Promise<boolean> {
    const r = await db.update(searchTrendTerms)
        .set({ taskId: null, taskPostedAt: null, attempts: 0, lastError: null, fetchedAt: null })
        .where(eq(searchTrendTerms.id, termId))
        .returning({ id: searchTrendTerms.id });
    return r.length > 0;
}
