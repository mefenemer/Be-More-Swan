// src/utils/roi-activity.ts
// The ONE definition of "work an assistant did", shared by every surface that reports it:
//   • netlify/functions/roi-stats.ts        — the workspace dashboard hero (Hours Saved / Tasks
//                                             Handled / Estimated Money Saved)
//   • netlify/functions/get-time-saved.ts   — the "See the tasks behind this" modal
//   • netlify/functions/get-assistant-metrics.ts — one assistant's own page
//
// ── Why this module exists ──────────────────────────────────────────────────────────────────────
// All three used to hand-roll the same three counts, with comments in each promising they stayed
// "consistent" with the others by being kept in step manually. They were not, and the dashboard
// aggregate was wrong in two independent ways:
//
//   1. It counted the `leads` table. That is **Be More Swan's OWN** trial/upgrade sales pipeline
//      (db/schema.ts:135 — writers are contact.ts, capture-lead.ts, identify-leads.ts,
//      billing-cancel.ts, inbound-email.ts), NOT the tenant's leads. Its `organisation_id` is the
//      org the BMS-side opportunity is ABOUT, so a tenant's "Tasks Handled" was being inflated by
//      Be More Swan's own upsell notes about them. A tenant's Lead Generator leads live in
//      `assistant_records` (record_type='lead') and `discovered_leads`. See the collision warning
//      at db/schema.ts:3273 before writing any lead query.
//
//   2. It counted only `scheduled_posts` and `task_runs`. Everything every other assistant
//      produces — leads, meetings, tickets, invoices, enrichments, campaign orders and decisions,
//      blog posts — lands in `assistant_records` or `blog_posts` and was worth exactly zero hours.
//      So a workspace whose active assistants were a Lead Generator and a Meeting Note Taker read
//      0 hrs / 0 tasks / £0 no matter how much work they had done, which is what "it isn't
//      aggregating from all active assistants" looks like from the outside.
//
// ── The property that makes aggregation genuine ─────────────────────────────────────────────────
// `assistant_records.ai_assistant_id` is NOT NULL and `blog_posts.assistant_id` /
// `scheduled_posts.assistant_id` / `task_runs.assistant_id` are all attributable. That is the whole
// reason the fix is possible: every counted row can be scoped to a specific non-archived assistant,
// so the org total is the sum over active assistants rather than "org-wide, hope for the best".
// `leads` had no assistant column at all, which is why the old code could only gate it on "does
// this org have ANY active assistant" — a tell that it was the wrong table.

import { and, count, eq, gte, inArray, ne, notInArray, sql } from 'drizzle-orm';
import {
    aiAssistants, assistantRecords, blogPosts, newsletterIssues, scheduledPosts, taskRuns,
} from '../../db/schema';
import { getTimeMultipliers, type TimeMultipliers } from './platform-config';

/**
 * Minimal structural type for a drizzle handle, so this module works with the top-level db from
 * getDb() and with a transaction handle without importing either concrete type.
 */
type Db = {
    select: (fields?: any) => any;
};

/**
 * Which `assistant_records.record_type` values count as delivered work, and which multiplier key
 * each is priced with.
 *
 * ⚠️ `lead_idea` is deliberately ABSENT. It is a proposal the assistant offers before any discovery
 * run happens; approving one creates a discovery_campaign whose output is then counted as `lead`
 * rows. Counting both would bill the user's dashboard twice for one piece of work — once for
 * suggesting it and again for doing it.
 *
 * The keys here must stay a subset of the assistant_records_type_check CHECK constraint
 * (db/schema.ts:3113). A record type present in the DB but missing here contributes zero rather
 * than throwing, which is the safe direction, but it also means a NEW record type silently does not
 * count until it is added — add it here in the same change that introduces it.
 */
export const RECORD_TYPE_MULTIPLIER: Readonly<Record<string, keyof TimeMultipliers>> = {
    lead: 'leads_generated',
    enrichment: 'record_enriched',
    meeting: 'meeting_summarised',
    invoice: 'invoice_processed',
    ticket: 'ticket_handled',
    campaign_order: 'campaign_managed',
    campaign_decision: 'campaign_managed',
};

/** Human labels for the per-source breakdown the "tasks behind this" modal renders. */
export const RECORD_TYPE_LABEL: Readonly<Record<string, string>> = {
    lead: 'Leads generated',
    enrichment: 'Records enriched',
    meeting: 'Meetings summarised',
    invoice: 'Invoices processed',
    ticket: 'Tickets handled',
    campaign_order: 'Campaign orders',
    campaign_decision: 'Campaign decisions',
};


/**
 * A record the user turned down is not work they received value from. Mirrors the DISCARDED_STATUSES
 * exclusion already applied to scheduled_posts on the assistant page — a rejected draft has never
 * counted there, and a rejected lead should not count here.
 */
export const REJECTED = 'rejected';

/** scheduled_posts statuses that represent a post the user discarded rather than received. */
export const DISCARDED_POST_STATUSES = ['rejected', 'cancelled', 'admin_test'];

/** blog_posts statuses that represent a discarded draft. */
export const DISCARDED_BLOG_STATUSES = ['rejected', 'cancelled', 'archived'];

/**
 * newsletter_issues statuses that represent an issue the user discarded rather than received.
 *
 * ⚠️ 'failed' is NOT here. A send that failed still cost the assistant the whole draft, and the
 * work is sitting there ready to retry — pricing it at zero would tell a customer their assistant
 * did nothing on the week its sending domain lapsed.
 */
export const DISCARDED_NEWSLETTER_STATUSES = ['rejected', 'archived'];

/** Record types this module prices, exported so the itemised modal selects the same set. */
export const COUNTED_RECORD_TYPES_LIST: readonly string[] = Object.keys(RECORD_TYPE_MULTIPLIER);

export interface RoiActivityLine {
    /** Stable machine key: 'posts' | 'task_runs' | 'blog' | a record_type. */
    key: string;
    label: string;
    count: number;
    minutes: number;
}

export interface RoiActivity {
    /** Ids the counts were scoped to. Empty ⇒ every figure below is 0. */
    assistantIds: number[];
    /** Total countable items across every source. This is the "Tasks Handled" tile. */
    completedTasks: number;
    totalMinutes: number;
    /** Total minutes / 60, to 1dp. This is the "Hours Saved" tile. */
    hoursSaved: number;
    /** Mean minutes per item — drives the tasks-to-break-even estimate. */
    avgTaskDurationMinutes: number;
    /** Per-source detail, highest first, zero-count sources omitted. */
    breakdown: RoiActivityLine[];
    /**
     * True when at least one source query failed and was defaulted to 0, so a caller can decline to
     * present the number as authoritative. Never throws — see safeCount.
     */
    degraded: boolean;
}

/**
 * The ids of an org's assistants whose work should count.
 *
 * "Active" == not archived, matching assistant-capabilities.ts and the My Assistants visible list.
 * An archived assistant's historical output must stop inflating the org total the moment it is
 * retired; a paused or provisioning one has still done the work it did, so it stays counted.
 */
export async function activeAssistantIds(db: Db, organisationId: number | null): Promise<number[]> {
    if (!organisationId) return [];
    try {
        const rows = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.organisationId, organisationId),
                ne(aiAssistants.lifecycleStatus, 'archived'),
            ));
        return rows.map((r: { id: number }) => r.id);
    } catch (err) {
        console.error('[roi-activity] could not resolve active assistants, treating as none', err);
        return [];
    }
}

/**
 * Count one activity source, defaulting to 0 on error.
 *
 * Issue #149: a single failing count used to 500 the whole endpoint, which left the dashboard tiles
 * stuck in their loading skeletons — a blank widget rather than a slightly-wrong one. Each source is
 * isolated for that reason. The `degraded` flag carries the fact that it happened, because silently
 * reporting a smaller number as if it were the truth is its own bug.
 */
async function safeCount(query: Promise<{ count: number }[]>, onError: () => void): Promise<number> {
    try {
        const [row] = await query;
        return Number(row?.count ?? 0);
    } catch (err) {
        console.error('[roi-activity] activity count query failed, defaulting to 0', err);
        onError();
        return 0;
    }
}

export interface CountRoiActivityOptions {
    organisationId: number | null;
    /** Restrict to these assistants. Pass the result of activeAssistantIds() for an org total, or a
     *  single id for one assistant's page. */
    assistantIds: number[];
    /** Inclusive lower bound on the activity's timestamp. */
    windowStart: Date;
    /** Reuse an already-fetched multiplier set (both roi-stats calls this twice per request). */
    multipliers?: TimeMultipliers;
}

/**
 * Count everything an org's (or one assistant's) active assistants produced in a window, and price
 * it in minutes.
 *
 * Every source is scoped by BOTH organisationId and assistantIds. The org scope is not redundant:
 * assistantIds is derived from the org, but keeping the tenant predicate on each query means a bug
 * in the id resolution cannot leak another tenant's rows into a count — and these tables are all
 * indexed org-first.
 */
export async function countRoiActivity(db: Db, opts: CountRoiActivityOptions): Promise<RoiActivity> {
    const { organisationId, assistantIds, windowStart } = opts;
    const empty: RoiActivity = {
        assistantIds: [], completedTasks: 0, totalMinutes: 0, hoursSaved: 0,
        avgTaskDurationMinutes: 0, breakdown: [], degraded: false,
    };
    if (!organisationId || assistantIds.length === 0) return empty;

    const mult = opts.multipliers ?? await getTimeMultipliers();
    let degraded = false;
    const markDegraded = () => { degraded = true; };

    // Windowed on COALESCE(completed_at, created_at), not created_at alone: a run created before the
    // period boundary but only completing after it — the normal case right after a week or month
    // rolls over — was otherwise dropped entirely, zeroing the widget despite completed work in the
    // window (issue #110).
    //
    // ⚠️ The comparand must be an ISO STRING, not a Date. A raw sql`` fragment has no column type,
    // so drizzle passes a Date through to postgres-js unserialised and the bind step throws
    // ERR_INVALID_ARG_TYPE — a 500 on every call. See [[raw-sql-date-param-trap]].
    const taskRunQ = db.select({ count: count() })
        .from(taskRuns)
        .where(and(
            eq(taskRuns.organisationId, organisationId),
            inArray(taskRuns.assistantId, assistantIds),
            eq(taskRuns.status, 'completed'),
            gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, windowStart.toISOString()),
        ));

    const postQ = db.select({ count: count() })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.organisationId, organisationId),
            inArray(scheduledPosts.assistantId, assistantIds),
            // notInArray, NOT a raw sql`… not in ${array}`: drizzle interpolates a JS array into a
            // raw fragment as a ROW constructor, which postgres rejects with 42809 rather than
            // behaving as a list. See [[drizzle-array-any-42809]].
            notInArray(scheduledPosts.status, DISCARDED_POST_STATUSES),
            gte(scheduledPosts.createdAt, windowStart),
        ));

    const blogQ = db.select({ count: count() })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.organisationId, organisationId),
            inArray(blogPosts.assistantId, assistantIds),
            notInArray(blogPosts.status, DISCARDED_BLOG_STATUSES),
            gte(blogPosts.createdAt, windowStart),
        ));

    // Counted on CREATION, like blog posts — an issue drafted and waiting for approval is work the
    // assistant has already done, and a customer who reads the figure before pressing Approve
    // should not see it jump afterwards.
    const newsletterQ = db.select({ count: count() })
        .from(newsletterIssues)
        .where(and(
            eq(newsletterIssues.organisationId, organisationId),
            inArray(newsletterIssues.assistantId, assistantIds),
            notInArray(newsletterIssues.status, DISCARDED_NEWSLETTER_STATUSES),
            gte(newsletterIssues.createdAt, windowStart),
        ));

    // One grouped query rather than seven counts: the record types share an index
    // (assistant_records_org_assistant_type_idx) and the grain we want out is exactly its prefix.
    const recordQ = db
        .select({ recordType: assistantRecords.recordType, count: count() })
        .from(assistantRecords)
        .where(and(
            eq(assistantRecords.organisationId, organisationId),
            inArray(assistantRecords.aiAssistantId, assistantIds),
            inArray(assistantRecords.recordType, [...COUNTED_RECORD_TYPES_LIST]),
            ne(assistantRecords.approvalStatus, REJECTED),
            gte(assistantRecords.createdAt, windowStart),
        ))
        .groupBy(assistantRecords.recordType);

    const [taskRunCount, postCount, blogCount, newsletterCount, recordRows] = await Promise.all([
        safeCount(taskRunQ, markDegraded),
        safeCount(postQ, markDegraded),
        safeCount(blogQ, markDegraded),
        safeCount(newsletterQ, markDegraded),
        (async (): Promise<{ recordType: string; count: number }[]> => {
            try { return await recordQ; } catch (err) {
                console.error('[roi-activity] assistant_records count failed, defaulting to none', err);
                markDegraded();
                return [];
            }
        })(),
    ]);

    const breakdown: RoiActivityLine[] = [];
    const push = (key: string, label: string, n: number, perItem: number) => {
        if (n > 0) breakdown.push({ key, label, count: n, minutes: n * perItem });
    };
    push('posts', 'Social posts drafted', postCount, mult.content_drafted);
    push('task_runs', 'Tasks completed', taskRunCount, mult.tasks_completed);
    push('blog', 'Blog posts written', blogCount, mult.blog_drafted);
    push('newsletter', 'Newsletter issues written', newsletterCount, mult.newsletter_drafted);
    for (const row of recordRows) {
        const key = String(row.recordType);
        const multKey = RECORD_TYPE_MULTIPLIER[key];
        if (!multKey) continue;
        push(key, RECORD_TYPE_LABEL[key] ?? key, Number(row.count), mult[multKey]);
    }
    breakdown.sort((x, y) => y.minutes - x.minutes);

    const completedTasks = breakdown.reduce((s, l) => s + l.count, 0);
    const totalMinutes = breakdown.reduce((s, l) => s + l.minutes, 0);

    return {
        assistantIds,
        completedTasks,
        totalMinutes,
        hoursSaved: parseFloat((totalMinutes / 60).toFixed(1)),
        // Falling back to the task multiplier keeps the break-even estimate finite when nothing has
        // happened yet, rather than dividing by zero.
        avgTaskDurationMinutes: completedTasks > 0 ? totalMinutes / completedTasks : mult.tasks_completed,
        breakdown,
        degraded,
    };
}

/**
 * The same figures, split PER ASSISTANT, for list endpoints (the My Assistants cards).
 *
 * Four grouped queries regardless of how many assistants the org has — calling countRoiActivity in
 * a loop would be 4×N round trips on a page that renders every assistant at once. The per-assistant
 * totals sum exactly to countRoiActivity()'s org total over the same ids and window, because both
 * apply the identical predicates; that identity is what stops the cards, the assistant page and the
 * dashboard hero from disagreeing, which is the bug this module was written to end.
 *
 * Assistants with no activity are present in the map with zeroed figures, so a caller can render a
 * card for every id it asked about without null-checking.
 */
export async function countRoiActivityByAssistant(
    db: Db,
    opts: CountRoiActivityOptions,
): Promise<Map<number, RoiActivity>> {
    const { organisationId, assistantIds, windowStart } = opts;
    const out = new Map<number, RoiActivity>();
    const blank = (id: number): RoiActivity => ({
        assistantIds: [id], completedTasks: 0, totalMinutes: 0, hoursSaved: 0,
        avgTaskDurationMinutes: 0, breakdown: [], degraded: false,
    });
    for (const id of assistantIds) out.set(id, blank(id));
    if (!organisationId || assistantIds.length === 0) return out;

    const mult = opts.multipliers ?? await getTimeMultipliers();

    type Grouped = { assistantId: number | null; c: number };
    const safeGroup = async (q: Promise<Grouped[]>): Promise<Grouped[]> => {
        try { return await q; } catch (err) {
            console.error('[roi-activity] grouped count failed, defaulting to none', err);
            return [];
        }
    };

    const [postRows, taskRows, blogRows, newsletterRows, recordRows] = await Promise.all([
        safeGroup(db.select({ assistantId: scheduledPosts.assistantId, c: sql<number>`count(*)::int` })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, organisationId),
                inArray(scheduledPosts.assistantId, assistantIds),
                notInArray(scheduledPosts.status, DISCARDED_POST_STATUSES),
                gte(scheduledPosts.createdAt, windowStart),
            ))
            .groupBy(scheduledPosts.assistantId)),

        safeGroup(db.select({ assistantId: taskRuns.assistantId, c: sql<number>`count(*)::int` })
            .from(taskRuns)
            .where(and(
                eq(taskRuns.organisationId, organisationId),
                inArray(taskRuns.assistantId, assistantIds),
                eq(taskRuns.status, 'completed'),
                gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, windowStart.toISOString()),
            ))
            .groupBy(taskRuns.assistantId)),

        safeGroup(db.select({ assistantId: blogPosts.assistantId, c: sql<number>`count(*)::int` })
            .from(blogPosts)
            .where(and(
                eq(blogPosts.organisationId, organisationId),
                inArray(blogPosts.assistantId, assistantIds),
                notInArray(blogPosts.status, DISCARDED_BLOG_STATUSES),
                gte(blogPosts.createdAt, windowStart),
            ))
            .groupBy(blogPosts.assistantId)),

        safeGroup(db.select({ assistantId: newsletterIssues.assistantId, c: sql<number>`count(*)::int` })
            .from(newsletterIssues)
            .where(and(
                eq(newsletterIssues.organisationId, organisationId),
                inArray(newsletterIssues.assistantId, assistantIds),
                notInArray(newsletterIssues.status, DISCARDED_NEWSLETTER_STATUSES),
                gte(newsletterIssues.createdAt, windowStart),
            ))
            .groupBy(newsletterIssues.assistantId)),

        (async (): Promise<{ assistantId: number; recordType: string; c: number }[]> => {
            try {
                return await db.select({
                    assistantId: assistantRecords.aiAssistantId,
                    recordType: assistantRecords.recordType,
                    c: sql<number>`count(*)::int`,
                })
                    .from(assistantRecords)
                    .where(and(
                        eq(assistantRecords.organisationId, organisationId),
                        inArray(assistantRecords.aiAssistantId, assistantIds),
                        inArray(assistantRecords.recordType, [...COUNTED_RECORD_TYPES_LIST]),
                        ne(assistantRecords.approvalStatus, REJECTED),
                        gte(assistantRecords.createdAt, windowStart),
                    ))
                    .groupBy(assistantRecords.aiAssistantId, assistantRecords.recordType);
            } catch (err) {
                console.error('[roi-activity] grouped assistant_records count failed', err);
                return [];
            }
        })(),
    ]);

    const add = (id: number | null, key: string, label: string, n: number, perItem: number) => {
        if (id == null || n <= 0) return;
        const entry = out.get(id);
        if (!entry) return;   // an id we were not asked about — ignore rather than invent a card
        entry.breakdown.push({ key, label, count: n, minutes: n * perItem });
    };

    postRows.forEach(r => add(r.assistantId, 'posts', 'Social posts drafted', Number(r.c), mult.content_drafted));
    taskRows.forEach(r => add(r.assistantId, 'task_runs', 'Tasks completed', Number(r.c), mult.tasks_completed));
    blogRows.forEach(r => add(r.assistantId, 'blog', 'Blog posts written', Number(r.c), mult.blog_drafted));
    newsletterRows.forEach(r => add(r.assistantId, 'newsletter', 'Newsletter issues written', Number(r.c), mult.newsletter_drafted));
    for (const r of recordRows) {
        const type = String(r.recordType);
        const multKey = RECORD_TYPE_MULTIPLIER[type];
        if (!multKey) continue;
        add(r.assistantId, type, RECORD_TYPE_LABEL[type] ?? type, Number(r.c), mult[multKey]);
    }

    for (const entry of out.values()) {
        entry.breakdown.sort((x, y) => y.minutes - x.minutes);
        entry.completedTasks = entry.breakdown.reduce((s, l) => s + l.count, 0);
        entry.totalMinutes = entry.breakdown.reduce((s, l) => s + l.minutes, 0);
        entry.hoursSaved = parseFloat((entry.totalMinutes / 60).toFixed(1));
        entry.avgTaskDurationMinutes = entry.completedTasks > 0
            ? entry.totalMinutes / entry.completedTasks
            : mult.tasks_completed;
    }
    return out;
}
