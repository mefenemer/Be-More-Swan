// src/utils/newsletter-from-post.ts
// "Your blog post went out to your subscribers on Thursday, and you didn't do anything."
//
// One function: turn a published blog post into a newsletter issue DRAFT for a named Newsletter
// Assistant. Called from the orchestration runtime when a Blog Writer's "publishes a post" link
// points at a newsletter role.
//
// ── Four decisions, each of which is the interesting part ───────────────────────────────────────
//
// 1. IT DRAFTS. IT NEVER SENDS. The issue lands in 'pending_approval' like every other draft in
//    this product, and process-newsletter-sends only ever picks up an issue a person approved.
//    "You approve every issue" is catalogue copy, so it has to be structurally true — an automated
//    hand-off is exactly where a product quietly stops honouring that claim.
//
// 2. THE LINK TO THE POST IS ADDED IN CODE. An issue about a post that does not link to the post is
//    the one outcome that makes the whole feature pointless, and a drafting model will occasionally
//    paraphrase a URL or invent a tidier one. Same rule as the unsubscribe footer: what must be
//    exactly right is appended, not requested. See appendSourceLink in newsletter-generate.ts.
//
// 3. ONE ISSUE PER POST PER ASSISTANT, ENFORCED IN THE DATABASE. Unpublish → republish is a
//    supported, lossless round trip on blog_posts and it fires the hand-off again. The unique index
//    on (assistant_id, source_blog_post_id) is what stops the second publish drafting a duplicate
//    of an email the tenant has already reviewed.
//
// 4. A FAILED DRAFT LEAVES NOTHING BEHIND. If the model call fails we delete the placeholder row
//    rather than leaving an empty issue in the review queue — which also frees the unique key, so
//    the next republish can try again instead of being refused by a row nobody wanted.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts, newsletterIssues } from '../../db/schema';
import { generateIssueBody } from './newsletter-generate';

type Db = ReturnType<typeof getDb>;

/** Stamped before drafting, so generateIssueBody's COALESCE keeps this over the generic marker. */
export const BLOG_HANDOFF_REASON = 'blog_post_handoff';

/** How much of the post the drafting model is shown. Enough to write about; not the whole thing. */
export const MAX_EXCERPT_CHARS = 2500;

export interface DraftIssueFromPostArgs {
    organisationId: number;
    /** Whose AI usage this run is billed to — the person whose publish triggered the hand-off. */
    userId: number;
    /** The Newsletter Assistant the link hands off to. Named by the link, never guessed. */
    assistantId: number;
    sourcePostId?: number | null;
    /** Only a blog post has a body we can read; a social post gives us its caption and no more. */
    sourcePostKind?: string | null;
    sourceCaption?: string | null;
    /**
     * The link's own words for the hand-off ("write an issue about it, keep it short"). The user
     * typed it when they built the workflow, and ignoring it would make the freeform field
     * decorative — it is the only place they get to say HOW the post should be covered.
     */
    targetAction?: string | null;
}

export interface DraftIssueFromPostResult {
    issueId: number | null;
    reason?: 'already_drafted' | 'no_source' | 'generation_failed';
}

/**
 * Reduce a post body to something worth putting in a prompt.
 *
 * Images and link targets are dropped — the model cannot see an image and has no use for a URL it
 * is forbidden to write. Front matter goes too: a YAML block at the top reads to a model like
 * content, and "title: ..." has turned up quoted in a draft before.
 */
export function excerptForPrompt(markdown: string, limit = MAX_EXCERPT_CHARS): string {
    let text = String(markdown || '');
    text = text.replace(/^---\n[\s\S]*?\n---\n/, '');          // front matter
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');          // images
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');       // links → their text
    text = text.replace(/```[\s\S]*?```/g, '');                // code fences
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    if (text.length <= limit) return text;
    // Cut at a paragraph break rather than mid-sentence, so the model is not asked to write about
    // half a thought.
    const cut = text.slice(0, limit);
    const lastBreak = cut.lastIndexOf('\n\n');
    return (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
}

/**
 * Draft an issue for `assistantId` about the post that triggered the hand-off.
 *
 * Returns `{ issueId: null, reason }` for every expected no-op — an issue that already exists, or a
 * hand-off carrying nothing to write about. THROWS only on an unexpected database failure, which
 * the orchestration runtime catches: a hand-off must never break the publish that triggered it.
 */
export async function draftIssueFromPost(
    db: Db,
    args: DraftIssueFromPostArgs,
): Promise<DraftIssueFromPostResult> {
    const isBlogPost = args.sourcePostKind === 'blog_post' && !!args.sourcePostId;

    const [post] = isBlogPost
        ? await db
            .select({
                id: blogPosts.id,
                title: blogPosts.title,
                bodyMarkdown: blogPosts.bodyMarkdown,
                metaDescription: blogPosts.metaDescription,
                canonicalUrl: blogPosts.canonicalUrl,
            })
            .from(blogPosts)
            .where(and(
                eq(blogPosts.id, args.sourcePostId as number),
                eq(blogPosts.organisationId, args.organisationId),
            ))
            .limit(1)
        : [];

    const caption = String(args.sourceCaption || '').trim();
    const title = (post?.title || caption).trim();
    // Nothing to write about is not a failure — it is a hand-off from a source that carries no
    // words, and drafting an issue from an empty brief would produce invented content.
    if (!title) return { issueId: null, reason: 'no_source' };

    const excerpt = post ? excerptForPrompt(post.bodyMarkdown || '') : '';
    const instruction = String(args.targetAction || '').trim().slice(0, 300);
    const notes = [
        post ? 'This issue tells subscribers about a post that has just gone up on the blog.' : '',
        instruction ? `What the business asked for when they set this up: ${instruction}` : '',
        post?.metaDescription ? `The post's summary: ${post.metaDescription}` : '',
        excerpt ? `The post itself:\n${excerpt}` : (caption ? `What was posted: ${caption}` : ''),
        post?.canonicalUrl
            ? 'The link is added for you at the end — write the email that makes someone want to click it.'
            : '',
    ].filter(Boolean).join('\n\n');

    // A placeholder row first, so the unique index decides whether this post has been drafted
    // before — a SELECT-then-INSERT would let two overlapping publishes both pass the check.
    // A bare onConflictDoNothing() covers the partial index without having to restate its predicate.
    const [issue] = await db.insert(newsletterIssues).values({
        organisationId: args.organisationId,
        userId: args.userId,
        assistantId: args.assistantId,
        subject: title.slice(0, 120),
        isAutonomous: true,
        generationReason: BLOG_HANDOFF_REASON,
        sourceBlogPostId: post?.id ?? null,
        status: 'draft',
    }).onConflictDoNothing().returning({ id: newsletterIssues.id });

    if (!issue) return { issueId: null, reason: 'already_drafted' };

    try {
        await generateIssueBody(db, {
            issueId: issue.id,
            organisationId: args.organisationId,
            userId: args.userId,
            topic: title,
            notes,
            sourceLink: post?.canonicalUrl ? { url: post.canonicalUrl, title: post.title } : null,
        });
    } catch (err) {
        // Delete rather than leave a blank issue in the queue. It also frees the unique key, so the
        // next republish gets another go instead of being refused by a row nobody asked for.
        console.error('[newsletter-from-post] draft failed, removing the placeholder', { issueId: issue.id }, err);
        await db.delete(newsletterIssues).where(and(
            eq(newsletterIssues.id, issue.id),
            eq(newsletterIssues.organisationId, args.organisationId),
        ));
        return { issueId: null, reason: 'generation_failed' };
    }

    // Waiting for a person, explicitly — not a bare 'draft', which reads as something the user
    // started themselves and abandoned.
    await db.update(newsletterIssues)
        .set({ status: 'pending_approval', updatedAt: new Date() })
        .where(eq(newsletterIssues.id, issue.id));

    return { issueId: issue.id };
}
