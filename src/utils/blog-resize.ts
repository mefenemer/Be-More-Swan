// src/utils/blog-resize.ts
// "Make it shorter" / "Make it longer" for a blog article — the long-form twin of the social post
// editor's buttons (rewrite-post-text.ts, actions 'shorter' / 'longer').
//
// Reached two ways, through ONE queue path (generate-blog.ts → process-blog-jobs.ts):
//   • Blog Studio's two buttons;
//   • the Blog Writer chat's confirm card (blog_action_proposal 'shorter' / 'longer' / 'revise').
//
// "Revise" is the same rewrite steered by the owner's own instruction ("improve it", "bring it up to
// date with what we know now"). It exists because the chat used to do this in its reply: a whole
// article written inside a 26-second chat turn timed out (HTTP 504), and Blog Studio's "Ask … to
// improve" pasted the whole article into the chat, past its 4,000-character message limit.
// It runs in the background worker for the same reason drafting does: a whole article rewritten is
// a long model call, far past a synchronous function's 10-second ceiling.
//
// What it guards:
//   • PICTURES. A `:::media{…}` line names a real blog_post_assets row; the model never sees one.
//     Each is swapped for a numbered placeholder line and put back afterwards — and any placeholder
//     the model dropped is re-attached at the end, so a rewrite can never lose a picture.
//   • LINKS. Only links already in the article survive (groundMarkdownLinks against the original),
//     so "longer" cannot add a destination the owner never supplied.
//   • FACTS. "Longer" may only develop what the article already says — the same rule as the social
//     buttons — with the owner's Business Knowledge and the assistant's voice in the prompt.
//
// ⚠️ Writes ONLY bodyMarkdown. Title, SEO, status and schedule are untouched.

import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, blogPosts, organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { currentDatePromptBlock } from './current-date-prompt';
import { voiceDirective } from './voice-profile';
import { resolvePostingSchedule } from '../config/posting-cadence';
import { groundMarkdownLinks } from './layout-ir';
import { stripCodeFences } from './model-json';
import { BLOG_MODEL, DEFAULT_TONE, buildBlueprintGuardrailsBlock } from './blog-generate';

type Db = ReturnType<typeof getDb>;

export const BLOG_RESIZE_DIRECTIONS = ['shorter', 'longer'] as const;
export type BlogResizeDirection = typeof BLOG_RESIZE_DIRECTIONS[number];

const MEDIA_LINE = /^:::media\{[^}\n]*\}[ \t]*$/gm;
const placeholder = (i: number) => `[[PICTURE ${i + 1}]]`;

/** Words in a Markdown body, as Blog Studio counts them. */
export function wordCount(md: string): number {
    return String(md || '').replace(/[#*_`>\-[\]()!]/g, ' ').split(/\s+/).filter(Boolean).length;
}

/** Swap every picture line for a numbered placeholder. Pure. */
export function protectMedia(body: string): { text: string; media: string[] } {
    const media: string[] = [];
    const text = body.replace(MEDIA_LINE, (m) => { media.push(m.trim()); return placeholder(media.length - 1); });
    return { text, media };
}

/** Put the pictures back; any the model dropped go at the end, in order. Pure. */
export function restoreMedia(text: string, media: string[]): string {
    let out = text;
    const missing: string[] = [];
    media.forEach((m, i) => {
        const p = placeholder(i);
        if (out.includes(p)) out = out.split(p).join(m);
        else missing.push(m);
    });
    // A placeholder the model invented beyond the real ones is removed, never published.
    out = out.replace(/\[\[PICTURE \d+\]\]/g, '');
    if (missing.length) out = `${out.trimEnd()}\n\n${missing.join('\n\n')}\n`;
    return out;
}

export function resizeDirective(direction: BlogResizeDirection, words: number): string {
    return direction === 'shorter'
        ? `Rewrite the article noticeably SHORTER — about two thirds of its current ${words} words. Keep the title (the single level-1 heading), `
            + 'the core argument, the structure that still fits, the tone and any call to action. Cut repetition, filler and the weakest '
            + 'examples first. Add nothing new.'
        : `Rewrite the article noticeably LONGER — about half as long again as its current ${words} words. Keep the title (the single `
            + 'level-1 heading), the message, the tone and the structure. Develop what the article already says: a fuller explanation, '
            + 'an example of a point it already makes, the reasoning behind it, a clearer close. Do NOT invent facts, figures, names, '
            + 'prices, quotes, customers, offers or claims that are not in the article or the business knowledge.';
}

/** The owner's instruction as a rewrite task. New facts may come only from the Business Knowledge. */
export function reviseDirective(instruction: string, words: number): string {
    return `Revise the article as the owner asks: "${instruction.replace(/"/g, "'")}". It is currently ${words} words; keep it about `
        + 'that length unless they asked otherwise. Keep the title (the single level-1 heading) unless they asked to change it, and keep '
        + 'the tone and any call to action. Where the business knowledge above is newer or more complete than the article, bring the '
        + 'article in line with it. Do NOT invent facts, figures, names, prices, quotes, customers, offers or claims that are not in the '
        + 'article or the business knowledge — if the owner asks for something only they could know, leave that part as it is.';
}

/**
 * Rewrite the post's body shorter, longer or to an instruction, and save it. Returns the new and old word counts.
 * Throws on an empty article, a missing post or an unusable reply — the worker turns that into the
 * job's error, which Blog Studio shows.
 */
export async function resizeBlogBody(
    db: Db,
    opts: { blogPostId: number; organisationId: number; userId: number; direction?: BlogResizeDirection; instruction?: string },
): Promise<{ before: number; after: number }> {
    const instruction = opts.instruction?.trim();
    if (!opts.direction && !instruction) throw new Error('Nothing to rewrite to — say what should change.');
    const [post] = await db
        .select({ id: blogPosts.id, body: blogPosts.bodyMarkdown, assistantId: blogPosts.assistantId, publishDate: blogPosts.publishDate })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, opts.blogPostId), eq(blogPosts.organisationId, opts.organisationId)))
        .limit(1);
    if (!post) throw new Error('Blog post not found.');
    const original = String(post.body ?? '');
    const before = wordCount(original);
    if (before < 20) throw new Error('There is not enough here to rewrite yet — write or draft the article first.');

    let tone = DEFAULT_TONE;
    let voice: unknown;
    let timezone = resolvePostingSchedule(null).timezone;
    if (post.assistantId) {
        const [a] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, post.assistantId), eq(aiAssistants.organisationId, opts.organisationId))).limit(1);
        const ctx = (a?.ctx as Record<string, unknown> | null) ?? {};
        if (typeof ctx.tone_of_voice === 'string' && ctx.tone_of_voice.trim()) tone = ctx.tone_of_voice.trim();
        voice = ctx.voice;
        timezone = resolvePostingSchedule(ctx).timezone;
    }
    const [org] = await db.select({ name: organisations.name }).from(organisations)
        .where(eq(organisations.id, opts.organisationId)).limit(1);
    // Rules and Business Knowledge, as when it was drafted — "longer" must stay inside them.
    const guardrails = post.assistantId
        ? await buildBlueprintGuardrailsBlock(db, { assistantId: post.assistantId, organisationId: opts.organisationId, compiledBy: String(opts.userId) })
        : null;

    const { text, media } = protectMedia(original);
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: BLOG_MODEL,
        max_tokens: 6000,
        system:
            `${currentDatePromptBlock({ publishDate: post.publishDate, timezone })}\n\n`
            + `You revise ONE blog article${org?.name ? ` for ${org.name}` : ''}.\n`
            + `${voiceDirective(tone, { surface: 'blog', fallback: DEFAULT_TONE, voice })}\n`
            + 'Return ONLY the full revised article in Markdown — no preamble, no explanation, no code fences. '
            + 'Keep every line of the form [[PICTURE n]] exactly as written, on its own line, near the text it illustrates. '
            + 'Keep links only as they already appear; add no new ones. Match the language of the original.'
            + (guardrails ? `\n\n${guardrails}` : ''),
        messages: [{ role: 'user', content: `Article:\n"""\n${text}\n"""\n\nTask: ${instruction ? reviseDirective(instruction, before) : resizeDirective(opts.direction as BlogResizeDirection, before)}` }],
    });

    const raw = stripCodeFences(((response.content[0] as { text?: string })?.text ?? '').trim()).trim();
    void logAiUsage({
        userId: opts.userId, workspaceId: opts.organisationId, model: BLOG_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });
    if (!raw) throw new Error('The rewrite came back empty. Try again.');
    // A reply cut off at the token limit ends mid-sentence; saving it would lose the article's end.
    if (response.stop_reason === 'max_tokens') throw new Error('The rewrite ran out of room before it finished. Your article is unchanged.');

    const grounded = groundMarkdownLinks(raw, original).markdown;
    const body = restoreMedia(grounded, media);
    const after = wordCount(body);
    if (after < 20) throw new Error('The rewrite came back too short to use. Your article is unchanged.');

    await db.update(blogPosts)
        .set({ bodyMarkdown: body, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, opts.blogPostId), eq(blogPosts.organisationId, opts.organisationId)));
    return { before, after };
}
