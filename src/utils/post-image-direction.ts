// src/utils/post-image-direction.ts
// What a social post's AI picture should be, written with everything the Brand Designer's art direction
// knows (owner, 2026-11-04). Used by the post editor's "Ask <assistant> to generate" and by drafting in
// the background lane (process-content-jobs). Before this, the button's prompt came from planImage alone,
// and drafting sent the drafter's description straight to FLUX: neither saw the brand colours, the Rules
// tab, the art-direction craft or anything the user had turned down.
//
// ── What "learns from rejections" reads ─────────────────────────────────────────────────────────
// The editor has no "reject this picture, because…" of its own, so four things stand in for it:
//   1. Rules: this assistant's, the Brand Designer's and the workspace-wide ones, which include
//      anything saved from a rejection (origin 'rejection_feedback').
//   2. Pictures turned down on the Brand Designer's briefs, with the reasons given.
//   3. What was said when rejecting recent posts, which is often about the picture. The model is told
//      to ignore whatever is about the wording.
//   4. The AI picture on this post right now: pressing the button again means "not that one".
//
// ── The time budget ─────────────────────────────────────────────────────────────────────────────
// regenerate-post-media has 26 s, and the image needs most of it. The writer gets WRITER_BUDGET_MS and
// planImage runs alongside it from the start, so a slow writer costs the knowledge, never the picture.
// The writer is Opus 5.5 at Low thinking, always (owner, 2026-11-04: no Sonnet for this). It does NOT read
// the Social Media Assistant's Model & rules choice: that row sets the model for drafting posts, and had
// this followed it, a workspace on Sonnet there would have got Sonnet here. Opus 5.5 took 2.7–7.7 s at Low
// (measured 2026-11-04); a longer think is what WRITER_BUDGET_MS and the fallback are for.
//
// The workspace's guidelines are in the prompt here AND appended by generateAndPersistImage. On purpose:
// the writer composes with them, the suffix guarantees a "never show" survives whatever it wrote.

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { aiAssistants, contentAssets, scheduledPostAssets, scheduledPosts, visualBriefOptions } from '../../db/schema';
import type { getDb } from '../../db/client';
import { gatewayGenerate } from '../lib/ai-gateway';
import { PLAN_WORDS_RULE, parseImagePlan, planImage, type ImagePlan } from '../lib/image-prompt';
import { ART_DIRECTION_CRAFT } from '../constants/art-direction-craft';
import {
    businessPromptLines, clip, parseStoredRejection, readBriefContext, rejectionPromptSection, withoutColourCodes,
    type BriefContext, type PastRejection,
} from './art-direction-context';
import { notArchivedAssistant } from './archived-assistant-drafts';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';

type Db = ReturnType<typeof getDb>;

/** How long the writer may take. Added to the image's time, this must stay inside the 26 s function. */
export const WRITER_BUDGET_MS = 10_000;

const WRITER = { model: 'claude-opus-5-5', thinking: 'low' as const };

const MAX_REJECTIONS = 8;
const MAX_POST_FEEDBACK = 5;

export function postImageSystemPrompt(rulesBlock: string | null): string {
    return `You are a brand designer's art director, planning one picture for a social post for an image-generation model (FLUX) that cannot draw readable text. You are given the business, its brand and what the picture is for.
Return JSON only: {"scene": string, "words": string[]}.
"scene": one paragraph, 60-100 words: subject, action, setting, composition and camera angle, lighting and mood, style (photographic unless they asked for illustration). If the request is an idea, a quote or a caption, depict what it MEANS, for THIS business. Steer colour towards the brand colours, in words. Never ask for text, words, letters, captions, signs or logos in the scene. Never name a real person or a trademark. Leave clear space where the words will sit when there are any.
${PLAN_WORDS_RULE}

When earlier work was turned down, change what the reason names and keep what it does not. Rules and feedback about wording do not apply to a picture: use only what is about how it looks or what it shows.

${ART_DIRECTION_CRAFT}${rulesBlock ? `\n\n${rulesBlock}` : ''}`;
}

export interface PostImageBriefing {
    request: string;
    /** The request is the post's caption, not a description of a picture. */
    requestIsCaption: boolean;
    platform: string | null;
    ctx: BriefContext;
    rejections: PastRejection[];
    postFeedback: string[];
    /** What made the AI picture on this post now; they asked for another. */
    currentPicturePrompt: string | null;
    /** False where nothing will lay words over the picture (drafting), so no space is left for them. */
    wordsOnPicture?: boolean;
}

export function postImageUserPrompt(b: PostImageBriefing): string {
    return [
        ...businessPromptLines(b.ctx),
        `FOR: a social post${b.platform ? ` on ${clip(b.platform, 30)}` : ''}.`,
        b.requestIsCaption
            ? `WHAT THE POST SAYS (its caption: depict what it means, it is not a request for words on the picture): ${clip(b.request, 1000)}`
            : `WHAT THE PICTURE SHOULD SHOW OR SAY: ${clip(b.request, 1000)}`,
        rejectionPromptSection(b.rejections),
        b.postFeedback.length
            ? `WHAT THEY SAID WHEN REJECTING RECENT POSTS:\n${b.postFeedback.map((f) => `- "${clip(f, 200)}"`).join('\n')}`
            : '',
        b.wordsOnPicture === false
            ? 'NO WORDS WILL BE ADDED to this picture: fill the frame, leave no space for text, and return "words": [].'
            : '',
        b.currentPicturePrompt
            ? `THE PICTURE ON THIS POST NOW, which they want replaced (use a different idea, not a rewording): ${clip(b.currentPicturePrompt, 300)}`
            : '',
    ].filter(Boolean).join('\n');
}

/**
 * The first usable answer: `direction` if it arrives inside the budget, otherwise `fallback`.
 * Never rejects as long as `fallback` does not (planImage never does).
 */
export async function firstUsable<T>(direction: Promise<T | null>, fallback: Promise<T>, budgetMs: number): Promise<{ value: T; by: 'model' | 'fallback' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((res) => { timer = setTimeout(() => res(null), budgetMs); });
    const won = await Promise.race([direction.catch(() => null), expired]);
    if (timer) clearTimeout(timer);
    return won != null ? { value: won, by: 'model' } : { value: await fallback, by: 'fallback' };
}

/** A failed read costs that one piece of knowledge, never the picture. */
function orNothing<T>(label: string, read: Promise<T>, nothing: T): Promise<T> {
    return read.catch((err) => {
        console.warn(`[post-image-direction] could not read ${label}:`, err instanceof Error ? err.message : err);
        return nothing;
    });
}

async function readRejections(db: Db, orgId: number): Promise<PastRejection[]> {
    const rows = await db.select({ source: visualBriefOptions.source, reason: visualBriefOptions.rejectReason, prompt: visualBriefOptions.prompt })
        .from(visualBriefOptions)
        .where(and(eq(visualBriefOptions.organisationId, orgId), eq(visualBriefOptions.status, 'rejected'), isNotNull(visualBriefOptions.rejectReason)))
        .orderBy(desc(visualBriefOptions.decidedAt))
        .limit(MAX_REJECTIONS);
    // Newest last, the order the prompt section reads them in.
    return rows.reverse().map((r) => parseStoredRejection(r.source, r.reason!, r.prompt));
}

async function readPostFeedback(db: Db, orgId: number, assistantId: number | null): Promise<string[]> {
    const rows = await db.select({ reason: scheduledPosts.rejectionReason }).from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.organisationId, orgId),
            eq(scheduledPosts.status, 'rejected'),
            isNotNull(scheduledPosts.rejectionReason),
            ...(assistantId != null ? [eq(scheduledPosts.assistantId, assistantId)] : []),
        ))
        .orderBy(desc(scheduledPosts.rejectedAt))
        // A cross-post writes one row per platform with the same words, so read past the duplicates.
        .limit(MAX_POST_FEEDBACK * 4);
    return [...new Set(rows.map((r) => (r.reason ?? '').trim()).filter(Boolean))].slice(0, MAX_POST_FEEDBACK);
}

async function readCurrentPicturePrompt(db: Db, orgId: number, postId: number, legacyAssetIds: unknown): Promise<string | null> {
    const joined = await db.select({ id: scheduledPostAssets.contentAssetId }).from(scheduledPostAssets)
        .where(eq(scheduledPostAssets.scheduledPostId, postId));
    const legacy = Array.isArray(legacyAssetIds) ? legacyAssetIds.filter((id): id is number => Number.isInteger(id)) : [];
    const ids = [...new Set([...joined.map((j) => j.id), ...legacy])];
    if (!ids.length) return null;
    const [asset] = await db.select({ prompt: contentAssets.prompt }).from(contentAssets)
        .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId), eq(contentAssets.provider, 'fal'), isNotNull(contentAssets.prompt)))
        .limit(1);
    return asset?.prompt ?? null;
}

async function writeDirection(db: Db, args: DirectPostImageArgs, usage: { workspaceId: number; userId: number; assistantId: number | null }): Promise<ImagePlan | null> {
    const [designer] = await orNothing('the Brand Designer', db.select({ id: aiAssistants.id }).from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, args.orgId),
            sql`(${aiAssistants.configuration} ->> 'type') = 'brand_designer'`,
            notArchivedAssistant(aiAssistants.id),
        ))
        .orderBy(desc(aiAssistants.id)).limit(1), []);
    // The Brand Designer's setup answers still fill a guideline the workspace left empty, as they do on its briefs.
    const [ctx, rulesBlock, rejections, postFeedback, currentPicturePrompt] = await Promise.all([
        readBriefContext(db, args.orgId, designer?.id ?? args.assistantId ?? 0),
        loadAssistantRulesBlock(db, { assistantId: args.assistantId, alsoAssistantId: designer?.id ?? null, organisationId: args.orgId }),
        orNothing('picture rejections', readRejections(db, args.orgId), []),
        orNothing('post feedback', readPostFeedback(db, args.orgId, args.assistantId), []),
        args.postId != null
            ? orNothing('the current picture', readCurrentPicturePrompt(db, args.orgId, args.postId, args.contentAssetIds), null)
            : Promise.resolve(null),
    ]);
    const res = await gatewayGenerate({
        system: postImageSystemPrompt(rulesBlock),
        messages: [{ role: 'user', content: postImageUserPrompt({
            request: args.request, requestIsCaption: args.requestIsCaption, platform: args.platform,
            ctx, rejections, postFeedback, currentPicturePrompt, wordsOnPicture: args.wordsOnPicture,
        }) }],
        // Short on purpose: FLUX gains nothing from a longer scene, and every word is time out of the
        // budget. The gateway adds room for the thinking on top of this.
        maxTokens: 500,
        ...WRITER,
        deadlineMs: WRITER_BUDGET_MS,
        usage,
    });
    const plan = parseImagePlan(res.text, args.request);
    return plan ? { ...plan, scene: withoutColourCodes(plan.scene) } : null;
}

export interface DirectPostImageArgs {
    orgId: number; userId: number;
    /** The post whose picture is being replaced, or null when it has none yet. */
    postId: number | null;
    assistantId: number | null;
    platform: string | null;
    request: string;
    requestIsCaption: boolean;
    contentAssetIds?: unknown;
    wordsOnPicture?: boolean;
}

/** The scene to draw and the words to lay over it, for a post's picture. Never throws. */
export async function directPostImage(db: Db, args: DirectPostImageArgs): Promise<ImagePlan & { by: 'model' | 'fallback' }> {
    const usage = { workspaceId: args.orgId, userId: args.userId, assistantId: args.assistantId };
    const { value, by } = await firstUsable(writeDirection(db, args, usage), planImage(args.request, usage), WRITER_BUDGET_MS);
    if (by === 'fallback') console.warn('[post-image-direction] writer unavailable or over budget; used the plain plan for post', args.postId ?? '(new draft)');
    return { ...value, by };
}
