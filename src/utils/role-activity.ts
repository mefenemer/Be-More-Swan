// src/utils/role-activity.ts
// The work each assistant actually does, for its Activity tab — added to get-assistant-activity's
// shared feed for every role whose work does not live in the content tables.
//
// get-assistant-activity reads generation jobs, scheduled posts, post ideas and media jobs. That is
// the Social Media Assistant's whole working life, and almost none of anyone else's: the Email
// Marketing Assistant's emails, the Blog Writer's published articles, the Campaign Assistant's
// orders, the Brand Designer's briefs and every records assistant's invoices, tickets, enrichments
// and meetings appeared NOWHERE — their Activity tab showed setup events and settings changes and
// read as an assistant that had done nothing. Each role below adds the rows its work really writes.
//
// Item shape = get-assistant-activity's (one renderer, one meaning of "Needs attention"). The
// descriptions carry user and model text (titles, subjects); the renderer escapes them.

import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    assistantRecords, blogPosts, campaignDecisions, campaignOrders, campaigns, newsletterIssues, newsletterSequences,
    taskRuns, visualBriefOptions, visualBriefs,
} from '../../db/schema';

type Db = ReturnType<typeof getDb>;
export type ActivityStatus = 'success' | 'failed' | 'needs_input' | 'in_progress' | 'info';
export interface ActivityItem { id: string; type: string; icon: string; description: string; createdAt: Date; status: ActivityStatus }

/** What each records role calls one of its records, for "Recorded an invoice: …". */
const RECORD_NOUNS: Record<string, { type: string; made: string; noun: string }> = {
    accounts_receivable_clerk: { type: 'invoice', made: 'Picked up an overdue invoice', noun: 'invoice' },
    tier1_support_agent: { type: 'ticket', made: 'Triaged a support ticket', noun: 'ticket' },
    crm_enricher: { type: 'enrichment', made: 'Proposed updates to a record', noun: 'update' },
    meeting_note_taker: { type: 'meeting', made: 'Wrote up a meeting', noun: 'meeting' },
};

/** The roles this module adds rows for. Anything else gets the shared feed unchanged. */
export const ROLE_ACTIVITY_ROLES = new Set([...Object.keys(RECORD_NOUNS), 'newsletter_editor', 'blog_writer', 'campaign_orchestrator', 'brand_designer']);

const clip = (s: string | null | undefined, n = 70) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export async function roleActivityItems(db: Db, args: {
    orgId: number; assistantId: number; roleKey: string | null; cutoff: Date | null; limit: number;
}): Promise<ActivityItem[]> {
    const { orgId, assistantId, roleKey, cutoff, limit } = args;
    if (!roleKey || !ROLE_ACTIVITY_ROLES.has(roleKey)) return [];
    const since = (col: any) => (cutoff ? [gte(col, cutoff)] : []);
    const items: ActivityItem[] = [];

    // Records roles: each record made, and each one the user decided. Plus the runs behind them —
    // "it looked and found nothing" and "nothing happened" are different answers.
    const rec = RECORD_NOUNS[roleKey];
    if (rec) {
        const rows = await db.select({
            id: assistantRecords.id, title: assistantRecords.title, approvalStatus: assistantRecords.approvalStatus,
            createdAt: assistantRecords.createdAt, updatedAt: assistantRecords.updatedAt,
        }).from(assistantRecords).where(and(
            eq(assistantRecords.organisationId, orgId), eq(assistantRecords.aiAssistantId, assistantId),
            eq(assistantRecords.recordType, rec.type), ...since(assistantRecords.updatedAt),
        )).orderBy(desc(assistantRecords.updatedAt)).limit(limit);
        for (const r of rows) {
            if (!cutoff || r.createdAt >= cutoff) {
                items.push({ id: `rec-${r.id}`, type: 'record', icon: 'sparkles', description: `${rec.made}: ${clip(r.title)}.`, createdAt: r.createdAt, status: r.approvalStatus === 'pending_approval' ? 'needs_input' : 'info' });
            }
            // A decision is only told apart from the creation by time — a minute's gap or more.
            const decided = r.updatedAt.getTime() - r.createdAt.getTime() > 60_000;
            if (decided && (r.approvalStatus === 'approved' || r.approvalStatus === 'scheduled')) {
                items.push({ id: `rec-ok-${r.id}`, type: 'record_decision', icon: 'check', description: `You approved the ${rec.noun}: ${clip(r.title)}.`, createdAt: r.updatedAt, status: 'success' });
            } else if (decided && r.approvalStatus === 'rejected') {
                items.push({ id: `rec-no-${r.id}`, type: 'record_decision', icon: 'x', description: `You turned down the ${rec.noun}: ${clip(r.title)}.`, createdAt: r.updatedAt, status: 'info' });
            }
        }
        const runs = await db.select({ id: taskRuns.id, taskType: taskRuns.taskType, status: taskRuns.status, completedAt: taskRuns.completedAt, createdAt: taskRuns.createdAt })
            .from(taskRuns).where(and(eq(taskRuns.organisationId, orgId), eq(taskRuns.assistantId, assistantId), ...since(taskRuns.createdAt)))
            .orderBy(desc(taskRuns.createdAt)).limit(limit);
        for (const r of runs) {
            if (r.status !== 'failed') continue;   // a finished run is already the record above; a failed one is news
            items.push({ id: `run-${r.id}`, type: 'task_run', icon: 'alert', description: `A ${String(r.taskType || 'task').replace(/_/g, ' ')} run failed.`, createdAt: (r.completedAt ?? r.createdAt) as Date, status: 'failed' });
        }
    }

    if (roleKey === 'newsletter_editor') {
        const issues = await db.select({
            id: newsletterIssues.id, subject: newsletterIssues.subject, status: newsletterIssues.status, sentAt: newsletterIssues.sentAt,
            recipientCount: newsletterIssues.recipientCount, failureReason: newsletterIssues.failureReason, createdAt: newsletterIssues.createdAt,
        }).from(newsletterIssues).where(and(
            eq(newsletterIssues.organisationId, orgId), eq(newsletterIssues.assistantId, assistantId), ...since(newsletterIssues.updatedAt),
        )).orderBy(desc(newsletterIssues.updatedAt)).limit(limit);
        for (const i of issues) {
            const subject = clip(i.subject) || 'an untitled email';
            if (!cutoff || i.createdAt >= cutoff) {
                items.push({ id: `nl-${i.id}`, type: 'newsletter_issue', icon: 'edit', description: `Drafted the email "${subject}".`, createdAt: i.createdAt, status: i.status === 'pending_approval' || i.status === 'in_review' ? 'needs_input' : 'info' });
            }
            if (i.status === 'sent' && i.sentAt && (!cutoff || i.sentAt >= cutoff)) {
                items.push({ id: `nl-sent-${i.id}`, type: 'newsletter_sent', icon: 'rocket', description: `Sent "${subject}"${i.recipientCount ? ` to ${i.recipientCount} ${i.recipientCount === 1 ? 'person' : 'people'}` : ''}.`, createdAt: i.sentAt, status: 'success' });
            }
            if (i.status === 'failed') {
                items.push({ id: `nl-fail-${i.id}`, type: 'newsletter_failed', icon: 'alert', description: `"${subject}" could not be sent${i.failureReason ? `: ${clip(i.failureReason, 90)}` : ''}.`, createdAt: i.createdAt, status: 'failed' });
            }
        }
        const seqs = await db.select({ id: newsletterSequences.id, name: newsletterSequences.name, enabledAt: newsletterSequences.enabledAt, createdAt: newsletterSequences.createdAt })
            .from(newsletterSequences).where(and(eq(newsletterSequences.organisationId, orgId), eq(newsletterSequences.assistantId, assistantId), ...since(newsletterSequences.updatedAt)))
            .orderBy(desc(newsletterSequences.updatedAt)).limit(limit);
        for (const q of seqs) {
            if (!cutoff || q.createdAt >= cutoff) items.push({ id: `seq-${q.id}`, type: 'newsletter_sequence', icon: 'edit', description: `Wrote the email campaign "${clip(q.name)}".`, createdAt: q.createdAt, status: 'info' });
            if (q.enabledAt && (!cutoff || q.enabledAt >= cutoff)) items.push({ id: `seq-on-${q.id}`, type: 'newsletter_sequence_on', icon: 'rocket', description: `The email campaign "${clip(q.name)}" was switched on.`, createdAt: q.enabledAt, status: 'success' });
        }
    }

    if (roleKey === 'blog_writer') {
        // Drafting already shows through the generation jobs in the shared feed; what was missing is
        // the article going LIVE — the moment the whole role exists for.
        const posts = await db.select({ id: blogPosts.id, title: blogPosts.title, publishedAt: blogPosts.publishedAt })
            .from(blogPosts).where(and(
                eq(blogPosts.organisationId, orgId), eq(blogPosts.assistantId, assistantId), eq(blogPosts.status, 'published'),
                isNotNull(blogPosts.publishedAt), ...since(blogPosts.publishedAt),
            )).orderBy(desc(blogPosts.publishedAt)).limit(limit);
        for (const p of posts) items.push({ id: `blog-live-${p.id}`, type: 'blog_published', icon: 'rocket', description: `Published "${clip(p.title) || 'an article'}".`, createdAt: p.publishedAt!, status: 'success' });
    }

    if (roleKey === 'campaign_orchestrator') {
        const orders = await db.select({
            id: campaignOrders.id, action: campaignOrders.action, status: campaignOrders.status, resultSummary: campaignOrders.resultSummary,
            createdAt: campaignOrders.createdAt, deliveredAt: campaignOrders.deliveredAt, objective: campaigns.objective,
        }).from(campaignOrders).innerJoin(campaigns, eq(campaigns.id, campaignOrders.campaignId)).where(and(
            eq(campaignOrders.organisationId, orgId), eq(campaigns.aiAssistantId, assistantId), ...since(campaignOrders.updatedAt),
        )).orderBy(desc(campaignOrders.updatedAt)).limit(limit);
        for (const o of orders) {
            const what = o.action.replace(/_/g, ' ');
            if (!cutoff || o.createdAt >= cutoff) items.push({ id: `ord-${o.id}`, type: 'campaign_order', icon: 'users', description: `Briefed work for "${clip(o.objective, 50)}": ${what}.`, createdAt: o.createdAt, status: 'info' });
            if (o.status === 'delivered' && o.deliveredAt) items.push({ id: `ord-ok-${o.id}`, type: 'campaign_order_done', icon: 'check-circle', description: `Delivered: ${what}${o.resultSummary ? ` — ${clip(o.resultSummary, 80)}` : ''}.`, createdAt: o.deliveredAt, status: 'success' });
            if (o.status === 'cancelled') items.push({ id: `ord-x-${o.id}`, type: 'campaign_order_failed', icon: 'alert', description: `Could not do: ${what}${o.resultSummary ? ` — ${clip(o.resultSummary, 80)}` : ''}.`, createdAt: o.createdAt, status: 'failed' });
        }
        const decisions = await db.select({ id: campaignDecisions.id, title: campaignDecisions.title, status: campaignDecisions.status, createdAt: campaignDecisions.createdAt, decidedAt: campaignDecisions.decidedAt })
            .from(campaignDecisions).innerJoin(campaigns, eq(campaigns.id, campaignDecisions.campaignId)).where(and(
                eq(campaignDecisions.organisationId, orgId), eq(campaigns.aiAssistantId, assistantId), ...since(campaignDecisions.createdAt),
            )).orderBy(desc(campaignDecisions.createdAt)).limit(limit);
        for (const d of decisions) {
            items.push({ id: `dec-${d.id}`, type: 'campaign_decision', icon: 'lightbulb', description: `Put a decision to you: ${clip(d.title)}.`, createdAt: d.createdAt, status: d.status === 'pending' ? 'needs_input' : 'info' });
        }
    }

    if (roleKey === 'brand_designer') {
        const briefs = await db.select({ id: visualBriefs.id, title: visualBriefs.title, status: visualBriefs.status, generationNote: visualBriefs.generationNote, createdAt: visualBriefs.createdAt })
            .from(visualBriefs).where(and(eq(visualBriefs.organisationId, orgId), eq(visualBriefs.aiAssistantId, assistantId), ...since(visualBriefs.updatedAt)))
            .orderBy(desc(visualBriefs.updatedAt)).limit(limit);
        for (const b of briefs) {
            if (!cutoff || b.createdAt >= cutoff) {
                items.push({ id: `brief-${b.id}`, type: 'visual_brief', icon: 'image', description: `New brief: ${clip(b.title)}.`, createdAt: b.createdAt, status: b.status === 'in_review' ? 'needs_input' : 'info' });
            }
        }
        const approved = await db.select({ id: visualBriefOptions.id, decidedAt: visualBriefOptions.decidedAt, title: visualBriefs.title })
            .from(visualBriefOptions).innerJoin(visualBriefs, eq(visualBriefs.id, visualBriefOptions.briefId)).where(and(
                eq(visualBriefOptions.organisationId, orgId), eq(visualBriefs.aiAssistantId, assistantId),
                eq(visualBriefOptions.status, 'approved'), isNotNull(visualBriefOptions.decidedAt), ...since(visualBriefOptions.decidedAt),
            )).orderBy(desc(visualBriefOptions.decidedAt)).limit(limit);
        for (const a of approved) items.push({ id: `opt-ok-${a.id}`, type: 'visual_option_approved', icon: 'check-circle', description: `You approved a picture for "${clip(a.title, 50)}" — it's in your library.`, createdAt: a.decidedAt!, status: 'success' });
    }

    return items;
}

/** For tests: the record type each records role writes. */
export const ROLE_RECORD_TYPES: Record<string, string> = Object.fromEntries(Object.entries(RECORD_NOUNS).map(([k, v]) => [k, v.type]));
