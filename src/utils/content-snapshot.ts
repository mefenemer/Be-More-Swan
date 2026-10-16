// src/utils/content-snapshot.ts
// What is in a content assistant's own queue tab right now, for its chat: the Social Media
// assistant's "Posts", the Blog Writer's "Blogs" and the Email Marketing assistant's "Emails".
//
// ── The bug this fixes ───────────────────────────────────────────────────────────────────────────
// All three chats could WRITE work and read none of it. Asked "where's my Thursday post?", "what's
// waiting for me?" or "did the October email go out?", the model had no row to answer from — the
// social prompt's fallback sent it off asking for a topic and improvising the names of screens to
// go and look in, and the blog and email prompts could only say "I can't see that from here". The
// team-activity block lists work already SCHEDULED for the next 7 days, but not its wording, not
// what is waiting in Review, and not what failed — which are the three a user actually asks about.
//
// Same shape as buildLeadsSnapshot (chat-orchestrator.ts), for the same reasons:
//   • read per turn, never cached — approve something in the tab, then ask what is left;
//   • scoped to organisation AND this assistant (the tabs filter by assistant the same way);
//   • counts cover everything, each list is capped and SAYS it is capped;
//   • on failure the loader returns null and the prompt substitutes an admission, never a guess.
//
// Each section is one COLUMN of the tab, built from the same status lists the column reads
// (src/config/post-status.ts for posts; _RQ_BLOG_STATUS / _RQ_NEWSLETTER_STATUS in assistants.js
// for articles and emails), so the column this block names is the column the item is really in.
//
// ⚠️ Never throws.

import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts, newsletterIssues, scheduledPosts } from '../../db/schema';
import { ATTENTION_STATUSES, AWAITING_REVIEW_STATUSES, BOOKED_STATUSES } from '../config/post-status';
import { platformName } from './team-activity';

type Db = ReturnType<typeof getDb>;

/** Cap on listed items per column. Counts are never capped. */
export const SNAPSHOT_LIMIT = 15;
/** A failure, or something already sent, older than this is history rather than conversation. */
export const RECENT_DAYS = 30;
const TEXT_MAX = 90;

export interface SnapshotItem {
    /** When it goes out (or went out). Null for a draft with no date yet. */
    when: Date | null;
    /** A platform name, or '' when the role has only one destination. */
    where: string;
    status: string;
    /** The caption, title or subject — what the user would recognise it by. */
    text: string | null;
    /** Optional extra, e.g. "sent to 412 people". */
    extra?: string | null;
}

export interface SnapshotSection { title: string; items: SnapshotItem[]; total: number }

export interface SnapshotInput {
    /** "posts", "articles", "emails". */
    noun: string;
    /** The tab the sections are columns of: "Posts", "Blogs", "Emails". */
    tab: string;
    sections: SnapshotSection[];
    stateWords: Record<string, string>;
    timezone?: string | null;
}

const fmtWhen = (d: Date, tz?: string | null) => {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) };
    try { return d.toLocaleString('en-GB', opts); } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
};

function line(p: SnapshotItem, stateWords: Record<string, string>, tz?: string | null): string {
    const gist = String(p.text ?? '').replace(/\s+/g, ' ').trim();
    const quoted = gist ? `"${gist.length > TEXT_MAX ? `${gist.slice(0, TEXT_MAX)}…` : gist}"` : '(no text yet)';
    return `- ${[
        p.when ? fmtWhen(p.when, tz) : 'no date yet',
        p.where || null,
        stateWords[p.status] ?? p.status,
        quoted,
        p.extra || null,
    ].filter(Boolean).join(' · ')}`;
}

/** Render the block. Pure — tested without a database. */
export function renderContentSnapshot(input: SnapshotInput): string {
    const { noun, tab, stateWords, timezone } = input;
    const head = `YOUR ${noun.toUpperCase()} RIGHT NOW — this assistant's own ${noun}, read from its "${tab}" tab at the moment this message was sent. Times are in the business's own timezone. These are FACT: when the user asks what is coming up, what is waiting for them, or where a particular one is, answer from here, name the column it is in, and never say you cannot see their ${noun}. If they ask about one that is not listed, say you cannot see it in the list below and point them to the "${tab}" tab — never invent one.`;
    const body = input.sections.map((s) => {
        if (!s.total) return `${s.title}: none.`;
        const more = s.total > s.items.length ? `\n- …and ${s.total - s.items.length} more not listed here` : '';
        return `${s.title} (${s.total}):\n${s.items.map((r) => line(r, stateWords, timezone)).join('\n')}${more}`;
    });
    return [head, ...body].join('\n\n');
}

const since = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** One column: its total and its first SNAPSHOT_LIMIT rows, in one round trip each. */
async function column<T>(
    count: Promise<Array<{ n: number }>>, rows: Promise<T[]>, map: (r: T) => SnapshotItem, title: string,
): Promise<SnapshotSection> {
    const [c, r] = await Promise.all([count, rows]);
    return { title, total: Number(c[0]?.n) || 0, items: r.map(map) };
}

// ── Social Media assistant: the "Posts" tab ──────────────────────────────────────────────────────

const POST_WORDS: Record<string, string> = {
    draft: 'waiting for your approval',
    pending_approval: 'waiting for your approval',
    in_review: 'waiting for your approval — flagged for a closer look',
    approved: 'booked',
    scheduled: 'booked',
    publishing: 'publishing right now',
    paused: 'paused — the account it posts to needs reconnecting (Assistant Profile ▸ Connections)',
    // The X park: our task allowance (a link post costs 10), a pre-cutover X credit allowance, or
    // X's own API quota. All three resume on the 1st; the post's failure_reason says which.
    paused_credits: 'paused — X posting is limited until the 1st (the post\'s note says why)',
    failed: 'failed to publish',
};

export async function buildPostsSnapshot(db: Db, organisationId: number, aiAssistantId: number, timezone?: string | null): Promise<string | null> {
    try {
        const scope = and(eq(scheduledPosts.organisationId, organisationId), eq(scheduledPosts.assistantId, aiAssistantId));
        // Mirrors get-social-drafts: a 'draft' someone has written into IS awaiting review, and the
        // Review column lists it. A blank composer shell is not, and stays out.
        const inReview = or(
            inArray(scheduledPosts.status, [...AWAITING_REVIEW_STATUSES]),
            and(eq(scheduledPosts.status, 'draft'), sql`btrim(coalesce(${scheduledPosts.caption}, '')) <> ''`),
        );
        const booked = inArray(scheduledPosts.status, [...BOOKED_STATUSES]);
        const failed = and(inArray(scheduledPosts.status, [...ATTENTION_STATUSES]), gte(scheduledPosts.publishDate, since(RECENT_DAYS)));
        const cols = { platform: scheduledPosts.platform, status: scheduledPosts.status, publishDate: scheduledPosts.publishDate, caption: scheduledPosts.caption };
        type Row = { platform: string; status: string; publishDate: Date; caption: string | null };
        const map = (r: Row): SnapshotItem => ({ when: r.publishDate, where: platformName(r.platform), status: r.status, text: r.caption });
        const col = (where: SQL | undefined, order: SQL, title: string) => column(
            db.select({ n: sql<number>`count(*)::int` }).from(scheduledPosts).where(and(scope, where)),
            db.select(cols).from(scheduledPosts).where(and(scope, where)).orderBy(order).limit(SNAPSHOT_LIMIT),
            map, title,
        );
        const sections = await Promise.all([
            col(inReview, asc(scheduledPosts.publishDate), 'In the "Review" column — waiting for the user to approve'),
            col(booked, asc(scheduledPosts.publishDate), 'In the "Scheduled" column — approved and booked to publish'),
            col(failed, desc(scheduledPosts.publishDate), `In the "Needs attention" column — tried to publish in the last ${RECENT_DAYS} days and stopped`),
        ]);
        return renderContentSnapshot({ noun: 'posts', tab: 'Posts', sections, stateWords: POST_WORDS, timezone });
    } catch (err) {
        console.error('[content-snapshot] posts read failed (non-fatal)', err);
        return null;
    }
}

// ── Blog Writer: the "Blogs" tab ─────────────────────────────────────────────────────────────────
// Columns as _RQ_BLOG_STATUS reads them: failed, paused and approved-but-unbooked articles are in
// "Needs attention" (they were in no column at all until 2026-10-13).

const BLOG_WORDS: Record<string, string> = {
    draft: 'draft — waiting for your review',
    pending_approval: 'waiting for your approval',
    in_review: 'waiting for your approval — flagged for a closer look',
    approved: 'approved but not yet booked to publish',
    scheduled: 'booked',
    publishing: 'publishing right now',
    published: 'published',
    paused: 'paused',
    failed: 'failed to publish',
};

export async function buildBlogSnapshot(db: Db, organisationId: number, aiAssistantId: number, timezone?: string | null): Promise<string | null> {
    try {
        const scope = and(eq(blogPosts.organisationId, organisationId), eq(blogPosts.assistantId, aiAssistantId));
        const cols = { status: blogPosts.status, publishDate: blogPosts.publishDate, publishedAt: blogPosts.publishedAt, title: blogPosts.title };
        type Row = { status: string; publishDate: Date | null; publishedAt: Date | null; title: string };
        const map = (r: Row): SnapshotItem => ({ when: r.publishedAt ?? r.publishDate, where: '', status: r.status, text: r.title });
        const col = (where: SQL | undefined, order: SQL, title: string) => column(
            db.select({ n: sql<number>`count(*)::int` }).from(blogPosts).where(and(scope, where)),
            db.select(cols).from(blogPosts).where(and(scope, where)).orderBy(order).limit(SNAPSHOT_LIMIT),
            map, title,
        );
        const sections = await Promise.all([
            col(inArray(blogPosts.status, ['draft', 'pending_approval', 'in_review']), sql`${blogPosts.publishDate} ASC NULLS LAST`, 'In the "Review" column — drafts waiting for the user'),
            col(inArray(blogPosts.status, ['scheduled', 'publishing']), asc(blogPosts.publishDate), 'In the "Scheduled" column — booked to publish'),
            col(and(eq(blogPosts.status, 'published'), gte(blogPosts.publishedAt, since(RECENT_DAYS))), desc(blogPosts.publishedAt), `In the "Posted" column — published in the last ${RECENT_DAYS} days`),
            col(inArray(blogPosts.status, ['failed', 'paused', 'approved']), desc(blogPosts.updatedAt), 'In the "Needs attention" column — failed to publish, paused, or approved but not booked; the user picks a new time there'),
        ]);
        return renderContentSnapshot({ noun: 'articles', tab: 'Blogs', sections, stateWords: BLOG_WORDS, timezone });
    } catch (err) {
        console.error('[content-snapshot] blog read failed (non-fatal)', err);
        return null;
    }
}

// ── Email Marketing assistant: the "Emails" tab ──────────────────────────────────────────────────
// Columns as _RQ_NEWSLETTER_STATUS reads them; the "Posted" column is labelled "Sent" on this role.

const EMAIL_WORDS: Record<string, string> = {
    draft: 'draft — waiting for your review',
    pending_approval: 'waiting for your approval',
    in_review: 'waiting for your approval — flagged for a closer look',
    approved: 'approved — waiting to be sent or scheduled',
    scheduled: 'booked to send',
    sending: 'sending right now',
    sent: 'sent',
    failed: 'failed to send',
};

export async function buildEmailsSnapshot(db: Db, organisationId: number, aiAssistantId: number, timezone?: string | null): Promise<string | null> {
    try {
        const scope = and(eq(newsletterIssues.organisationId, organisationId), eq(newsletterIssues.assistantId, aiAssistantId));
        const cols = {
            status: newsletterIssues.status, subject: newsletterIssues.subject, scheduledFor: newsletterIssues.scheduledFor,
            sentAt: newsletterIssues.sentAt, recipientCount: newsletterIssues.recipientCount,
        };
        type Row = { status: string; subject: string; scheduledFor: Date | null; sentAt: Date | null; recipientCount: number };
        const map = (r: Row): SnapshotItem => ({
            when: r.sentAt ?? r.scheduledFor, where: '', status: r.status, text: r.subject,
            extra: r.status === 'sent' && r.recipientCount ? `sent to ${r.recipientCount} ${r.recipientCount === 1 ? 'person' : 'people'}` : null,
        });
        const col = (where: SQL | undefined, order: SQL, title: string) => column(
            db.select({ n: sql<number>`count(*)::int` }).from(newsletterIssues).where(and(scope, where)),
            db.select(cols).from(newsletterIssues).where(and(scope, where)).orderBy(order).limit(SNAPSHOT_LIMIT),
            map, title,
        );
        const sections = await Promise.all([
            col(inArray(newsletterIssues.status, ['draft', 'pending_approval', 'in_review']), desc(newsletterIssues.updatedAt), 'In the "Review" column — drafts waiting for the user'),
            col(eq(newsletterIssues.status, 'approved'), desc(newsletterIssues.updatedAt), 'In the "Approved" column — approved, not yet sent or scheduled'),
            col(eq(newsletterIssues.status, 'scheduled'), asc(newsletterIssues.scheduledFor), 'In the "Scheduled" column — booked to send'),
            col(and(inArray(newsletterIssues.status, ['sending', 'sent']), gte(newsletterIssues.updatedAt, since(RECENT_DAYS))), desc(newsletterIssues.sentAt), `In the "Sent" column — sent in the last ${RECENT_DAYS} days`),
            col(and(eq(newsletterIssues.status, 'failed'), gte(newsletterIssues.updatedAt, since(RECENT_DAYS))), desc(newsletterIssues.updatedAt), `In the "Needs attention" column — failed to send in the last ${RECENT_DAYS} days`),
        ]);
        return renderContentSnapshot({ noun: 'emails', tab: 'Emails', sections, stateWords: EMAIL_WORDS, timezone });
    } catch (err) {
        console.error('[content-snapshot] emails read failed (non-fatal)', err);
        return null;
    }
}
