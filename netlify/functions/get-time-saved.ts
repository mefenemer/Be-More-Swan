// netlify/functions/get-time-saved.ts
// US2.1 — "Hours Saved" calculator. Counts the org's AI actions in the requested
// window (leads generated, content drafted, completed task runs), multiplies each
// by the admin-configured minute value (gamification.time_multipliers), and
// returns the total hours plus a per-assistant breakdown (AC2.1.1–2.1.3).
//
//  GET ?period=all|month|week   (default: month)
//
// The period parameter exists so the "See the tasks behind this" modal can match
// whichever window the dashboard ROI hero is currently showing — the hero defaults
// to all-time, and a permanently month-scoped modal would contradict it.

import { Handler } from '@netlify/functions';
import { and, eq, gte, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { assistantRecords, blogPosts, scheduledPosts, taskRuns, aiAssistants } from '../../db/schema';
import {
    activeAssistantIds, COUNTED_RECORD_TYPES_LIST, DISCARDED_BLOG_STATUSES,
    DISCARDED_POST_STATUSES, RECORD_TYPE_MULTIPLIER, REJECTED,
} from '../../src/utils/roi-activity';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { evaluateMilestones } from '../../src/utils/gamification';
import { parseRoiPeriod, roiPeriodStart } from '../../src/utils/roi-period';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const PLATFORM_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' };
const platformName = (p?: string | null): string => (p && PLATFORM_NAMES[p.toLowerCase()]) || p || 'social';

/**
 * Per-ITEM phrasing for the modal's list ("Lead generated — Acme Ltd"), as opposed to the
 * per-SOURCE headings in roi-activity.ts RECORD_TYPE_LABEL ("Leads generated"). Two maps because
 * one row and a column heading do not read the same way; both are keyed on the same record types.
 */
const RECORD_ITEM_LABEL: Record<string, string> = {
    lead: 'Lead generated',
    enrichment: 'Record enriched',
    meeting: 'Meeting summarised',
    invoice: 'Invoice processed',
    ticket: 'Ticket handled',
    campaign_order: 'Campaign order prepared',
    campaign_decision: 'Campaign decision drafted',
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const now = new Date();
    // Default stays 'month' so the existing dashboard "Time Saved" card is unchanged;
    // only callers that explicitly ask (the ROI hero's modal) get a different window.
    const rawPeriod = event.queryStringParameters?.period;
    const period = rawPeriod ? parseRoiPeriod(rawPeriod) : 'month';
    const monthStart = period === 'all' ? new Date(0)
        : period === 'week' ? roiPeriodStart('week', now)
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const mult = await getTimeMultipliers();

    // Scope every source to the org's ACTIVE assistants, exactly as the hero tile does. This
    // endpoint used to select org-wide with no assistant predicate at all, and to count the
    // `leads` table — Be More Swan's own sales pipeline — as "Lead Generation", so the modal
    // itemised rows that no assistant produced. See src/utils/roi-activity.ts for the full note.
    const assistantIds = await activeAssistantIds(db, orgId);
    const assistants = await db
        .select({ id: aiAssistants.id, name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole })
        .from(aiAssistants).where(eq(aiAssistants.organisationId, orgId));

    // No active assistants ⇒ nothing to itemise. Returning early also keeps the inArray() calls
    // below off an empty list, which drizzle renders as `in ()` — a syntax error, not an empty set.
    const [postRows, taskRows, blogRows, recordRows] = assistantIds.length === 0
        ? [[], [], [], []] as [any[], any[], any[], any[]]
        : await Promise.all([
            db.select({ id: scheduledPosts.id, assistantId: scheduledPosts.assistantId, platform: scheduledPosts.platform, caption: scheduledPosts.caption, createdAt: scheduledPosts.createdAt })
                .from(scheduledPosts)
                .where(and(
                    eq(scheduledPosts.organisationId, orgId),
                    inArray(scheduledPosts.assistantId, assistantIds),
                    notInArray(scheduledPosts.status, DISCARDED_POST_STATUSES),
                    gte(scheduledPosts.createdAt, monthStart),
                )),
            // Issue #110 (follow-up): window on COALESCE(completed_at, created_at) — a run
            // created last month but only completing this month was otherwise dropped,
            // zeroing this tile out right after a month/week boundary despite real activity.
            db.select({ id: taskRuns.id, assistantId: taskRuns.assistantId, completedAt: taskRuns.completedAt, createdAt: taskRuns.createdAt })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.organisationId, orgId),
                    inArray(taskRuns.assistantId, assistantIds),
                    eq(taskRuns.status, 'completed'),
                    gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, monthStart.toISOString()),
                )),
            db.select({ id: blogPosts.id, assistantId: blogPosts.assistantId, title: blogPosts.title, createdAt: blogPosts.createdAt })
                .from(blogPosts)
                .where(and(
                    eq(blogPosts.organisationId, orgId),
                    inArray(blogPosts.assistantId, assistantIds),
                    notInArray(blogPosts.status, DISCARDED_BLOG_STATUSES),
                    gte(blogPosts.createdAt, monthStart),
                )),
            // The rest of the product: leads, meetings, tickets, invoices, enrichments and
            // campaign records all live here, each carrying a NOT NULL ai_assistant_id — which is
            // what makes a genuine per-assistant aggregate possible.
            db.select({ id: assistantRecords.id, assistantId: assistantRecords.aiAssistantId, recordType: assistantRecords.recordType, title: assistantRecords.title, createdAt: assistantRecords.createdAt })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    inArray(assistantRecords.aiAssistantId, assistantIds),
                    inArray(assistantRecords.recordType, [...COUNTED_RECORD_TYPES_LIST]),
                    ne(assistantRecords.approvalStatus, REJECTED),
                    gte(assistantRecords.createdAt, monthStart),
                )),
        ]);

    // Per-assistant minutes. Every source is attributable now, so the breakdown is one line per
    // assistant with no org-level "unattributed" bucket left over.
    const nameById = new Map(assistants.map(a => [a.id, a.name || a.role || 'Assistant']));
    const minutesByAssistant = new Map<number, number>();
    const addMinutes = (id: number | null, mins: number) => {
        if (id == null || mins <= 0) return;
        minutesByAssistant.set(id, (minutesByAssistant.get(id) ?? 0) + mins);
    };
    postRows.forEach(r => addMinutes(r.assistantId, mult.content_drafted));
    taskRows.forEach(r => addMinutes(r.assistantId, mult.tasks_completed));
    blogRows.forEach(r => addMinutes(r.assistantId, mult.blog_drafted));
    const recordMinutes = (recordType: string): number => {
        const key = RECORD_TYPE_MULTIPLIER[recordType];
        return key ? mult[key] : 0;
    };
    recordRows.forEach(r => addMinutes(r.assistantId, recordMinutes(r.recordType)));

    const breakdown: { label: string; hours: number }[] = [];
    for (const [id, mins] of minutesByAssistant.entries()) {
        breakdown.push({ label: nameById.get(id) ?? `Assistant #${id}`, hours: round1(mins / 60) });
    }
    breakdown.sort((a, b) => b.hours - a.hours);

    const totalMinutes = Array.from(minutesByAssistant.values()).reduce((s, m) => s + m, 0);

    // Itemised list behind the savings number — drives the "what tasks count?" modal (#3).
    // One row per actual completed item (not aggregated by assistant), so the count on the
    // tile always matches what the modal actually lists out.
    const tasks: { label: string; assistant: string | null; hours: number; at: Date }[] = [];
    const named = (id: number | null) => (id != null ? (nameById.get(id) ?? `Assistant #${id}`) : null);
    recordRows.forEach(r => tasks.push({
        label: `${RECORD_ITEM_LABEL[r.recordType] ?? 'Record handled'}${r.title ? ` — ${String(r.title).slice(0, 80)}` : ''}`,
        assistant: named(r.assistantId),
        hours: round1(recordMinutes(r.recordType) / 60),
        at: r.createdAt,
    }));
    blogRows.forEach(b => tasks.push({
        label: `Blog post written${b.title ? ` — ${String(b.title).slice(0, 80)}` : ''}`,
        assistant: named(b.assistantId),
        hours: round1(mult.blog_drafted / 60),
        at: b.createdAt,
    }));
    postRows.forEach(p => tasks.push({
        label: `${platformName(p.platform)} post drafted${p.caption ? `: "${p.caption.slice(0, 60)}${p.caption.length > 60 ? '…' : ''}"` : ''}`,
        assistant: p.assistantId != null ? (nameById.get(p.assistantId) ?? `Assistant #${p.assistantId}`) : null,
        hours: round1(mult.content_drafted / 60),
        at: p.createdAt,
    }));
    taskRows.forEach(t => tasks.push({
        label: 'Task completed',
        assistant: t.assistantId != null ? (nameById.get(t.assistantId) ?? `Assistant #${t.assistantId}`) : null,
        hours: round1(mult.tasks_completed / 60),
        at: t.completedAt ?? t.createdAt,
    }));
    tasks.sort((a, b) => +new Date(b.at) - +new Date(a.at));
    // taskCount is the TRUE total and must stay uncapped — it's what the ROI hero tile
    // shows, and the modal subtitle quotes it. Only the itemised list is trimmed, since
    // an all-time window can span thousands of rows; `tasksTruncated` lets the modal say so.
    const taskCount = tasks.length;
    const TASK_LIST_CAP = 100;
    const tasksTruncated = tasks.length > TASK_LIST_CAP;
    const taskList = tasksTruncated ? tasks.slice(0, TASK_LIST_CAP) : tasks;

    // US3.1: evaluate milestones on dashboard load (idempotent; honours the emergency stop). Non-blocking.
    await evaluateMilestones(db, orgId, ctx.userId).catch(() => {});

    return json(200, {
        hoursSaved: Math.round(totalMinutes / 60),
        totalMinutes,
        period,
        // `month` is the window's display label, kept under its original key so the
        // existing dashboard card and modal keep rendering it without changes.
        month: period === 'all' ? 'All time'
            : period === 'week' ? 'This week'
            : monthStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        breakdown,
        tasks: taskList,
        taskCount,
        tasksTruncated,
    });
});

function round1(n: number): number { return Math.round(n * 10) / 10; }
