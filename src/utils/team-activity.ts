// src/utils/team-activity.ts
// What every assistant in a workspace has done, and what is booked to go out — read from the
// records each assistant's own Activity tab reads. Two consumers:
//   • the dashboard's "Recent work" widget (netlify/functions/dashboard-recent-work.ts)
//   • every assistant's chat (netlify/functions/chat-orchestrator.ts) as <team_activity>, so an
//     assistant asked to do something already knows what its teammates just did: the blog writer
//     knows the newsletter went out on Tuesday, the social assistant knows a campaign is running,
//     the lead generator knows which product the last emails pushed.
//
// "Assistants talk to each other" is implemented as SHARED READING, not messages between models:
// each assistant reads the same record of what the team did, at the start of every turn. Nothing is
// generated or summarised by a model on the way, so nothing in the block can be invented — every
// line is a row in our own tables.
//
// ⚠️ Never throws. A source that fails drops that assistant's lines (or the whole block), and the
// conversation carries on exactly as it did before this existed.

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, blogPosts, newsletterIssues, revenueEvents, scheduledPosts } from '../../db/schema';
import { roleActivityItems, type ActivityItem } from './role-activity';
import { describeLeadEvent } from '../config/lead-activity-events';
import { liveRoleLabel } from './live-role-label';

type Db = ReturnType<typeof getDb>;

const PLATFORM_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest' };
export const platformName = (p: string) => PLATFORM_NAMES[p] ?? p;

export interface TeamMember { id: number; name: string; roleKey: string | null; roleLabel: string | null; lifecycleStatus: string | null }

/** Every non-archived assistant in the org. */
export async function loadTeam(db: Db, orgId: number): Promise<TeamMember[]> {
    return db.select({
        id: aiAssistants.id, name: aiAssistants.name,
        roleKey: sql<string | null>`${aiAssistants.configuration} ->> 'type'`,
        roleLabel: liveRoleLabel,
        lifecycleStatus: aiAssistants.lifecycleStatus,
    }).from(aiAssistants).where(and(eq(aiAssistants.organisationId, orgId), ne(aiAssistants.lifecycleStatus, 'archived')));
}

/**
 * One assistant's finished work since `cutoff`, newest first — the same sources its Activity tab
 * reads: published posts (Social Media), the revenue ledger (Lead Generator), role-activity.ts for
 * everyone else. Throws on a failed read; callers decide whether that skips the assistant.
 */
export async function recentWorkFor(db: Db, orgId: number, a: Pick<TeamMember, 'id' | 'roleKey'>, cutoff: Date, limit: number): Promise<ActivityItem[]> {
    const items: ActivityItem[] = [];
    if (a.roleKey === 'social_media_manager') {
        const posts = await db.select({ id: scheduledPosts.id, platform: scheduledPosts.platform, publishedAt: scheduledPosts.publishedAt, caption: scheduledPosts.caption })
            .from(scheduledPosts).where(and(
                eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.assistantId, a.id), eq(scheduledPosts.status, 'published'),
                isNotNull(scheduledPosts.publishedAt), gte(scheduledPosts.publishedAt, cutoff),
            )).orderBy(desc(scheduledPosts.publishedAt)).limit(limit);
        for (const p of posts) {
            // The opening words say what the post was ABOUT — "published a post" alone tells a
            // teammate nothing it can build on or avoid repeating.
            const gist = String(p.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
            items.push({
                id: `post-${p.id}`, type: 'post_published', icon: 'rocket',
                description: `Published a post to ${platformName(p.platform)}${gist ? `: “${gist}${String(p.caption ?? '').length > 90 ? '…' : ''}”` : ''}.`,
                createdAt: p.publishedAt!, status: 'success',
            });
        }
    } else if (a.roleKey === 'lead_qualifier') {
        const events = await db.select({
            id: revenueEvents.id, eventType: revenueEvents.eventType, outcome: revenueEvents.outcome, lossReason: revenueEvents.lossReason,
            valueGbp: revenueEvents.valueGbp, payload: revenueEvents.payload, assistantRecordId: revenueEvents.assistantRecordId, occurredAt: revenueEvents.occurredAt,
        }).from(revenueEvents).where(and(
            eq(revenueEvents.organisationId, orgId), eq(revenueEvents.aiAssistantId, a.id), gte(revenueEvents.occurredAt, cutoff),
        )).orderBy(desc(revenueEvents.occurredAt)).limit(limit * 3);
        const ids = [...new Set(events.map((e) => e.assistantRecordId).filter((n): n is number => Number.isInteger(n as number)))];
        const titles = ids.length
            ? new Map((await db.select({ id: assistantRecords.id, title: assistantRecords.title }).from(assistantRecords)
                .where(and(eq(assistantRecords.organisationId, orgId), inArray(assistantRecords.id, ids)))).map((t) => [t.id, t.title]))
            : new Map<number, string>();
        for (const e of events) {
            const pj = describeLeadEvent(e, e.assistantRecordId != null ? titles.get(e.assistantRecordId) ?? null : null);
            if (pj) items.push({ id: `rev-${e.id}`, type: e.eventType, icon: pj.icon, description: pj.description, createdAt: e.occurredAt, status: pj.status });
        }
    } else {
        items.push(...await roleActivityItems(db, { orgId, assistantId: a.id, roleKey: a.roleKey, cutoff, limit }));
    }
    items.sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
    return items.slice(0, limit);
}

export interface BookedItem { kind: 'post' | 'article' | 'email'; at: Date; label: string; assistantId: number | null }

/**
 * What is BOOKED to go out between `from` and `until` — scheduled posts, articles and emails only.
 * Drafts and items awaiting approval are not booked and are deliberately absent. Each source on its
 * own: one table failing must not empty the rest.
 */
export async function loadBooked(db: Db, orgId: number, from: Date, until: Date, perKind = 20): Promise<BookedItem[]> {
    const items: BookedItem[] = [];
    try {
        const posts = await db.select({ platform: scheduledPosts.platform, at: scheduledPosts.publishDate, assistantId: scheduledPosts.assistantId })
            .from(scheduledPosts).where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'scheduled'),
                gte(scheduledPosts.publishDate, from), lte(scheduledPosts.publishDate, until)))
            .orderBy(asc(scheduledPosts.publishDate)).limit(perKind);
        for (const p of posts) items.push({ kind: 'post', at: p.at, label: `Post to ${platformName(p.platform)}`, assistantId: p.assistantId });
    } catch (err) { console.error('[team-activity] booked posts skipped', err); }
    try {
        const articles = await db.select({ title: blogPosts.title, at: blogPosts.publishDate, assistantId: blogPosts.assistantId })
            .from(blogPosts).where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.status, 'scheduled'),
                gte(blogPosts.publishDate, from), lte(blogPosts.publishDate, until)))
            .orderBy(asc(blogPosts.publishDate)).limit(perKind);
        for (const b of articles) if (b.at) items.push({ kind: 'article', at: b.at, label: `Article: ${b.title}`, assistantId: b.assistantId });
    } catch (err) { console.error('[team-activity] booked articles skipped', err); }
    try {
        const emails = await db.select({ subject: newsletterIssues.subject, at: newsletterIssues.scheduledFor, assistantId: newsletterIssues.assistantId })
            .from(newsletterIssues).where(and(eq(newsletterIssues.organisationId, orgId), eq(newsletterIssues.status, 'scheduled'),
                gte(newsletterIssues.scheduledFor, from), lte(newsletterIssues.scheduledFor, until)))
            .orderBy(asc(newsletterIssues.scheduledFor)).limit(perKind);
        for (const e of emails) if (e.at) items.push({ kind: 'email', at: e.at, label: `Email: ${e.subject}`, assistantId: e.assistantId });
    } catch (err) { console.error('[team-activity] booked emails skipped', err); }
    items.sort((a, b) => a.at.getTime() - b.at.getTime());
    return items;
}

// ── The chat block ────────────────────────────────────────────────────────────────────────────

export const TEAM_ACTIVITY_DAYS = 14;
const PER_ASSISTANT = 5;
const BOOKED_DAYS = 7;
const BOOKED_MAX = 10;
const DESCRIPTION_MAX = 200;
const BLOCK_CHAR_BUDGET = 7000;

export interface TeamActivityInput {
    selfId: number;
    team: TeamMember[];
    work: Map<number, ActivityItem[]>;
    booked: BookedItem[];
    now: Date;
    timezone?: string | null;
}

const fmtDay = (d: Date, now: Date, tz?: string | null) => {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) };
    try { return d.toLocaleDateString('en-GB', opts); } catch { return d.toISOString().slice(0, 10); }
};
const fmtWhen = (d: Date, tz?: string | null) => {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) };
    try { return d.toLocaleString('en-GB', opts); } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
};
const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Render the block. Pure — tested without a database. Returns null when there is no team beyond
 * this assistant and nothing booked: a lone assistant gains nothing from a header saying so.
 */
export function renderTeamActivityBlock(input: TeamActivityInput): string | null {
    const { selfId, team, work, booked, now, timezone } = input;
    const self = team.find((m) => m.id === selfId);
    const others = team.filter((m) => m.id !== selfId);
    if (!others.length && !booked.length) return null;

    const nameOf = (id: number | null) => {
        if (id == null) return null;
        const m = team.find((t) => t.id === id);
        return m ? (m.id === selfId ? 'you' : m.name) : null;
    };
    const section = (m: TeamMember, label: string) => {
        const rows = (work.get(m.id) ?? []).slice(0, PER_ASSISTANT);
        const head = `${label} — ${m.name}${m.roleLabel ? ` (${m.roleLabel})` : ''}${m.lifecycleStatus === 'paused' ? ' [paused]' : ''}`;
        if (!rows.length) return `${head}\n  - Nothing finished in the last ${TEAM_ACTIVITY_DAYS} days.`;
        return `${head}\n${rows.map((r) => `  - ${fmtDay(new Date(r.createdAt), now, timezone)}: ${clean(r.description, DESCRIPTION_MAX)}${r.status === 'failed' ? ' (failed)' : ''}`).join('\n')}`;
    };

    const parts: string[] = [];
    let used = 0;
    const push = (s: string) => {
        if (used + s.length > BLOCK_CHAR_BUDGET) return false;
        parts.push(s); used += s.length + 2; return true;
    };
    if (self) push(section(self, 'YOU'));
    let cut = 0;
    for (const m of others) if (!push(section(m, 'TEAMMATE'))) cut++;

    const soon = booked.slice(0, BOOKED_MAX);
    if (soon.length) {
        push(`BOOKED TO GO OUT IN THE NEXT ${BOOKED_DAYS} DAYS (already scheduled — not drafts)\n${soon.map((b) => {
            const who = nameOf(b.assistantId);
            return `  - ${fmtWhen(b.at, timezone)}: ${clean(b.label, DESCRIPTION_MAX)}${who ? ` — ${who}` : ''}`;
        }).join('\n')}${booked.length > soon.length ? `\n  - …and ${booked.length - soon.length} more` : ''}`);
    }

    return [
        '<team_activity>',
        `You work alongside the other assistants this business has hired. Below is what each of you has done in the last ${TEAM_ACTIVITY_DAYS} days and what is booked to go out, read from the workspace's own records at the start of this message. Use it:`,
        `- When the task touches something a teammate did — a campaign that is running, an email that went out, a topic already posted about — build on it rather than repeating or contradicting it, and say so where it helps the user ("the newsletter covered this on Tuesday, so…").`,
        `- Only claim work listed under YOU as your own. Work listed under a teammate was done by that teammate.`,
        `- This is a summary, not everything: if the user asks about something not listed here, say you can only see recent highlights and point them to that assistant or its Activity tab. Never guess at what a teammate did.`,
        `- You cannot instruct a teammate or change their work from here unless your own instructions say you can.`,
        '',
        parts.join('\n\n'),
        cut ? `\n(${cut} more teammate${cut === 1 ? '' : 's'} not shown.)` : '',
        '</team_activity>',
    ].filter((l) => l !== '').join('\n');
}

/**
 * The workspace's raw activity, cached per org for a minute in this function instance.
 *
 * Why a cache: the pool is ONE connection to a database across the Atlantic, so every query here
 * runs in series ahead of the model call — roughly two per assistant plus four. A conversation is a
 * run of turns seconds apart, and re-reading the whole team on each one would add that wait to every
 * reply. A minute is short enough that "the email went out a moment ago" is in the next answer far
 * more often than not; the assistant's OWN work is in its conversation history regardless.
 */
const CACHE_MS = 60_000;
const cache = new Map<number, { at: number; team: TeamMember[]; work: Map<number, ActivityItem[]>; booked: BookedItem[] }>();
/** Tests only. */
export function _clearTeamActivityCache() { cache.clear(); }

async function readWorkspace(db: Db, orgId: number, now: Date) {
    const hit = cache.get(orgId);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit;
    const cutoff = new Date(now.getTime() - TEAM_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
    const team = await loadTeam(db, orgId);
    const work = new Map<number, ActivityItem[]>();
    for (const m of team) {
        try { work.set(m.id, await recentWorkFor(db, orgId, m, cutoff, PER_ASSISTANT)); }
        catch (err) { console.error('[team-activity] assistant skipped', m.id, err); }
    }
    const booked = await loadBooked(db, orgId, now, new Date(now.getTime() + BOOKED_DAYS * 24 * 60 * 60 * 1000), BOOKED_MAX + 1);
    const entry = { at: now.getTime(), team, work, booked };
    cache.set(orgId, entry);
    if (cache.size > 500) cache.delete(cache.keys().next().value as number);
    return entry;
}

/** The chat block for one assistant. Never throws; null when there is nothing to say. */
export async function buildTeamActivityBlock(db: Db, orgId: number, selfId: number, opts: { timezone?: string | null; now?: Date } = {}): Promise<string | null> {
    try {
        const now = opts.now ?? new Date();
        let ws = await readWorkspace(db, orgId, now);
        // A newly hired assistant, or one restored from the archive, inside the cache window.
        if (!ws.team.some((m) => m.id === selfId)) { cache.delete(orgId); ws = await readWorkspace(db, orgId, now); }
        if (!ws.team.some((m) => m.id === selfId)) return null;
        return renderTeamActivityBlock({ selfId, team: ws.team, work: ws.work, booked: ws.booked, now, timezone: opts.timezone ?? null });
    } catch (err) {
        console.error('[team-activity] block skipped (non-fatal)', err);
        return null;
    }
}
