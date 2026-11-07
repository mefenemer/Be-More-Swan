// src/utils/review-links.ts
// Free guest review links (docs/review-link-plan.md). A subscriber shares one piece of work through a
// private link, and a guest with no account approves it or asks for changes. A response only records
// a sign-off: nothing a guest does publishes, spends a task, runs AI or changes the post.
//
// The one module behind review-link.ts (signed in) and review-link-public.ts (no login).
//
// Security rules, each pinned in tests/review-links.test.ts:
//   • The token is 32 random bytes and only its sha256 is stored, so a link can be revoked.
//   • The organisation and item come only from the link row, never from the request.
//   • reviewProjection() builds the guest's view field by field. Anything not named there never leaves.
//   • Opening changes nothing. Email scanners open links AND run page script, so a view counts only
//     after a person touches the page, and a response only comes from their click.

import crypto from 'crypto';
import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, contentAssets, organisations, plans, reviewLinkResponses, reviewLinks,
    scheduledPostAssets, scheduledPosts, userOrganisations,
} from '../../db/schema';
import { createNotification } from './notify';
import { resolveAssetDisplayUrl } from './social-publish';

type Db = ReturnType<typeof getDb>;

export const REVIEW_LINK_DAYS = 30;
/** So links can't become free hosting. */
export const MAX_LIVE_LINKS_PER_ORG = 200;
export const MAX_RESPONSES_PER_LINK = 25;
export const MAX_EMAILS_PER_ORG_PER_DAY = 25;
export const MAX_NAME_CHARS = 80;
export const MAX_BODY_CHARS = 2000;
export const MAX_LABEL_CHARS = 80;

const TOKEN_RE = /^[a-f0-9]{64}$/;
/** Plan statuses that keep a workspace's links working. A trial is an active plan row. */
const LIVE_PLAN_STATUSES = ['active', 'past_due', 'cancelling'];
/** A post no longer going out, so there is nothing to review. */
const DEAD_POST_STATUSES = new Set(['rejected', 'cancelled']);

export type ReviewDecision = 'approved' | 'changes' | 'comment';

export function hashReviewToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Pure: well-formed before any database read. */
export function isReviewToken(token: unknown): token is string {
    return typeof token === 'string' && TOKEN_RE.test(token);
}

/** Pure: strip control characters and cap the length. It is displayed with textContent regardless. */
export function cleanGuestText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Pure: what a guest's response needs, or the message to show them. */
export function validateResponse(input: { name?: unknown; decision?: unknown; body?: unknown }):
    { ok: true; name: string; decision: ReviewDecision; body: string | null } | { ok: false; error: string } {
    const name = cleanGuestText(input.name, MAX_NAME_CHARS);
    if (!name) return { ok: false, error: 'Please add your name.' };
    const decision = input.decision;
    if (decision !== 'approved' && decision !== 'changes' && decision !== 'comment') {
        return { ok: false, error: 'Please choose a response.' };
    }
    const body = cleanGuestText(input.body, MAX_BODY_CHARS);
    if ((decision === 'changes' || decision === 'comment') && !body) {
        return { ok: false, error: 'Please say what you would like changed.' };
    }
    return { ok: true, name, decision, body: body || null };
}

interface PostRow {
    id: number;
    platform: string;
    caption: string | null;
    hashtags: string | null;
    linkUrl: string | null;
    publishDate: Date | string | null;
    imageOverlays: unknown;
}

export interface ReviewMedia { kind: 'image' | 'video'; url: string }

/** Pure: words the user put on the picture. Applied at approval, so a guest's picture lacks them yet. */
function overlayWords(overlays: unknown): string[] {
    if (!Array.isArray(overlays)) return [];
    return overlays
        .map((o) => (o && typeof o === 'object' ? (o as { text?: unknown }).text : null))
        .filter((t): t is string => typeof t === 'string' && !!t.trim())
        .map((t) => t.trim().slice(0, 300));
}

/**
 * Pure: the ONLY thing a guest ever sees of a post. Builds a new object field by field, so prompts,
 * quality warnings, rules, reject reasons, connections, provider ids and settings cannot reach them.
 */
export function reviewProjection(args: {
    workspaceName: string | null;
    posts: PostRow[];
    mediaByPost: Map<number, ReviewMedia[]>;
}) {
    return {
        kind: 'social_post' as const,
        workspaceName: args.workspaceName || 'A Be More Swan customer',
        versions: args.posts.map((p) => ({
            platform: p.platform,
            caption: p.caption || '',
            hashtags: p.hashtags || '',
            link: p.linkUrl || '',
            plannedFor: p.publishDate ? new Date(p.publishDate).toISOString() : null,
            pictureWords: overlayWords(p.imageOverlays),
            media: (args.mediaByPost.get(p.id) || []).map((m) => ({ kind: m.kind, url: m.url })),
        })),
    };
}

/** Pure: identifies what a guest was looking at, so a response can say "Changed since". */
export function contentHashOf(posts: PostRow[], assetIdsByPost: Map<number, number[]>): string {
    const shape = [...posts]
        .sort((a, b) => a.id - b.id)
        .map((p) => [p.id, p.caption || '', p.hashtags || '', p.linkUrl || '', assetIdsByPost.get(p.id) || [], overlayWords(p.imageOverlays)]);
    return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/** One card in the Review Queue is the whole cross-post group. */
async function loadPostGroup(db: Db, orgId: number, postId: number) {
    const [post] = await db
        .select({
            id: scheduledPosts.id,
            assistantId: scheduledPosts.assistantId,
            status: scheduledPosts.status,
            crosspostGroupId: scheduledPosts.crosspostGroupId,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return null;
    const rows = await db
        .select({
            id: scheduledPosts.id,
            status: scheduledPosts.status,
            platform: scheduledPosts.platform,
            caption: scheduledPosts.caption,
            hashtags: scheduledPosts.hashtags,
            linkUrl: scheduledPosts.linkUrl,
            publishDate: scheduledPosts.publishDate,
            imageOverlays: scheduledPosts.imageOverlays,
        })
        .from(scheduledPosts)
        .where(post.crosspostGroupId
            ? and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId))
            : and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.id, postId)))
        .orderBy(asc(scheduledPosts.id));
    return { assistantId: post.assistantId, rows: rows.filter((r) => !DEAD_POST_STATUSES.has(r.status)) };
}

async function loadMedia(db: Db, postIds: number[]) {
    const mediaByPost = new Map<number, ReviewMedia[]>();
    const assetIdsByPost = new Map<number, number[]>();
    if (!postIds.length) return { mediaByPost, assetIdsByPost };
    const rows = await db
        .select({
            postId: scheduledPostAssets.scheduledPostId,
            assetId: contentAssets.id,
            assetType: contentAssets.assetType,
            storageUrl: contentAssets.storageUrl,
            storageKey: contentAssets.storageKey,
            externalUrl: contentAssets.externalUrl,
        })
        .from(scheduledPostAssets)
        .innerJoin(contentAssets, eq(scheduledPostAssets.contentAssetId, contentAssets.id))
        .where(inArray(scheduledPostAssets.scheduledPostId, postIds))
        .orderBy(asc(scheduledPostAssets.position));
    for (const row of rows) {
        assetIdsByPost.set(row.postId, [...(assetIdsByPost.get(row.postId) || []), row.assetId]);
        if (row.assetType !== 'image' && row.assetType !== 'video') continue;
        const url = await resolveAssetDisplayUrl(row).catch(() => null);
        if (url) mediaByPost.set(row.postId, [...(mediaByPost.get(row.postId) || []), { kind: row.assetType, url }]);
    }
    return { mediaByPost, assetIdsByPost };
}

async function workspaceIsLive(db: Db, orgId: number): Promise<boolean> {
    const [row] = await db
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.organisationId, orgId), inArray(plans.status, LIVE_PLAN_STATUSES)))
        .limit(1);
    return !!row;
}

async function assistantIsLive(db: Db, orgId: number, assistantId: number | null): Promise<boolean> {
    if (assistantId == null) return true;
    const [row] = await db
        .select({ lifecycleStatus: aiAssistants.lifecycleStatus })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    return !!row && row.lifecycleStatus !== 'archived';
}

/**
 * The link behind a token, or null for every dead case: unknown, expired, revoked, the post gone, the
 * assistant archived, or the workspace lapsed. Callers show one message, so a guest can't tell which.
 */
export async function resolveReviewLink(db: Db, token: unknown) {
    if (!isReviewToken(token)) return null;
    const [link] = await db
        .select()
        .from(reviewLinks)
        .where(eq(reviewLinks.tokenHash, hashReviewToken(token)))
        .limit(1);
    if (!link || link.revokedAt || new Date(link.expiresAt).getTime() <= Date.now()) return null;
    if (link.itemKind !== 'social_post') return null;
    const group = await loadPostGroup(db, link.organisationId, link.itemId);
    if (!group || !group.rows.length) return null;
    if (!await workspaceIsLive(db, link.organisationId)) return null;
    if (!await assistantIsLive(db, link.organisationId, group.assistantId)) return null;
    const { mediaByPost, assetIdsByPost } = await loadMedia(db, group.rows.map((r) => r.id));
    return { link, group, mediaByPost, contentHash: contentHashOf(group.rows, assetIdsByPost) };
}

export type ResolvedReviewLink = NonNullable<Awaited<ReturnType<typeof resolveReviewLink>>>;

/** What the guest's page draws. */
export async function guestView(db: Db, resolved: ResolvedReviewLink) {
    const [org] = await db
        .select({ name: organisations.name })
        .from(organisations)
        .where(eq(organisations.id, resolved.link.organisationId))
        .limit(1);
    return reviewProjection({ workspaceName: org?.name ?? null, posts: resolved.group.rows, mediaByPost: resolved.mediaByPost });
}

/** A person touched the page. Never called on load, because scanners run page script too. */
export async function recordOpened(db: Db, linkId: number): Promise<void> {
    await db.update(reviewLinks)
        .set({
            viewCount: sql`${reviewLinks.viewCount} + 1`,
            firstViewedAt: sql`COALESCE(${reviewLinks.firstViewedAt}, now())`,
        })
        .where(eq(reviewLinks.id, linkId));
}

export async function recordTrialClick(db: Db, linkId: number): Promise<void> {
    await db.update(reviewLinks)
        .set({ trialClicks: sql`${reviewLinks.trialClicks} + 1` })
        .where(eq(reviewLinks.id, linkId));
}

/** Who to tell: whoever made the link, or the owner if they have since left. */
async function responseRecipient(db: Db, orgId: number, createdBy: number | null): Promise<number | null> {
    if (createdBy != null) {
        const [member] = await db
            .select({ userId: userOrganisations.userId })
            .from(userOrganisations)
            .where(and(eq(userOrganisations.organisationId, orgId), eq(userOrganisations.userId, createdBy)))
            .limit(1);
        if (member) return member.userId;
    }
    const [owner] = await db
        .select({ userId: userOrganisations.userId })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.organisationId, orgId), eq(userOrganisations.role, 'owner')))
        .limit(1);
    return owner?.userId ?? null;
}

/** Records a guest's click. This is all a response does: the post and its status are not touched. */
export async function recordResponse(
    db: Db,
    resolved: ResolvedReviewLink,
    input: { name: string; decision: ReviewDecision; body: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
    const { link, group, contentHash } = resolved;
    const [{ value }] = await db
        .select({ value: count() })
        .from(reviewLinkResponses)
        .where(eq(reviewLinkResponses.linkId, link.id));
    if (Number(value) >= MAX_RESPONSES_PER_LINK) {
        return { ok: false, error: 'This link has had all the responses it can take. Please contact the person who sent it.' };
    }
    await db.insert(reviewLinkResponses).values({
        linkId: link.id,
        organisationId: link.organisationId,
        guestName: input.name,
        decision: input.decision,
        body: input.body,
        contentHash,
    });
    const userId = await responseRecipient(db, link.organisationId, link.createdBy);
    if (userId != null) {
        const [assistant] = group.assistantId != null
            ? await db.select({ name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, group.assistantId)).limit(1)
            : [null];
        await createNotification(db, 'review_link_response', {
            userId,
            assistantId: group.assistantId ?? undefined,
            // Explicit so the stored column is right without db/notifications-categorization.sql
            // having been re-applied; the DB trigger only stamps when this is NULL.
            category: 'state_change',
            context: {
                assistant: { name: assistant?.name || 'Your assistant' },
                review: { guest: input.name, outcome: decisionWords(input.decision) },
            },
            metadata: { postId: link.itemId, assistantId: group.assistantId, reviewLinkId: link.id },
        }).catch((err: Error) => console.warn('[review-links] notification failed (non-fatal):', err.message));
    }
    return { ok: true };
}

/** Pure: the words on the notification and the card. The name is as typed, so it is unverified. */
export function decisionWords(decision: string): string {
    if (decision === 'approved') return 'approved it';
    if (decision === 'changes') return 'asked for changes';
    return 'left a comment';
}

/** Signed in. Makes a link for a post in this workspace. The token is only ever returned here. */
export async function createReviewLink(
    db: Db,
    args: { orgId: number; userId: number; postId: number; label?: unknown },
): Promise<{ ok: true; token: string; linkId: number; expiresAt: Date } | { ok: false; status: number; error: string }> {
    const group = await loadPostGroup(db, args.orgId, args.postId);
    if (!group) return { ok: false, status: 404, error: 'That post could not be found.' };
    if (!group.rows.length) return { ok: false, status: 409, error: 'This post is no longer going out, so there is nothing to share.' };
    if (!await assistantIsLive(db, args.orgId, group.assistantId)) {
        return { ok: false, status: 409, error: 'This assistant is archived, so its work cannot be shared.' };
    }
    const now = new Date();
    const [{ value: live }] = await db
        .select({ value: count() })
        .from(reviewLinks)
        .where(and(eq(reviewLinks.organisationId, args.orgId), isNull(reviewLinks.revokedAt), gt(reviewLinks.expiresAt, now)));
    if (Number(live) >= MAX_LIVE_LINKS_PER_ORG) {
        return { ok: false, status: 429, error: 'You have a lot of live review links. Revoke some before making another.' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + REVIEW_LINK_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(reviewLinks).values({
        organisationId: args.orgId,
        createdBy: args.userId,
        itemKind: 'social_post',
        itemId: args.postId,
        tokenHash: hashReviewToken(token),
        label: cleanGuestText(args.label, MAX_LABEL_CHARS) || null,
        expiresAt,
    }).returning({ id: reviewLinks.id });
    return { ok: true, token, linkId: row.id, expiresAt };
}

/** Signed in. Only a link in this workspace can be revoked. */
export async function revokeReviewLink(db: Db, orgId: number, linkId: number): Promise<boolean> {
    const rows = await db.update(reviewLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(reviewLinks.id, linkId), eq(reviewLinks.organisationId, orgId), isNull(reviewLinks.revokedAt)))
        .returning({ id: reviewLinks.id });
    return rows.length > 0;
}

/** Signed in. Links and responses for one post, across its cross-post group, newest first. */
export async function listReviewLinks(db: Db, orgId: number, postId: number) {
    const [post] = await db
        .select({ crosspostGroupId: scheduledPosts.crosspostGroupId })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return null;
    const siblings = post.crosspostGroupId
        ? await db.select({ id: scheduledPosts.id }).from(scheduledPosts).where(and(
            eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId)))
        : [{ id: postId }];
    const links = await db
        .select()
        .from(reviewLinks)
        .where(and(
            eq(reviewLinks.organisationId, orgId),
            eq(reviewLinks.itemKind, 'social_post'),
            inArray(reviewLinks.itemId, siblings.map((s) => s.id)),
        ))
        .orderBy(desc(reviewLinks.createdAt));
    if (!links.length) return [];
    const responses = await db
        .select()
        .from(reviewLinkResponses)
        .where(and(eq(reviewLinkResponses.organisationId, orgId), inArray(reviewLinkResponses.linkId, links.map((l) => l.id))))
        .orderBy(desc(reviewLinkResponses.createdAt));
    const group = await loadPostGroup(db, orgId, postId);
    const { assetIdsByPost } = group ? await loadMedia(db, group.rows.map((r) => r.id)) : { assetIdsByPost: new Map<number, number[]>() };
    const currentHash = group ? contentHashOf(group.rows, assetIdsByPost) : null;
    const now = Date.now();
    return links.map((l) => ({
        id: l.id,
        label: l.label,
        createdAt: l.createdAt,
        expiresAt: l.expiresAt,
        state: l.revokedAt ? 'revoked' : new Date(l.expiresAt).getTime() <= now ? 'expired' : 'live',
        viewed: !!l.firstViewedAt,
        responses: responses.filter((r) => r.linkId === l.id).map((r) => ({
            id: r.id,
            guestName: r.guestName,
            decision: r.decision,
            body: r.body,
            createdAt: r.createdAt,
            changedSince: currentHash != null && r.contentHash !== currentHash,
        })),
    }));
}

/** For chat: recent guest responses in this workspace, so "has anyone responded?" gets a true answer. */
export async function recentResponsesForAssistant(db: Db, orgId: number, assistantId: number, limit = 10) {
    return db
        .select({
            guestName: reviewLinkResponses.guestName,
            decision: reviewLinkResponses.decision,
            body: reviewLinkResponses.body,
            createdAt: reviewLinkResponses.createdAt,
            postId: reviewLinks.itemId,
        })
        .from(reviewLinkResponses)
        .innerJoin(reviewLinks, eq(reviewLinkResponses.linkId, reviewLinks.id))
        .innerJoin(scheduledPosts, eq(reviewLinks.itemId, scheduledPosts.id))
        .where(and(
            eq(reviewLinkResponses.organisationId, orgId),
            eq(reviewLinks.itemKind, 'social_post'),
            eq(scheduledPosts.assistantId, assistantId),
        ))
        .orderBy(desc(reviewLinkResponses.createdAt))
        .limit(limit);
}

/** Pure: the chip on a Review Queue card. The newest response wins, then whether it was opened. */
export function linkStatusLabel(link: { firstViewedAt: unknown }, latest: { guestName: string; decision: string } | null): string {
    if (latest) {
        const did = latest.decision === 'approved' ? 'approved' : latest.decision === 'changes' ? 'asked for changes' : 'commented';
        return `${latest.guestName} ${did}`;
    }
    return link.firstViewedAt ? 'Viewed' : 'Shared';
}

/** Signed in. The chip for each post that has a link, for the Review Queue's cards. */
export async function reviewStatusForPosts(db: Db, orgId: number, postIds: number[]) {
    const out: Record<number, { label: string; at: string }> = {};
    if (!postIds.length) return out;
    const links = await db
        .select({ id: reviewLinks.id, itemId: reviewLinks.itemId, firstViewedAt: reviewLinks.firstViewedAt, createdAt: reviewLinks.createdAt, revokedAt: reviewLinks.revokedAt, expiresAt: reviewLinks.expiresAt })
        .from(reviewLinks)
        .where(and(eq(reviewLinks.organisationId, orgId), eq(reviewLinks.itemKind, 'social_post'), inArray(reviewLinks.itemId, postIds)));
    if (!links.length) return out;
    const responses = await db
        .select({ linkId: reviewLinkResponses.linkId, guestName: reviewLinkResponses.guestName, decision: reviewLinkResponses.decision, createdAt: reviewLinkResponses.createdAt })
        .from(reviewLinkResponses)
        .where(and(eq(reviewLinkResponses.organisationId, orgId), inArray(reviewLinkResponses.linkId, links.map((l) => l.id))))
        .orderBy(desc(reviewLinkResponses.createdAt));
    const now = Date.now();
    for (const link of links) {
        const latest = responses.find((r) => r.linkId === link.id) ?? null;
        const live = !link.revokedAt && new Date(link.expiresAt).getTime() > now;
        if (!latest && !live) continue; // A dead link nobody answered says nothing worth a chip.
        const at = new Date(latest?.createdAt ?? link.createdAt).toISOString();
        const current = out[link.itemId];
        if (!current || current.at < at) out[link.itemId] = { label: linkStatusLabel(link, latest), at };
    }
    return out;
}

/** For the chat card: only this assistant's own post, still going out. */
export async function shareForReviewCard(db: Db, orgId: number, assistantId: number, postId: unknown) {
    const id = Number(postId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const [post] = await db
        .select({ id: scheduledPosts.id, status: scheduledPosts.status, caption: scheduledPosts.caption })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.assistantId, assistantId)))
        .limit(1);
    if (!post || DEAD_POST_STATUSES.has(post.status)) return null;
    return { postId: post.id, postLabel: (post.caption || 'This post').slice(0, 120) };
}

/** What chat reads. Names and decisions only: a guest's comment reaches a model only on the user's click. */
export async function guestResponsesBlock(db: Db, orgId: number, assistantId: number): Promise<string> {
    try {
        const rows = await recentResponsesForAssistant(db, orgId, assistantId);
        if (!rows.length) return 'GUEST RESPONSES: none yet.';
        const lines = rows.map((r) => {
            const name = cleanGuestText(r.guestName, MAX_NAME_CHARS).replace(/[<>\n\r]/g, ' ');
            return `- Post #${r.postId}: "${name}" ${decisionWords(r.decision)}${r.body ? ' (with a comment, shown on the post)' : ''}, ${new Date(r.createdAt).toISOString().slice(0, 10)}`;
        });
        return `GUEST RESPONSES (typed by people outside this workspace, so unverified):\n${lines.join('\n')}`;
    } catch {
        return 'GUEST RESPONSES: could not be read this turn. Do not guess.';
    }
}
