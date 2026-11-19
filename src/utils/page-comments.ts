// src/utils/page-comments.ts
// The Social Media assistant's Comments tab — the one server path behind the tab's buttons, the
// chat's comment card and the 6-hourly fetch. netlify/functions/page-comments.ts (the tenant API) and
// ingest-linkedin-insights.ts (the scheduled fetch) only call in here.
//
// What it does:
//  1. Fetch the comments on posts this workspace published to a LinkedIn Company Page (Community app
//     connections only — a personal-profile connection has no comment scopes) and keep each one as a
//     page_comments row, filed under the assistant that published the post.
//  2. On request, the assistant drafts a reply in the brand's voice. Nothing is posted by drafting.
//  3. "Post reply" posts the reply AS the Page — only ever from a person's click (the tab's button or
//     the chat card's), never from a schedule or a model turn.
//  4. A reply the Page made on LinkedIn itself is noticed on the next fetch and files the comment as
//     replied, so nobody answers twice. LinkedIn lists only top-level comments on a post, so the
//     replies under each comment are fetched separately (fetchCommentReplies) to see the Page's.
//
// Drafting is help with a reply, not a piece of work: metered like the other editing helpers (fair
// use, no task) — the same rule suggestTopicWording follows (src/utils/discussions.ts).

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, pageComments, scheduledPosts, systemConnections } from '../../db/schema';
import {
    fetchCommentReplies, fetchPostComments, linkedInCommentUrl, replyToComment, type LinkedInComment, type ReadFailure,
} from './linkedin-page-api';
import { notArchivedAssistant } from './archived-assistant-drafts';
import { isLinkedInPageUrn } from './linkedin-page';
import { resolveSocialCredentials } from './social-publish';
import { loadSenderIdentity } from './sender-identity';
import { loadBusinessKnowledgeBlock } from './business-knowledge';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { loadRoleModel, roleKeyOfAssistant, withRoleModel } from './assistant-model';
import { businessBlock } from '../lib/discussion-triage';
import { meterInteraction } from './task-credit';
import { chargeHelper } from './basic-work';
import { isGlobalAiDisabled } from './platform-config';
import { adaptForModel, replyText } from '../config/model-options';
import { parseModelJson } from './model-json';
import { logMessageUsage } from './ai-usage';

type Db = ReturnType<typeof getDb>;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRAFT_MODEL = 'claude-haiku-5-5';

export const COMMENT_STATUSES = ['new', 'replied', 'dismissed'] as const;
export type CommentStatus = typeof COMMENT_STATUSES[number];

/** Comments are fetched for posts published in the last this-many days. */
export const COMMENT_WINDOW_DAYS = 30;
/** A LinkedIn comment can be at most 1,250 characters. */
export const MAX_REPLY_CHARS = 1250;
/** Reply lookups per post per fetch (one call each) — the newest comments first, as LinkedIn lists them. */
const REPLY_LOOKUPS_PER_POST = 20;
/** Posts read per fetch, across every workspace. Hitting it is logged — it must never cut posts off silently. */
const MAX_PAGE_POSTS = 5000;
/** "Check for new comments": stop starting new posts after this long (the rest come with the 6-hourly fetch). */
export const TAB_SYNC_BUDGET_MS = 6_500;
/** The scheduled fetch's comments half: stop starting new posts after this long into the tick. */
export const INGEST_COMMENTS_BUDGET_MS = 20_000;
/** "Check for new comments" on the tab — at most once a minute per assistant. */
const SYNC_MIN_GAP_MS = 60_000;
const lastSync = new Map<number, number>();

/** A missing table (db/z-page-comments.sql not applied yet). */
/** A missing table (42P01) or column (42703) — a manual SQL file (db/z-page-comments.sql,
 *  db/z-scheduled-posts-author.sql) hasn't been applied on this database yet. */
export function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    const code = e?.code ?? e?.cause?.code;
    return code === '42P01' || code === '42703';
}

function toIso(v: Date | string | null | undefined): string | null {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Fetch from LinkedIn ────────────────────────────────────────────────────────────────────────

export interface PagePost {
    id: number;
    organisationId: number;
    assistantId: number | null;
    platformPostId: string;
}

export interface SyncResult {
    posts: number; fetched: number; added: number; repliedOnLinkedIn: number; failedPosts: number; skippedForTime: number;
    /** What LinkedIn said for each refused post (first MAX_REPORTED_FAILURES) — the only place the
     *  reason survives, since Netlify's function log drops the warnings. */
    failures?: { postId: number; postUrn: string; status: number; message: string }[];
}
export const MAX_REPORTED_FAILURES = 10;

/**
 * Decide what one post's comment list means for our rows. Pure, so tests can feed it LinkedIn's
 * documented shapes: the Page's own top-level comments are not ones to answer; the Page's replies
 * (parentComment set, actor = the Page) mark their parent as answered on LinkedIn.
 */
export function classifyComments(orgUrn: string, list: LinkedInComment[]): { toKeep: LinkedInComment[]; answeredParents: Map<string, LinkedInComment> } {
    const toKeep: LinkedInComment[] = [];
    const answeredParents = new Map<string, LinkedInComment>();
    for (const c of list) {
        const byPage = c.actorUrn === orgUrn;
        if (byPage) {
            if (c.parentCommentUrn && !answeredParents.has(c.parentCommentUrn)) answeredParents.set(c.parentCommentUrn, c);
            continue;
        }
        // Replies between other people are left out: the tab answers comments ON the post.
        if (c.parentCommentUrn) continue;
        toKeep.push(c);
    }
    return { toKeep, answeredParents };
}

/** Comment URNs (of these) already settled on our side: replied with a confirmed URN, or dismissed. Pure. */
export function settledUrns(rows: { commentUrn: string; status: string; replyCommentUrn: string | null }[]): Set<string> {
    return new Set(rows.filter((x) => x.status === 'dismissed' || (x.status === 'replied' && !!x.replyCommentUrn)).map((x) => x.commentUrn));
}

/**
 * Fetch and store the comments on one Page connection's posts. Throws only on a database error
 * (the caller decides whether a missing table is fatal); LinkedIn refusals count as failedPosts.
 * `deadline` (epoch ms): no new post is started after it — the rest wait for the next fetch, so the
 * caller's function never runs out of time (Netlify's default is 10 s on demand).
 */
export async function syncCommentsForConnection(
    db: Db, opts: { connectionId: number; orgUrn: string; token: string; posts: PagePost[]; deadline?: number },
): Promise<SyncResult> {
    const r: SyncResult = { posts: opts.posts.length, fetched: 0, added: 0, repliedOnLinkedIn: 0, failedPosts: 0, skippedForTime: 0 };
    for (const post of opts.posts) {
        if (opts.deadline && Date.now() > opts.deadline) { r.skippedForTime++; continue; }
        let failure: ReadFailure | null = null;
        const topLevel = await fetchPostComments(opts.token, post.platformPostId, opts.deadline, (f) => { failure = f; });
        // A read that came back empty-handed AFTER the deadline was most likely cut off by it, not refused:
        // count it as left for later, so a slow LinkedIn never reads as "reconnect your Company Page".
        if (!topLevel) {
            if (opts.deadline && Date.now() > opts.deadline) { r.skippedForTime++; continue; }
            r.failedPosts++;
            const f = failure as ReadFailure | null;
            if (f && (r.failures ??= []).length < MAX_REPORTED_FAILURES) r.failures.push({ postId: post.id, postUrn: post.platformPostId, status: f.status, message: f.message });
            continue;
        }
        r.fetched += topLevel.length;
        // The Page's own replies sit UNDER each comment, not in the post's list. Ask for them only on
        // comments still waiting on our side (new, not stored yet, or a reply LinkedIn never confirmed)
        // that have replies (or don't say) — at most REPLY_LOOKUPS_PER_POST a post per fetch. A settled
        // comment needs no lookup, so replying from the app makes later fetches cheaper, not dearer.
        const urns = topLevel.map((c) => c.commentUrn);
        const settled = urns.length ? settledUrns(await db.select({ commentUrn: pageComments.commentUrn, status: pageComments.status, replyCommentUrn: pageComments.replyCommentUrn })
            .from(pageComments).where(and(eq(pageComments.connectionId, opts.connectionId), inArray(pageComments.commentUrn, urns)))) : new Set<string>();
        const replies: LinkedInComment[] = [];
        const withReplies = topLevel.filter((c) => c.actorUrn !== opts.orgUrn && !c.parentCommentUrn && c.replyCount !== 0 && !settled.has(c.commentUrn));
        for (const c of withReplies.slice(0, REPLY_LOOKUPS_PER_POST)) {
            if (opts.deadline && Date.now() > opts.deadline) break;
            const got = await fetchCommentReplies(opts.token, c.commentUrn, opts.deadline);
            if (got) replies.push(...got);
        }
        const { toKeep, answeredParents } = classifyComments(opts.orgUrn, [...topLevel, ...replies]);
        if (toKeep.length) {
            const inserted = await db.insert(pageComments).values(toKeep.map((c) => ({
                organisationId: post.organisationId,
                aiAssistantId: post.assistantId,
                connectionId: opts.connectionId,
                scheduledPostId: post.id,
                platform: 'linkedin',
                commentUrn: c.commentUrn,
                objectUrn: c.objectUrn ?? post.platformPostId,
                authorUrn: c.actorUrn,
                authorName: c.actorName,
                body: c.text,
                commentedAt: c.createdAt,
            }))).onConflictDoNothing({ target: [pageComments.connectionId, pageComments.commentUrn] }).returning({ id: pageComments.id });
            r.added += inserted.length;
        }
        for (const [parent, reply] of answeredParents) {
            // Still waiting → the Page answered on LinkedIn itself.
            const done = await db.update(pageComments)
                .set({ status: 'replied', repliedVia: 'linkedin', replyText: reply.text, replyCommentUrn: reply.commentUrn, decidedAt: sql`now()`, updatedAt: sql`now()` })
                .where(and(eq(pageComments.connectionId, opts.connectionId), eq(pageComments.commentUrn, parent), eq(pageComments.status, 'new')))
                .returning({ id: pageComments.id });
            r.repliedOnLinkedIn += done.length;
            // Sent from here but never confirmed → it did go live: confirm it (the warning goes away).
            await db.update(pageComments)
                .set({ replyCommentUrn: reply.commentUrn, updatedAt: sql`now()` })
                .where(and(eq(pageComments.connectionId, opts.connectionId), eq(pageComments.commentUrn, parent), eq(pageComments.status, 'replied'), eq(pageComments.repliedVia, 'app'), isNull(pageComments.replyCommentUrn)));
        }
    }
    return r;
}

/** Published LinkedIn posts (in the window) on Company Page connections, grouped by connection. Pure-ish read. */
export async function loadPagePosts(db: Db, scope: { organisationId?: number; assistantId?: number } = {}) {
    const since = new Date(Date.now() - COMMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db.select({
        id: scheduledPosts.id,
        organisationId: scheduledPosts.organisationId,
        assistantId: scheduledPosts.assistantId,
        platformPostId: scheduledPosts.platformPostId,
        publishedAt: scheduledPosts.publishedAt,
        connectionId: systemConnections.id,
        externalUserId: systemConnections.externalUserId,
    })
        .from(scheduledPosts)
        // The Page connection that WROTE the post — matched on the author the publisher recorded
        // (platform_author_urn), never on connection_id alone: reconnecting updates a connection row
        // in place, so a connection that posted as a personal profile can point at a Page later, and
        // connection_id would then claim the profile's posts for the Page — their comments on the
        // Page's tab, replies sent AS the Page (seen on staging 2026-11-19, post 202). A post with no
        // recorded author (published before db/z-scheduled-posts-author.sql) is left out: Page
        // posting had only run on staging by then.
        .innerJoin(systemConnections, and(
            eq(systemConnections.organisationId, scheduledPosts.organisationId),
            eq(systemConnections.serviceName, 'linkedin'),
            eq(systemConnections.externalUserId, scheduledPosts.platformAuthorUrn),
        ))
        .where(and(
            eq(scheduledPosts.platform, 'linkedin'),
            eq(scheduledPosts.status, 'published'),
            isNotNull(scheduledPosts.platformPostId),
            gte(scheduledPosts.publishedAt, since),
            like(scheduledPosts.platformAuthorUrn, 'urn:li:organization:%'),
            eq(systemConnections.isActive, true),
            // An archived assistant's posts gather no new comments to answer (archived-assistant-drafts.ts).
            notArchivedAssistant(scheduledPosts.assistantId),
            ...(scope.organisationId != null ? [eq(scheduledPosts.organisationId, scope.organisationId)] : []),
            ...(scope.assistantId != null ? [eq(scheduledPosts.assistantId, scope.assistantId)] : []),
        ))
        .orderBy(desc(scheduledPosts.publishedAt))
        .limit(MAX_PAGE_POSTS);
    if (rows.length === MAX_PAGE_POSTS) {
        console.warn(`[page-comments] loadPagePosts hit its cap of ${MAX_PAGE_POSTS} posts — the oldest LinkedIn Page posts in the ${COMMENT_WINDOW_DAYS}-day window were skipped this tick. Page through them before this grows further.`);
    }
    const byConnection = new Map<number, { orgUrn: string; organisationId: number; posts: (PagePost & { publishedAt: Date | null })[] }>();
    const seen = new Set<number>();
    for (const row of rows) {
        if (!row.connectionId || !row.platformPostId || !isLinkedInPageUrn(row.externalUserId) || row.organisationId == null) continue;
        // Two live connections for the same Page in one workspace would join a post twice. Read it once.
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const g = byConnection.get(row.connectionId) ?? { orgUrn: row.externalUserId!, organisationId: row.organisationId, posts: [] };
        g.posts.push({ id: row.id, organisationId: row.organisationId, assistantId: row.assistantId, platformPostId: row.platformPostId, publishedAt: row.publishedAt });
        byConnection.set(row.connectionId, g);
    }
    return byConnection;
}

/** The token for one Page connection, or null. Never throws. */
export async function pageToken(db: Db, organisationId: number, connectionId: number): Promise<string | null> {
    try {
        const creds = await resolveSocialCredentials(db, { organisationId, platform: 'linkedin', connectionId });
        return creds.token || null;
    } catch (err) {
        console.warn(`[page-comments] conn ${connectionId}: no token —`, err instanceof Error ? err.message : err);
        return null;
    }
}

/** "Check for new comments" on the tab, for one assistant's Page posts. */
export async function syncAssistantComments(db: Db, organisationId: number, assistantId: number): Promise<{ ok: true; result: SyncResult } | { ok: false; status: number; error: string; code?: string }> {
    const last = lastSync.get(assistantId) ?? 0;
    if (Date.now() - last < SYNC_MIN_GAP_MS) return { ok: false, status: 429, error: 'Checked a moment ago — try again in a minute.', code: 'too_soon' };
    lastSync.set(assistantId, Date.now());
    const groups = await loadPagePosts(db, { organisationId, assistantId });
    if (!groups.size) return { ok: false, status: 422, error: 'This assistant hasn’t published to a LinkedIn Company Page in the last 30 days, so there are no comments to check.', code: 'no_page_posts' };
    const total: SyncResult = { posts: 0, fetched: 0, added: 0, repliedOnLinkedIn: 0, failedPosts: 0, skippedForTime: 0 };
    // Inside an on-demand function's 10 s, with room to read the list back and answer.
    const deadline = Date.now() + TAB_SYNC_BUDGET_MS;
    for (const [connectionId, g] of groups) {
        const token = await pageToken(db, organisationId, connectionId);
        if (!token) { total.posts += g.posts.length; total.failedPosts += g.posts.length; continue; }
        const r = await syncCommentsForConnection(db, { connectionId, orgUrn: g.orgUrn, token, posts: g.posts, deadline });
        for (const k of ['posts', 'fetched', 'added', 'repliedOnLinkedIn', 'failedPosts', 'skippedForTime'] as const) total[k] += r[k];
        for (const f of r.failures ?? []) if ((total.failures ??= []).length < MAX_REPORTED_FAILURES) total.failures.push(f);
    }
    if (total.failedPosts && total.failedPosts === total.posts - total.skippedForTime) {
        return { ok: false, status: 502, error: 'LinkedIn wouldn’t share the comments just now. If this keeps happening, reconnect your Company Page in Connections.', code: 'linkedin_refused' };
    }
    return { ok: true, result: total };
}

// ── Read ───────────────────────────────────────────────────────────────────────────────────────

export interface CommentView {
    id: number;
    authorName: string;
    body: string;
    commentedAt: string | null;
    postId: number | null;
    postExcerpt: string | null;
    linkedInUrl: string | null;
    draftReply: string | null;
    status: CommentStatus;
    repliedVia: 'app' | 'linkedin' | null;
    replyText: string | null;
    /** Posted from here but LinkedIn never confirmed it — it may not be live. */
    replyUnconfirmed: boolean;
    decidedAt: string | null;
}

type CommentRow = typeof pageComments.$inferSelect;

export function commentView(r: CommentRow, postCaption: string | null = null): CommentView {
    return {
        id: r.id,
        authorName: r.authorName?.trim() || (r.authorUrn?.startsWith('urn:li:organization:') ? 'A LinkedIn Page' : 'A LinkedIn member'),
        body: r.body,
        commentedAt: toIso(r.commentedAt) ?? toIso(r.createdAt),
        postId: r.scheduledPostId,
        postExcerpt: postCaption ? postCaption.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
        linkedInUrl: linkedInCommentUrl(r.objectUrn, r.commentUrn),
        draftReply: r.draftReply,
        status: (COMMENT_STATUSES as readonly string[]).includes(r.status) ? r.status as CommentStatus : 'new',
        repliedVia: r.repliedVia === 'app' || r.repliedVia === 'linkedin' ? r.repliedVia : null,
        replyText: r.replyText,
        replyUnconfirmed: r.status === 'replied' && r.repliedVia === 'app' && !r.replyCommentUrn,
        decidedAt: toIso(r.decidedAt),
    };
}

export const LIST_PAGE_SIZE = 200;

/** Does this workspace have a LinkedIn Company Page connection? (The tab's empty state differs.) */
export async function hasPageConnection(db: Db, organisationId: number): Promise<boolean> {
    const [row] = await db.select({ id: systemConnections.id }).from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, 'linkedin'),
            eq(systemConnections.isActive, true),
            like(systemConnections.externalUserId, 'urn:li:organization:%'),
        )).limit(1);
    return !!row;
}

export async function listComments(db: Db, organisationId: number, assistantId: number) {
    const scope = and(eq(pageComments.organisationId, organisationId), eq(pageComments.aiAssistantId, assistantId));
    const [rows, counts, connected] = await Promise.all([
        db.select({ c: pageComments, caption: scheduledPosts.caption })
            .from(pageComments)
            .leftJoin(scheduledPosts, eq(scheduledPosts.id, pageComments.scheduledPostId))
            .where(scope)
            .orderBy(desc(sql`coalesce(${pageComments.commentedAt}, ${pageComments.createdAt})`))
            .limit(LIST_PAGE_SIZE),
        db.select({ status: pageComments.status, n: sql<number>`count(*)::int` }).from(pageComments).where(scope).groupBy(pageComments.status),
        hasPageConnection(db, organisationId),
    ]);
    const c = { new: 0, replied: 0, dismissed: 0 };
    for (const r of counts) if (r.status in c) c[r.status as keyof typeof c] = Number(r.n);
    return { comments: rows.map((r) => commentView(r.c, r.caption)), counts: c, hasPageConnection: connected };
}

export async function loadComment(db: Db, organisationId: number, assistantId: number, id: number) {
    const [row] = await db.select({ c: pageComments, caption: scheduledPosts.caption })
        .from(pageComments)
        .leftJoin(scheduledPosts, eq(scheduledPosts.id, pageComments.scheduledPostId))
        .where(and(eq(pageComments.id, id), eq(pageComments.organisationId, organisationId), eq(pageComments.aiAssistantId, assistantId)))
        .limit(1);
    return row ?? null;
}

// ── Write ──────────────────────────────────────────────────────────────────────────────────────

/** Dismiss / put back to new. Never "replied" — only postReply (or LinkedIn itself) files that. Putting a
 *  comment back to New clears an unconfirmed reply so it can be posted again. */
export async function setCommentStatus(
    db: Db, organisationId: number, assistantId: number, id: number, status: 'new' | 'dismissed', userId: number | null,
): Promise<CommentView | null> {
    const [row] = await db.update(pageComments)
        .set({
            status, updatedAt: sql`now()`, decidedBy: status === 'new' ? null : userId, decidedAt: status === 'new' ? null : sql`now()`,
            ...(status === 'new' ? { repliedVia: null, replyText: null } : {}),
        })
        .where(and(
            eq(pageComments.id, id), eq(pageComments.organisationId, organisationId), eq(pageComments.aiAssistantId, assistantId),
            // A reply LinkedIn never confirmed (no reply URN, posted from here) may go back to New once
            // the person has checked it isn't on LinkedIn; a confirmed reply never can.
            status === 'new'
                ? sql`(${pageComments.status} IN ('new','dismissed') OR (${pageComments.status} = 'replied' AND ${pageComments.repliedVia} = 'app' AND ${pageComments.replyCommentUrn} IS NULL))`
                // Dismiss only what is waiting: an unconfirmed reply goes back to New first, never straight to Dismissed.
                : inArray(pageComments.status, ['new', 'dismissed']),
        ))
        .returning();
    return row ? commentView(row) : null;
}

/** Tidy a reply as typed or drafted: plain text, at most LinkedIn's 1,250 characters. Pure. */
export function tidyReply(text: string): string {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_REPLY_CHARS);
}

export async function saveDraft(db: Db, organisationId: number, assistantId: number, id: number, text: string): Promise<CommentView | null> {
    const draft = tidyReply(text);
    if (!draft) return null;
    const [row] = await db.update(pageComments)
        .set({ draftReply: draft, updatedAt: sql`now()` })
        .where(and(eq(pageComments.id, id), eq(pageComments.organisationId, organisationId), eq(pageComments.aiAssistantId, assistantId)))
        .returning();
    return row ? commentView(row) : null;
}

/** The brand's tone as the assistant was set up with it (onboarding answers), for the drafting prompt. */
async function loadVoice(db: Db, assistantId: number): Promise<string | null> {
    const [a] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants).where(eq(aiAssistants.id, assistantId)).limit(1);
    const ctx = (a?.ctx ?? {}) as Record<string, unknown>;
    const tone = typeof ctx.tone_of_voice === 'string' ? ctx.tone_of_voice.trim() : '';
    const guidelines = typeof ctx.brand_guidelines === 'string' ? ctx.brand_guidelines.trim() : '';
    const lines = [tone ? `Tone of voice: ${tone}` : '', guidelines ? `Brand guidelines: ${guidelines}` : ''].filter(Boolean);
    return lines.length ? lines.join('\n') : null;
}

export const REPLY_RULES = `How to write the reply:
- You are replying AS the business's LinkedIn Company Page, under its own post, to the person who commented. Write in the first person plural ("we"), in the brand's voice.
- Answer what they actually said. Thank them only when a thank-you fits — never open every reply the same way.
- One to three short sentences. Plain text: no markdown, no hashtags, no emoji unless the comment used them.
- Use their first name at most once, and only if it is given below.
- Never invent facts, prices, dates, offers or promises that are not in the business details. If they ask something the details don't answer, invite them to message the Page or get in touch rather than guessing.
- If the comment is a complaint, acknowledge it calmly and offer to take it to a private conversation. Never argue.
- If the comment is spam, abusive or a sales pitch, reply with an empty string — the person will dismiss it.`;

/** "Draft a reply" / "Redraft" — the assistant writes the reply. Stored as the draft; nothing is posted. */
export async function draftReply(
    db: Db, organisationId: number, assistantId: number, id: number, instruction: string | null,
): Promise<{ ok: true; comment: CommentView } | { ok: false; status: number; error: string; code?: string }> {
    const row = await loadComment(db, organisationId, assistantId, id);
    if (!row) return { ok: false, status: 404, error: 'That comment isn’t on this assistant’s Comments tab.' };
    if (row.c.status === 'replied') return { ok: false, status: 409, error: 'This comment already has a reply.' };
    if (await isGlobalAiDisabled()) return { ok: false, status: 503, error: 'AI services are temporarily unavailable. Please try again later.' };
    const credit = await meterInteraction(db, organisationId, 'helpers');
    if (!credit.allowed) {
        if (credit.failed) return { ok: false, status: 503, error: credit.limitMessage ?? 'Please try again.' };
        if (credit.fairUse) return { ok: false, status: 429, error: credit.limitMessage ?? 'Please try again later.', code: 'FAIR_USE_LIMIT' };
        return { ok: false, status: 403, error: credit.limitMessage ?? 'You need a plan for this.', code: 'UPGRADE_REQUIRED' };
    }
    const [sender, knowledgeBlock, rulesBlock, voice, roleKey] = await Promise.all([
        loadSenderIdentity(db, organisationId, assistantId),
        loadBusinessKnowledgeBlock(db, organisationId),
        loadAssistantRulesBlock(db, { assistantId, organisationId }),
        loadVoice(db, assistantId),
        roleKeyOfAssistant(db, assistantId),
    ]);
    const modelChoice = await loadRoleModel(db, roleKey ?? 'social_media_manager');
    const firstName = row.c.authorName?.trim().split(/\s+/)[0] || null;
    const payload = {
        post: (row.caption || '').slice(0, 3000),
        comment: row.c.body.slice(0, 2000),
        commenter_first_name: firstName,
        current_draft: row.c.draftReply || null,
    };
    let reply: string | null = null;
    try {
        const { resp, model: used } = await withRoleModel(modelChoice, DRAFT_MODEL, async (model, thinking) => ({ model, resp: await anthropic.messages.create(adaptForModel({
            model,
            max_tokens: 600,
            system: `You draft the reply a business's LinkedIn Company Page posts under its own post, to a comment someone left.

${businessBlock({ ...sender, knowledgeBlock, rulesBlock })}
${voice ? `\n${voice}\n` : ''}
${REPLY_RULES}

Return STRICT JSON only (no markdown): { "reply": "<the reply, or an empty string>" }`,
            messages: [{
                role: 'user',
                content: `${JSON.stringify(payload)}\n\n${instruction ? `What the business owner wants changed: ${instruction.trim().slice(0, 600)}` : row.c.draftReply ? 'Write a better reply.' : 'Write the reply.'}`,
            }],
        }, model, thinking) as Anthropic.MessageCreateParamsNonStreaming, { timeout: 20_000, maxRetries: 0 }) }), { requestPath: true, label: 'page-comment-reply' });
        await logMessageUsage(resp, used, { workspaceId: organisationId, assistantId, sessionId: 'page-comment-reply' });
        const parsed = parseModelJson(replyText(resp.content)) as { reply?: unknown } | null;
        reply = parsed && typeof parsed.reply === 'string' ? tidyReply(parsed.reply) : null;
    } catch (err) {
        console.error('[page-comments] draft failed', err instanceof Error ? err.message : err);
        return { ok: false, status: 502, error: 'The reply couldn’t be drafted just now — please try again.' };
    }
    if (reply === null) return { ok: false, status: 502, error: 'The reply couldn’t be drafted just now — please try again.' };
    await chargeHelper(db, organisationId, assistantId, `page-comment-${id}`);
    if (!reply) return { ok: false, status: 422, error: 'This looks like spam or a sales pitch, so no reply was drafted. You can dismiss it, or write a reply yourself.', code: 'no_reply' };
    const [updated] = await db.update(pageComments)
        .set({ draftReply: reply, updatedAt: sql`now()` })
        .where(eq(pageComments.id, row.c.id))
        .returning();
    return { ok: true, comment: commentView(updated, row.caption) };
}

/**
 * "Post reply" — the ONLY path that posts to LinkedIn. Posts `text` (or the saved draft) as the Page,
 * then files the comment as replied. Called from a person's click only.
 */
export async function postReply(
    db: Db, organisationId: number, assistantId: number, id: number, text: string | null, userId: number | null,
): Promise<{ ok: true; comment: CommentView; warning?: string } | { ok: false; status: number; error: string; code?: string }> {
    const row = await loadComment(db, organisationId, assistantId, id);
    if (!row) return { ok: false, status: 404, error: 'That comment isn’t on this assistant’s Comments tab.' };
    if (row.c.status === 'replied') return { ok: false, status: 409, error: 'This comment already has a reply.' };
    const reply = tidyReply(text ?? row.c.draftReply ?? '');
    if (!reply) return { ok: false, status: 400, error: 'Write a reply first.' };

    const [conn] = await db.select({ externalUserId: systemConnections.externalUserId, isActive: systemConnections.isActive })
        .from(systemConnections).where(eq(systemConnections.id, row.c.connectionId)).limit(1);
    if (!conn?.isActive || !isLinkedInPageUrn(conn.externalUserId)) {
        return { ok: false, status: 409, error: 'Your LinkedIn Company Page isn’t connected any more. Reconnect it in Connections, then post the reply.', code: 'not_connected' };
    }
    const token = await pageToken(db, organisationId, row.c.connectionId);
    if (!token) return { ok: false, status: 409, error: 'Your LinkedIn Company Page connection has no access key. Reconnect it in Connections.', code: 'not_connected' };

    // Claim the row first so a double click (or the tab and the chat card together) can't post twice.
    const [claimed] = await db.update(pageComments)
        .set({ status: 'replied', repliedVia: 'app', replyText: reply, draftReply: reply, decidedBy: userId, decidedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(pageComments.id, row.c.id), inArray(pageComments.status, ['new', 'dismissed'])))
        .returning({ id: pageComments.id });
    if (!claimed) return { ok: false, status: 409, error: 'This comment already has a reply.' };

    const result = await replyToComment(token, {
        orgUrn: conn.externalUserId!, objectUrn: row.c.objectUrn ?? '', commentUrn: row.c.commentUrn, text: reply,
    });
    if (!result.ok && result.unconfirmed) {
        // LinkedIn didn't answer, or answered 5xx: the reply MAY be live. Keep the comment under Replied
        // so nobody presses Post reply again and the Page answers twice in public; say to check.
        const [kept] = await db.select().from(pageComments).where(eq(pageComments.id, row.c.id)).limit(1);
        return {
            ok: true,
            comment: commentView(kept, row.caption),
            warning: 'LinkedIn didn’t confirm the reply in time, so it may or may not have been posted. Open the post on LinkedIn to check — it’s filed under Replied here so it isn’t posted twice. If it isn’t there, put it back in New and post it again.',
        };
    }
    if (!result.ok) {
        // A definite refusal (4xx) posted nothing: give the row back exactly as it was, keeping what
        // they typed as the draft.
        await db.update(pageComments)
            .set({ status: row.c.status, repliedVia: null, replyText: null, decidedBy: row.c.decidedBy, decidedAt: row.c.decidedAt, updatedAt: sql`now()` })
            .where(eq(pageComments.id, row.c.id));
        return { ok: false, status: result.status === 401 || result.status === 403 ? 409 : 502, error: result.error };
    }
    const [updated] = await db.update(pageComments)
        // A confirmed reply always has a non-null URN — 'confirmed' when LinkedIn sent no id — because a null
        // one marks a reply LinkedIn never confirmed (see the unconfirmed branch above and setCommentStatus).
        .set({ replyCommentUrn: (result.ok ? result.commentUrn : null) ?? 'confirmed', updatedAt: sql`now()` })
        .where(eq(pageComments.id, row.c.id))
        .returning();
    return { ok: true, comment: commentView(updated, row.caption) };
}

// ── Chat ───────────────────────────────────────────────────────────────────────────────────────

/** How many new comments the chat sees by name. The block says when there are more. */
export const CHAT_SNAPSHOT_COMMENTS = 10;

/**
 * What the Social Media assistant's chat knows about its Comments tab, per turn, and the card it
 * may propose. Null when the table is missing or the read failed — the prompt then says nothing
 * rather than something false.
 */
export async function buildCommentsChatBlock(db: Db, organisationId: number, assistantId: number): Promise<string | null> {
    try {
        const { comments, counts, hasPageConnection: connected } = await listComments(db, organisationId, assistantId);
        const fresh = comments.filter((c) => c.status === 'new').slice(0, CHAT_SNAPSHOT_COMMENTS);
        const lines = fresh.map((c) => `#${c.id} · ${c.authorName} · "${c.body.replace(/\s+/g, ' ').slice(0, 140)}"${c.postExcerpt ? ` · on: "${c.postExcerpt.slice(0, 60)}"` : ''}${c.draftReply ? ' · reply drafted' : ''}`);
        return `YOUR COMMENTS TAB — comments people left on the posts you published to the business's LinkedIn Company Page, fetched every few hours (the tab's "Check for new comments" button fetches now). ${connected ? 'A Company Page is connected.' : 'No LinkedIn Company Page is connected, so no comments are fetched: to get them, the user reconnects LinkedIn in Connections and chooses "A Company Page". Comments on a personal LinkedIn profile, Facebook, Instagram or X are not fetched.'}
Comments: ${counts.new} new, ${counts.replied} replied, ${counts.dismissed} dismissed.${fresh.length ? `\nNew comments${counts.new > fresh.length ? ` (the ${fresh.length} most recent of ${counts.new})` : ''}:\n${lines.join('\n')}` : ''}

To act on a comment, emit a comment_action_proposal uiElement — the user confirms on the card, and only their click changes anything:
{ "type": "comment_action_proposal", "action": "draft" | "post_reply" | "dismiss",
  "commentId": <the number after # above>,
  "instruction": "<what to change, in the user's words>" | null }   // draft only
"draft" writes (or rewrites) the reply on the card, in the brand's voice, without posting it. "post_reply" posts the reply shown on the card AS the Company Page, under the post, where everyone can see it — offer it only after a reply is drafted, and say plainly it will be public. Never write the reply in your own message: the card shows it and the user can edit it there. Never say a reply HAS been posted, drafted or dismissed — the card does nothing until the user presses its button; say "Press Post reply on the card to publish it as your Page". ONE card per message.
You never post, like or reply anywhere on your own, and you never send private messages on LinkedIn — LinkedIn does not allow it here.`;
    } catch (err) {
        if (!isMissingTable(err)) console.error('[page-comments] chat block failed', err instanceof Error ? err.message : err);
        return null;
    }
}
