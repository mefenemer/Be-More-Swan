// src/utils/review-waiting.ts — what the Review page lists beyond posts, articles and emails (owner, 2026-11-07:
// "does this include all review items from all assistants?"). Everything else waiting on the user, from every
// active assistant. Each item opens that assistant's own tab, where it is approved by that tab's own rules.
//
// ⚠️ The numbers must agree with the tabs they point at: each predicate here is the one that tab uses. Leads are
// the Outreach tab's "To approve" (lead-recipient predicate, not swept), decisions are the Review Queue's mirror
// of campaign_decisions, fixes are "To review", briefs are "To do" with options waiting.
//
// Archived assistants are left out: their work waits on nobody (archived-assistant-drafts.ts). A table that
// doesn't exist on this database yet costs that source only, never the whole list.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, assistantRecords, bookings, siteAuditFixes, siteAudits, siteEnquiries, sites, videoProjects,
    visualBriefOptions, visualBriefs,
} from '../../db/schema';
import { LEAD_DRAFT_BODY_SQL_PATH, LEAD_OUTREACH_STAGE_SQL_PATH, LEAD_RECIPIENT_SQL_PATHS } from '../config/lead-recipient';
import { RETENTION_DELETED_SQL_PATH } from '../config/lead-retention';
import { MENTOR_ROLE_KEY } from './mentor-provision';
import { loadOpenProposals } from './mentor-proposals';

type Db = ReturnType<typeof getDb>;

export interface WaitingItem { id: number; title: string; at: string | null }
export interface WaitingGroup {
    key: string;
    assistantId: number;
    assistantName: string;
    /** What is waiting, in the words of the tab it opens. */
    label: string;
    /** The main tab on that assistant's page. */
    tab: string;
    count: number;
    items: WaitingItem[];
}

/** How many of a group's items the page lists. Its count is always the whole number. */
export const ITEMS_PER_GROUP = 5;
const MAX_ROWS = 1000;

const RECORD_SOURCES: Record<string, { label: string; tab: string }> = {
    lead: { label: 'Outreach emails to approve', tab: 'review-queue' },
    invoice: { label: 'Invoice chasers to approve', tab: 'review-queue' },
    ticket: { label: 'Support replies to approve', tab: 'review-queue' },
    enrichment: { label: 'Record updates to approve', tab: 'review-queue' },
    meeting: { label: 'Meeting notes to approve', tab: 'review-queue' },
    campaign_decision: { label: 'Campaign decisions', tab: 'review-queue' },
};

async function optional<T>(q: () => Promise<T>, fallback: T): Promise<T> {
    try { return await q(); } catch { return fallback; }
}

/** One assistant's rows of one kind, newest first, into a group. Pure, so its counting can be tested. */
export function toGroup(source: { kind: string; label: string; tab: string }, assistant: { id: number; name: string | null }, rows: Array<{ id: number; title: string | null; at: Date | string | null }>): WaitingGroup {
    const sorted = [...rows].sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
    return {
        key: `${source.kind}-${assistant.id}`,
        assistantId: assistant.id,
        assistantName: assistant.name || 'Your assistant',
        label: source.label,
        tab: source.tab,
        count: rows.length,
        items: sorted.slice(0, ITEMS_PER_GROUP).map((r) => ({
            id: r.id,
            title: String(r.title ?? '').trim().slice(0, 120) || 'Untitled',
            at: r.at ? new Date(r.at).toISOString() : null,
        })),
    };
}

/** The Outreach tab's "To approve", identical to assistant-records.ts `inOutreachReviewWhere` for a live lead. */
function leadWaitingSql() {
    const recipient = sql.raw(LEAD_RECIPIENT_SQL_PATHS.map((p) => `NULLIF(BTRIM(data #>> '${p}'), '')`).join(', '));
    const body = sql.raw(`NULLIF(BTRIM(data #>> '${LEAD_DRAFT_BODY_SQL_PATH}'), '')`);
    const stage = sql.raw(`NULLIF(BTRIM(data #>> '${LEAD_OUTREACH_STAGE_SQL_PATH}'), '')`);
    const deleted = sql.raw(`NULLIF(BTRIM(data #>> '${RETENTION_DELETED_SQL_PATH}'), '')`);
    return sql`(${deleted} IS NULL AND CASE
        WHEN ${stage} = 'review' THEN TRUE
        WHEN ${stage} = 'triage' THEN FALSE
        ELSE (COALESCE(${recipient}) IS NOT NULL AND ${body} IS NOT NULL)
    END)`;
}

export async function loadReviewWaiting(db: Db, orgId: number, now = new Date()): Promise<{ groups: WaitingGroup[]; total: number }> {
    const team = await db.select({ id: aiAssistants.id, name: aiAssistants.name, roleKey: sql<string | null>`${aiAssistants.configuration} ->> 'type'` })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.organisationId, orgId), sql`${aiAssistants.lifecycleStatus} IS DISTINCT FROM 'archived'`));
    const ids = team.map((a) => a.id);
    if (!ids.length) return { groups: [], total: 0 };
    const who = new Map(team.map((a) => [a.id, a]));
    const groups: WaitingGroup[] = [];
    /** Sort rows into one group per assistant. */
    const add = (source: { kind: string; label: string; tab: string }, rows: Array<{ assistantId: number | null; id: number; title: string | null; at: Date | string | null }>) => {
        const by = new Map<number, typeof rows>();
        for (const r of rows) if (r.assistantId != null && who.has(r.assistantId)) by.set(r.assistantId, [...(by.get(r.assistantId) ?? []), r]);
        for (const [aid, list] of by) groups.push(toGroup(source, who.get(aid)!, list));
    };

    const records = await optional(() => db.select({
        assistantId: assistantRecords.aiAssistantId, id: assistantRecords.id, title: assistantRecords.title, at: assistantRecords.createdAt, type: assistantRecords.recordType,
    }).from(assistantRecords).where(and(
        eq(assistantRecords.organisationId, orgId),
        inArray(assistantRecords.aiAssistantId, ids),
        inArray(assistantRecords.recordType, Object.keys(RECORD_SOURCES)),
        eq(assistantRecords.approvalStatus, 'pending_approval'),
        sql`(${assistantRecords.recordType} <> 'lead' OR ${leadWaitingSql()})`,
    )).orderBy(desc(assistantRecords.createdAt)).limit(MAX_ROWS), []);
    for (const [type, source] of Object.entries(RECORD_SOURCES)) add({ kind: type, ...source }, records.filter((r) => r.type === type));

    // Brand Designer: briefs with options to choose from, the "To do" tab's main reason.
    const briefs = await optional(() => db.select({ assistantId: visualBriefs.aiAssistantId, id: visualBriefs.id, title: visualBriefs.title, at: visualBriefs.updatedAt })
        .from(visualBriefs).where(and(
            eq(visualBriefs.organisationId, orgId), inArray(visualBriefs.aiAssistantId, ids),
            sql`${visualBriefs.status} <> 'cancelled'`,
            sql`EXISTS (SELECT 1 FROM ${visualBriefOptions} o WHERE o.brief_id = ${visualBriefs.id} AND o.status = 'proposed')`,
            sql`NOT EXISTS (SELECT 1 FROM ${visualBriefOptions} o WHERE o.brief_id = ${visualBriefs.id} AND o.status = 'approved')`,
        )).limit(MAX_ROWS), []);
    add({ kind: 'brief', label: 'Designs to choose from', tab: 'briefs' }, briefs);

    // Video Producer: storyboards to check. A finished video waits as a post, which Review already lists.
    const videos = await optional(() => db.select({ assistantId: videoProjects.aiAssistantId, id: videoProjects.id, title: videoProjects.title, at: videoProjects.updatedAt })
        .from(videoProjects).where(and(eq(videoProjects.organisationId, orgId), inArray(videoProjects.aiAssistantId, ids), eq(videoProjects.status, 'planned'), isNull(videoProjects.archivedAt))).limit(MAX_ROWS), []);
    add({ kind: 'video', label: 'Video storyboards to check', tab: 'videos' }, videos);

    // Mystery Shopper: suggested fixes on "To review".
    const fixes = await optional(() => db.select({ assistantId: siteAudits.aiAssistantId, id: siteAuditFixes.id, title: siteAuditFixes.problem, at: siteAuditFixes.createdAt })
        .from(siteAuditFixes).innerJoin(siteAudits, eq(siteAudits.id, siteAuditFixes.auditId))
        .where(and(eq(siteAuditFixes.organisationId, orgId), inArray(siteAudits.aiAssistantId, ids), eq(siteAuditFixes.status, 'open'))).limit(MAX_ROWS), []);
    add({ kind: 'fix', label: 'Website fixes to review', tab: 'website' }, fixes);

    // Website Assistant: what visitors sent. A booking request in the past waits on nobody.
    const enquiries = await optional(() => db.select({ assistantId: sites.aiAssistantId, id: siteEnquiries.id, title: siteEnquiries.name, at: siteEnquiries.createdAt })
        .from(siteEnquiries).innerJoin(sites, eq(sites.id, siteEnquiries.siteId))
        .where(and(eq(siteEnquiries.organisationId, orgId), inArray(sites.aiAssistantId, ids), eq(siteEnquiries.status, 'new'))).limit(MAX_ROWS), []);
    add({ kind: 'enquiry', label: 'Website enquiries to answer', tab: 'siteenquiries' }, enquiries);
    const requests = await optional(() => db.select({ assistantId: sites.aiAssistantId, id: bookings.id, title: bookings.customerName, at: bookings.createdAt })
        .from(bookings).innerJoin(sites, eq(sites.id, bookings.siteId))
        .where(and(eq(bookings.organisationId, orgId), inArray(sites.aiAssistantId, ids), eq(bookings.status, 'pending'), sql`${bookings.startsAt} >= ${now.toISOString()}::timestamptz`)).limit(MAX_ROWS), []);
    add({ kind: 'booking', label: 'Booking requests to confirm', tab: 'sitebookings' }, requests);

    // Business Mentor: its suggestions, by the same reading as its Suggestions tab.
    const mentor = team.find((a) => a.roleKey === MENTOR_ROLE_KEY);
    if (mentor) {
        const open = await optional(() => loadOpenProposals(db, orgId), []);
        add({ kind: 'suggestion', label: 'Suggestions to review', tab: 'mentor' }, open.map((p) => ({ assistantId: mentor.id, id: p.id, title: p.title, at: p.shownAt })));
    }

    return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
}
