// netlify/functions/get-time-saved.ts
// US2.1 — "Hours Saved" calculator. Counts the org's AI actions this calendar
// month (leads generated, content drafted, completed task runs), multiplies each
// by the admin-configured minute value (gamification.time_multipliers), and
// returns the total hours plus a per-assistant breakdown (AC2.1.1–2.1.3).

import { Handler } from '@netlify/functions';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { leads, scheduledPosts, taskRuns, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { evaluateMilestones } from '../../src/utils/gamification';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const PLATFORM_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' };
const platformName = (p?: string | null): string => (p && PLATFORM_NAMES[p.toLowerCase()]) || p || 'social';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const mult = await getTimeMultipliers();

    const [leadRows, postRows, taskRows, assistants] = await Promise.all([
        db.select({ id: leads.id, name: leads.name, company: leads.company, createdAt: leads.createdAt })
            .from(leads)
            .where(and(eq(leads.organisationId, orgId), gte(leads.createdAt, monthStart))),
        db.select({ id: scheduledPosts.id, assistantId: scheduledPosts.assistantId, platform: scheduledPosts.platform, caption: scheduledPosts.caption, createdAt: scheduledPosts.createdAt })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.organisationId, orgId), gte(scheduledPosts.createdAt, monthStart))),
        // Issue #110 (follow-up): window on COALESCE(completed_at, created_at) — a run
        // created last month but only completing this month was otherwise dropped,
        // zeroing this tile out right after a month/week boundary despite real activity.
        db.select({ id: taskRuns.id, assistantId: taskRuns.assistantId, completedAt: taskRuns.completedAt, createdAt: taskRuns.createdAt })
            .from(taskRuns)
            .where(and(eq(taskRuns.organisationId, orgId), eq(taskRuns.status, 'completed'), gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, monthStart.toISOString()))),
        db.select({ id: aiAssistants.id, name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole })
            .from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)),
    ]);

    const leadsCount = leadRows.length;

    // Per-assistant minutes from drafts + completed tasks.
    const nameById = new Map(assistants.map(a => [a.id, a.name || a.role || 'Assistant']));
    const minutesByAssistant = new Map<number, number>();
    const addMinutes = (id: number | null, mins: number) => {
        if (id == null || mins <= 0) return;
        minutesByAssistant.set(id, (minutesByAssistant.get(id) ?? 0) + mins);
    };
    postRows.forEach(r => addMinutes(r.assistantId, mult.content_drafted));
    taskRows.forEach(r => addMinutes(r.assistantId, mult.tasks_completed));

    const breakdown: { label: string; hours: number }[] = [];
    // Leads roll up to an org-level line (the leads table has no assistant attribution).
    const leadMinutes = leadsCount * mult.leads_generated;
    if (leadMinutes > 0) breakdown.push({ label: 'Lead Generation', hours: round1(leadMinutes / 60) });
    for (const [id, mins] of minutesByAssistant.entries()) {
        breakdown.push({ label: nameById.get(id) ?? `Assistant #${id}`, hours: round1(mins / 60) });
    }
    breakdown.sort((a, b) => b.hours - a.hours);

    const totalMinutes = leadMinutes + Array.from(minutesByAssistant.values()).reduce((s, m) => s + m, 0);

    // Itemised list behind the savings number — drives the "what tasks count?" modal (#3).
    // One row per actual completed item (not aggregated by assistant), so the count on the
    // tile always matches what the modal actually lists out.
    const tasks: { label: string; assistant: string | null; hours: number; at: Date }[] = [];
    leadRows.forEach(l => tasks.push({
        label: `Lead generated${l.company ? ` — ${l.company}` : l.name ? ` — ${l.name}` : ''}`,
        assistant: null,
        hours: round1(mult.leads_generated / 60),
        at: l.createdAt,
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
    const taskCount = tasks.length;

    // US3.1: evaluate milestones on dashboard load (idempotent; honours the emergency stop). Non-blocking.
    await evaluateMilestones(db, orgId, ctx.userId).catch(() => {});

    return json(200, {
        hoursSaved: Math.round(totalMinutes / 60),
        totalMinutes,
        month: monthStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        breakdown,
        tasks,
        taskCount,
    });
};

function round1(n: number): number { return Math.round(n * 10) / 10; }
