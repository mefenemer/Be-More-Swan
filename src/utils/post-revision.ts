// src/utils/post-revision.ts
// What a revision job knows about the draft it replaces (2026-11-07).
//
// "Request changes" (request-post-changes.ts, which the guest review link's "Use these comments" fills)
// and "Reject and redraft" (reject-post.ts) both queue a fresh drafting job with the feedback as
// context. Until now that job never saw the draft it was revising: the drafter was told "revise the
// previous draft" with no previous draft, and the picture writer never saw the feedback at all. So
// "the image is too dark" produced a brand-new picture from the same brand steer, just as dark.
//
// A revision job carries revised_from_post_id. process-content-jobs reads the old post through
// loadPreviousDraft and gives the drafter previousDraftBlock, and gives the picture writer the feedback
// and the old picture's prompt so it changes what was named and keeps the rest.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { contentAssets, scheduledPostAssets, scheduledPosts } from '../../db/schema';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export interface PreviousDraft {
    caption: string;
    /** The prompt that made its AI picture, or null when it had stock, library or no media. */
    picturePrompt: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The draft a revision replaces, in this workspace only. Null when it is gone. Throws on a DB error. */
export async function loadPreviousDraft(db: Db, orgId: number, postId: number): Promise<PreviousDraft | null> {
    const [post] = await db
        .select({ caption: scheduledPosts.caption, legacy: scheduledPosts.contentAssetIds })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return null;
    const joined = await db.select({ id: scheduledPostAssets.contentAssetId }).from(scheduledPostAssets)
        .where(eq(scheduledPostAssets.scheduledPostId, postId));
    const legacy = Array.isArray(post.legacy) ? (post.legacy as unknown[]).filter((id): id is number => Number.isInteger(id)) : [];
    const ids = [...new Set([...joined.map((j) => j.id), ...legacy])];
    let picturePrompt: string | null = null;
    if (ids.length) {
        const [asset] = await db.select({ prompt: contentAssets.prompt }).from(contentAssets)
            .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId), isNotNull(contentAssets.prompt)))
            .limit(1);
        picturePrompt = asset?.prompt?.trim() || null;
    }
    return { caption: (post.caption || '').trim(), picturePrompt };
}

/** Pure: the drafter's view of the draft it is revising. Goes right before the user's feedback. */
export function previousDraftBlock(prev: PreviousDraft): string {
    return [
        'THIS IS A REVISION of a draft the user has already seen. Their feedback follows.',
        prev.caption ? `THE PREVIOUS CAPTION:\n"""\n${clip(prev.caption, 2500)}\n"""` : '',
        prev.picturePrompt ? `THE PREVIOUS PICTURE was made from this description: ${clip(prev.picturePrompt, 800)}` : '',
        'Change exactly what the feedback names and keep everything it does not mention.',
        '- Feedback only about the picture: keep the caption as it was (word for word is fine), and write "suggestedMediaDescription" as the same picture with that change made plainly and strongly (for example, "too dark" means a bright, well-lit, high-key picture with a light background, not a slightly lighter version of the same dark one).',
        '- Feedback only about the words: rewrite the caption, and describe the same picture in "suggestedMediaDescription".',
        '- The feedback beats the brand colours, the lighting habits and the style used before.',
    ].filter(Boolean).join('\n');
}

/** Pure: the picture writer's section for a revision. The feedback is the user's own words, or a guest's they chose to use. */
export function revisionPictureSection(feedback: string, previousPicturePrompt: string | null): string {
    return [
        `THIS IS A REVISION. What they said about the last version: "${clip(feedback, 600)}"`,
        previousPicturePrompt ? `THE LAST PICTURE was made from: ${clip(previousPicturePrompt, 600)}` : '',
        'If the feedback is about the picture, keep its idea and make exactly that change, plainly and strongly: it beats the brand colours and the usual lighting and style (too dark means bright and well lit with a light background; too busy means one simple subject). If it is only about the words, keep the picture close to the last one.',
    ].filter(Boolean).join('\n');
}
