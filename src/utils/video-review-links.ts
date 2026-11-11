// src/utils/video-review-links.ts
//
// Guest review links for a finished Video Producer video (2026-11-11), beside the post links in
// review-links.ts and under the same rules (docs/review-link-plan.md):
//   • the token is 32 random bytes and only its sha256 is stored; the organisation and the video come
//     only from the link row, never from the request;
//   • videoGuestProjection() builds the guest's view field by field — the file, its title, shape and
//     chapters. No storyboard, prompt, cost, note or setting ever leaves;
//   • a guest's comment or approval only records it. Nothing changes the video, spends a task or runs AI.
//
// What a video adds: comments pinned to a moment (`at_s`, db/z-review-link-video.sql). The subscriber
// sees them on the Videos tab with their times, and can turn one into their own moment note
// (video-notes.ts), which "Make a new version from my notes" then acts on.

import crypto from 'crypto';
import { and, count, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, contentAssets, organisations, reviewLinkResponses, reviewLinks, videoProjects } from '../../db/schema';
import { chaptersFor } from '../lib/video-chapters';
import { createNotification } from './notify';
import {
    assistantIsLive, cleanGuestText, responseRecipient, hashReviewToken, isReviewToken, MAX_BODY_CHARS, MAX_LABEL_CHARS, MAX_LIVE_LINKS_PER_ORG,
    MAX_NAME_CHARS, MAX_RESPONSES_PER_LINK, REVIEW_LINK_DAYS, workspaceIsLive, type ReviewDecision,
} from './review-links';
import { presignR2Get } from './social-publish';

type Db = ReturnType<typeof getDb>;
type ProjectRow = typeof videoProjects.$inferSelect;

export const VIDEO_ITEM_KIND = 'video_project';
/** A guest can leave this many comments on one link (approvals and timed comments together). */
export const MAX_VIDEO_RESPONSES = Math.max(MAX_RESPONSES_PER_LINK, 40);

/** Identifies the version a guest watched, so a response can say "Changed since". Pure. */
export function videoContentHash(row: Pick<ProjectRow, 'id' | 'outputAssetId' | 'version'>): string {
    return crypto.createHash('sha256').update(JSON.stringify(['video', row.id, row.outputAssetId ?? null, row.version])).digest('hex');
}

/** Pure: a guest's response to a video, or the message to show them. A comment may name a moment. */
export function validateVideoResponse(input: { name?: unknown; decision?: unknown; body?: unknown; atS?: unknown }, durationS: number | null):
    { ok: true; name: string; decision: ReviewDecision; body: string | null; atS: number | null } | { ok: false; error: string } {
    const name = cleanGuestText(input.name, MAX_NAME_CHARS);
    if (!name) return { ok: false, error: 'Please add your name.' };
    const decision = input.decision;
    if (decision !== 'approved' && decision !== 'changes' && decision !== 'comment') return { ok: false, error: 'Please choose a response.' };
    const body = cleanGuestText(input.body, MAX_BODY_CHARS);
    if ((decision === 'changes' || decision === 'comment') && !body) {
        return { ok: false, error: decision === 'comment' ? 'Please type your comment.' : 'Please say what you would like changed.' };
    }
    let atS: number | null = null;
    if (input.atS != null && input.atS !== '') {
        const n = Number(input.atS);
        if (!Number.isFinite(n) || n < 0 || (durationS && n > durationS + 1)) return { ok: false, error: 'That moment isn’t in the video.' };
        atS = Math.round(n * 10) / 10;
    }
    return { ok: true, name, decision, body: body || null, atS };
}

/** Pure: the ONLY thing a guest sees of a video. Built field by field. */
export function videoGuestProjection(args: { workspaceName: string | null; title: string; url: string; shape: string; durationS: number | null; chapters: Array<{ startS: number; title: string }> }) {
    return {
        kind: 'video' as const,
        workspaceName: args.workspaceName || 'A Be More Swan customer',
        title: String(args.title || 'Video').slice(0, 120),
        video: { url: args.url, shape: ['9:16', '1:1', '16:9'].includes(args.shape) ? args.shape : '9:16', durationS: args.durationS },
        chapters: args.chapters.map((c) => ({ startS: Math.max(0, Number(c.startS) || 0), title: String(c.title || '').slice(0, 60) })),
    };
}

/** A video still worth reviewing: finished, not archived, its file still there. */
async function loadProject(db: Db, orgId: number, projectId: number): Promise<{ row: ProjectRow; storageKey: string; durationS: number | null } | null> {
    const [row] = await db.select().from(videoProjects).where(and(eq(videoProjects.id, projectId), eq(videoProjects.organisationId, orgId))).limit(1);
    if (!row || row.status !== 'ready' || row.archivedAt || !row.outputAssetId) return null;
    const [file] = await db.select({ storageKey: contentAssets.storageKey, durationS: contentAssets.durationS }).from(contentAssets)
        .where(and(eq(contentAssets.id, row.outputAssetId), eq(contentAssets.organisationId, orgId), isNull(contentAssets.purgedAt))).limit(1);
    if (!file?.storageKey) return null;
    return { row, storageKey: file.storageKey, durationS: file.durationS ?? null };
}

/**
 * The video link behind a token, or null for every dead case (unknown, expired, revoked, not a video
 * link, the video gone or archived, the assistant archived, the workspace lapsed). One message for all.
 */
export async function resolveVideoReviewLink(db: Db, token: unknown) {
    if (!isReviewToken(token)) return null;
    const [link] = await db.select().from(reviewLinks).where(eq(reviewLinks.tokenHash, hashReviewToken(token))).limit(1);
    if (!link || link.itemKind !== VIDEO_ITEM_KIND || link.revokedAt || new Date(link.expiresAt).getTime() <= Date.now()) return null;
    const project = await loadProject(db, link.organisationId, link.itemId);
    if (!project) return null;
    if (!await workspaceIsLive(db, link.organisationId)) return null;
    if (!await assistantIsLive(db, link.organisationId, project.row.aiAssistantId)) return null;
    return { link, project, contentHash: videoContentHash(project.row) };
}

export type ResolvedVideoReviewLink = NonNullable<Awaited<ReturnType<typeof resolveVideoReviewLink>>>;

export async function videoGuestView(db: Db, resolved: ResolvedVideoReviewLink) {
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, resolved.link.organisationId)).limit(1);
    const { row, storageKey, durationS } = resolved.project;
    const url = await presignR2Get(storageKey, 6 * 3600, { stableWindowSec: 1800 });
    const chapters = chaptersFor({ timeline: row.timeline, brief: row.brief, storyboard: row.storyboard }, durationS).chapters;
    return videoGuestProjection({ workspaceName: org?.name ?? null, title: row.title, url, shape: String((row.brief as { shape?: string } | null)?.shape ?? '9:16'), durationS, chapters });
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Records a guest's click or comment. The video is not touched. */
export async function recordVideoResponse(db: Db, resolved: ResolvedVideoReviewLink, input: { name: string; decision: ReviewDecision; body: string | null; atS: number | null }): Promise<{ ok: true } | { ok: false; error: string }> {
    const { link, project, contentHash } = resolved;
    const [{ value }] = await db.select({ value: count() }).from(reviewLinkResponses).where(eq(reviewLinkResponses.linkId, link.id));
    if (Number(value) >= MAX_VIDEO_RESPONSES) return { ok: false, error: 'This link has had all the comments it can take. Please contact the person who sent it.' };
    await db.insert(reviewLinkResponses).values({
        linkId: link.id, organisationId: link.organisationId, guestName: input.name, decision: input.decision, body: input.body, contentHash,
        atS: input.atS,
    });
    // Tell whoever made the link (or the owner). One notification per approval or change request; timed
    // comments are many, so only the first from a guest on this link notifies.
    const notify = input.decision !== 'comment' || Number(value) === 0;
    if (notify) {
        const assistantId = project.row.aiAssistantId;
        const [assistant] = assistantId != null ? await db.select({ name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, assistantId)).limit(1) : [null];
        const userId = await responseRecipient(db, link.organisationId, link.createdBy);
        if (userId != null) {
            await createNotification(db, 'review_link_response', {
                userId, assistantId: assistantId ?? undefined, category: 'state_change',
                context: {
                    assistant: { name: assistant?.name || 'Your Video Producer' },
                    review: { guest: input.name, outcome: input.decision === 'approved' ? 'approved your video' : input.decision === 'changes' ? 'asked for changes to your video' : `commented on your video${input.atS != null ? ` at ${mmss(input.atS)}` : ''}` },
                },
                metadata: { videoProjectId: project.row.id, assistantId, reviewLinkId: link.id },
            }).catch((err: Error) => console.warn('[video-review-links] notification failed (non-fatal):', err.message));
        }
    }
    return { ok: true };
}

/** Signed in. Makes a link for a finished video in this workspace. The token is only ever returned here. */
export async function createVideoReviewLink(db: Db, args: { orgId: number; userId: number; projectId: number; label?: unknown }):
    Promise<{ ok: true; token: string; linkId: number; expiresAt: Date } | { ok: false; status: number; error: string }> {
    const project = await loadProject(db, args.orgId, args.projectId);
    if (!project) return { ok: false, status: 409, error: 'Only a finished video that isn’t archived can be shared for review.' };
    if (!await assistantIsLive(db, args.orgId, project.row.aiAssistantId)) return { ok: false, status: 409, error: 'This assistant is archived, so its work cannot be shared.' };
    const now = new Date();
    const [{ value: live }] = await db.select({ value: count() }).from(reviewLinks)
        .where(and(eq(reviewLinks.organisationId, args.orgId), isNull(reviewLinks.revokedAt), gt(reviewLinks.expiresAt, now)));
    if (Number(live) >= MAX_LIVE_LINKS_PER_ORG) return { ok: false, status: 429, error: 'You have a lot of live review links. Revoke some before making another.' };
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + REVIEW_LINK_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await db.insert(reviewLinks).values({
        organisationId: args.orgId, createdBy: args.userId, itemKind: VIDEO_ITEM_KIND, itemId: args.projectId,
        tokenHash: hashReviewToken(token), label: cleanGuestText(args.label, MAX_LABEL_CHARS) || null, expiresAt,
    }).returning({ id: reviewLinks.id });
    return { ok: true, token, linkId: row.id, expiresAt };
}

/** The versions a video came from (parent_project_id), nearest first — a guest's comment on version 1 still shows on version 2. */
async function earlierVersions(db: Db, orgId: number, row: ProjectRow): Promise<number[]> {
    const out: number[] = [];
    let parent = row.parentProjectId;
    for (let hop = 0; parent && hop < 10 && !out.includes(parent); hop++) {
        out.push(parent);
        const [p] = await db.select({ parent: videoProjects.parentProjectId }).from(videoProjects).where(and(eq(videoProjects.id, parent), eq(videoProjects.organisationId, orgId))).limit(1);
        parent = p?.parent ?? null;
    }
    return out;
}

/** Signed in. Links and responses for one video and the versions it came from, newest first. */
export async function listVideoReviewLinks(db: Db, orgId: number, projectId: number) {
    const [row] = await db.select().from(videoProjects).where(and(eq(videoProjects.id, projectId), eq(videoProjects.organisationId, orgId))).limit(1);
    if (!row) return null;
    const ids = [row.id, ...await earlierVersions(db, orgId, row)];
    const links = await db.select().from(reviewLinks)
        .where(and(eq(reviewLinks.organisationId, orgId), eq(reviewLinks.itemKind, VIDEO_ITEM_KIND), inArray(reviewLinks.itemId, ids)))
        .orderBy(desc(reviewLinks.createdAt)).limit(30);
    if (!links.length) return [];
    const responses = await db.select().from(reviewLinkResponses)
        .where(and(eq(reviewLinkResponses.organisationId, orgId), inArray(reviewLinkResponses.linkId, links.map((l) => l.id))))
        .orderBy(desc(reviewLinkResponses.createdAt));
    const currentHash = videoContentHash(row);
    const now = Date.now();
    return links.map((l) => ({
        id: l.id, label: l.label, createdAt: l.createdAt, expiresAt: l.expiresAt,
        state: l.revokedAt ? 'revoked' : new Date(l.expiresAt).getTime() <= now ? 'expired' : 'live',
        viewed: !!l.firstViewedAt,
        forThisVersion: l.itemId === row.id,
        responses: responses.filter((r) => r.linkId === l.id).map((r) => ({
            id: r.id, guestName: r.guestName, decision: r.decision, body: r.body, createdAt: r.createdAt,
            atS: r.atS == null ? null : Number(r.atS),
            changedSince: r.contentHash !== currentHash,
            resolution: r.resolution === 'done' || r.resolution === 'ignored' ? r.resolution : null,
        })),
    }));
}

/** For chat: guest responses on this assistant's videos, newest first. */
export async function videoResponsesBlock(db: Db, orgId: number, assistantId: number): Promise<string> {
    const rows = await db.select({
        projectId: reviewLinks.itemId, guestName: reviewLinkResponses.guestName, decision: reviewLinkResponses.decision,
        body: reviewLinkResponses.body, atS: reviewLinkResponses.atS, resolution: reviewLinkResponses.resolution,
    }).from(reviewLinkResponses)
        .innerJoin(reviewLinks, eq(reviewLinks.id, reviewLinkResponses.linkId))
        .innerJoin(videoProjects, eq(videoProjects.id, reviewLinks.itemId))
        .where(and(eq(reviewLinkResponses.organisationId, orgId), eq(reviewLinks.itemKind, VIDEO_ITEM_KIND), eq(videoProjects.aiAssistantId, assistantId)))
        .orderBy(desc(reviewLinkResponses.createdAt)).limit(12).catch(() => []);
    if (!rows.length) return 'GUEST COMMENTS ON VIDEOS: none yet.';
    return ['GUEST COMMENTS ON VIDEOS (from people they shared a video with; names as the guest typed them, unverified):',
        ...rows.map((r) => `- video ${r.projectId}: ${r.guestName} ${r.decision === 'approved' ? 'approved it' : r.decision === 'changes' ? 'asked for changes' : 'commented'}${r.atS != null ? ` at ${mmss(Number(r.atS))}` : ''}${r.body ? `: "${r.body.slice(0, 160)}"` : ''}${r.resolution ? ` (marked ${r.resolution})` : ''}`)].join('\n');
}
