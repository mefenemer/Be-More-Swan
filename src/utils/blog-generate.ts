// src/utils/blog-generate.ts
// Shared blog drafting core (Autonomous Content Engine US 1.1), used by BOTH the interactive
// generate-blog handler and the Blog Autopilot worker (process-blog-jobs.ts).
//
// Extracted from netlify/functions/generate-blog.ts, which was session-coupled: it resolved the
// org through requireTenant(event), so a cron — which has no request and no session — could not
// reach the drafting logic at all. This mirrors what src/utils/blog-publish.ts already does for
// the publish transition, and for the same reason.
//
// The caller is responsible for authorisation: it passes the organisationId it has already
// established, and every query here is scoped by it.

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, aiBlueprints, blogPostAssets, blogPosts, organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { buildInspoBlock } from './inspo-profile';
import { currentDatePromptBlock } from './current-date-prompt';
import { resolvePostingSchedule } from '../config/posting-cadence';
import { assembleBlueprint } from './blueprint';
import { ASSISTANT_DRAFT_REASON } from './blog-ai-assisted';
import { parseModelJson } from './model-json';
import {
    groundLinks, irToBlogMarkdown, layoutIrPromptBlock, mediaIntents, normaliseLayoutIr,
} from './layout-ir';
import { sourceBlogImages, MAX_SOURCED_IMAGES } from './blog-media-source';

type Db = ReturnType<typeof getDb>;

/** Cap on the content-rules list so a workspace with hundreds of learned directives can't
 *  crowd out the brief. §11's own text is already capped by the compiler (8k total / 4k per doc). */
const MAX_RULES = 40;

/**
 * Pull the two blueprint sections that must govern a long-form draft:
 *   §4 Content Rules      — the workspace's guardrails and learned directives
 *   §11 Business Knowledge — the owner-supplied docs the compiler marks AUTHORITATIVE
 *
 * Blog generation historically never read the blueprint at all, so neither of these reached a
 * draft: a user could upload brand guidelines, see them labelled as overriding any conflicting
 * instruction, and have long-form quietly ignore them.
 *
 * Deliberately NOT full parity with the social path (process-content-jobs dumps every section
 * wholesale, and generate-post hard-fails on blocking gaps). Blog has always drafted without a
 * blueprint, so failing closed here would break existing users over gaps like a missing DPA.
 * This adds context only and returns null on any problem — a draft never fails because of it.
 */
export async function buildBlueprintGuardrailsBlock(
    db: Db,
    opts: { assistantId: number; organisationId: number; compiledBy: string },
): Promise<string | null> {
    try {
        let [bp] = await db
            .select({ sections: aiBlueprints.sections })
            .from(aiBlueprints)
            .where(and(
                eq(aiBlueprints.assistantId, opts.assistantId),
                eq(aiBlueprints.organisationId, opts.organisationId),
            ))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(1);

        // Nothing compiles a blueprint for a Blog Writer today (generate-post and
        // schedule-gap-fill are both social), so on the first draft there won't be one.
        // Compile it now, exactly as generate-post does for a self-serve social assistant.
        if (!bp) {
            const result = await assembleBlueprint(opts.assistantId, opts.compiledBy, 'auto-on-demand');
            bp = { sections: result.sections as unknown as Record<string, unknown> };
        }

        const sections = (bp.sections ?? {}) as Record<string, { content?: Record<string, unknown> }>;
        const parts: string[] = [];

        const rules = (sections['4-content-rules']?.content?.rules ?? []) as Array<{ text?: string; platform?: string }>;
        if (rules.length) {
            const lines = rules
                .slice(0, MAX_RULES)
                .map(r => (typeof r?.text === 'string' ? r.text.trim() : ''))
                .filter(Boolean)
                .map(t => `- ${t}`);
            if (lines.length) {
                parts.push(
                    'CONTENT RULES — these are the workspace\'s standing rules and directives learned ' +
                    'from past feedback. Follow every one of them:\n' + lines.join('\n'),
                );
            }
        }

        const knowledge = sections['11-business-knowledge']?.content ?? {};
        const directive = typeof knowledge.directive === 'string' ? knowledge.directive : null;
        const documents = (knowledge.documents ?? []) as Array<{ name?: string; text?: string }>;
        const links = (knowledge.links ?? []) as Array<{ name?: string; url?: string }>;
        if (directive && (documents.length || links.length)) {
            const docBlocks = documents
                .filter(d => typeof d?.text === 'string' && d.text.trim())
                .map(d => `[${d.name ?? 'Document'}]\n${d.text!.trim()}`);
            const linkLines = links
                .filter(l => l?.url)
                .map(l => `- ${l.name ?? l.url}: ${l.url}`);
            parts.push(
                `BUSINESS KNOWLEDGE — ${directive}\n\n` +
                [docBlocks.join('\n\n'), linkLines.length ? `Reference links:\n${linkLines.join('\n')}` : '']
                    .filter(Boolean).join('\n\n'),
            );
        }

        // Section 12 — active SMART goals. Duplicated here rather than shared with the social path
        // on purpose: blog drafting assembles its prompt through this function, NOT through
        // renderBlueprintPrompt(), so an injection added there does not reach a Blog Writer. The
        // directive is already-rendered prose from renderGoalDirective(), so it is emitted verbatim.
        const goalDirective = sections['12-goals']?.content?.directive;
        if (typeof goalDirective === 'string' && goalDirective.trim()) {
            parts.push(goalDirective.trim());
        }

        // Section 13 — the live campaign this assistant is working for. Injected here for the same
        // reason section 12 is: this function IS the blog prompt, and anything added to
        // renderBlueprintPrompt() reaches the social drafter only. A campaign that steers posts but
        // not articles is a campaign the Blog Writer is not in, which is not what the user was
        // shown when they approved the strategy.
        //
        // Emitted AFTER the goal directive deliberately. Both are "what this work is for", and the
        // campaign is the narrower, more current statement — later text wins on ties, and a
        // campaign is chosen for a season while a goal runs for a quarter.
        const campaignDirective = sections['13-campaign']?.content?.directive;
        if (typeof campaignDirective === 'string' && campaignDirective.trim()) {
            parts.push(campaignDirective.trim());
        }

        return parts.length ? parts.join('\n\n') : null;
    } catch (err) {
        console.error(`buildBlueprintGuardrailsBlock: assistant ${opts.assistantId} failed`, err);
        return null;
    }
}

export const BLOG_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_TONE = 'friendly and professional';

/** Trim an untrusted string to a bounded length; non-strings become ''. */
export function str(v: unknown, max: number): string {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export interface GenerateBlogBodyOptions {
    blogPostId: number;
    organisationId: number;
    /** Whose AI usage this run is billed to. The post author interactively; the assistant's owner on cron. */
    userId: number;
    topic?: string;
    keywords?: string;
    notes?: string;
    /** Fallback voice, used only when the authoring assistant has no tone_of_voice of its own. */
    tone?: string;
}

export interface GenerateBlogBodyResult {
    bodyMarkdown: string;
    tone: string;
    /**
     * How many stock pictures the run actually placed in the body.
     *
     * Zero is the ordinary answer: the drafter only asks for a picture where one earns its place,
     * a post that already has media is left alone, and a deployment with no PEXELS_API_KEY sources
     * nothing at all. Reported so the Studio can say what happened rather than leaving the author
     * to notice.
     */
    sourcedImages: number;
}

export class BlogPostNotFoundError extends Error {
    constructor(id: number) {
        super(`Blog post ${id} not found in this organisation.`);
        this.name = 'BlogPostNotFoundError';
    }
}

/**
 * Draft a full blog post in the assistant's voice and save it to blog_posts.body_markdown.
 *
 * Throws BlogPostNotFoundError when the post doesn't exist in `organisationId`, and a plain Error
 * when the model returns nothing. Callers translate these into their own failure shape — an HTTP
 * status for the handler, a job retry for the worker.
 */
export async function generateBlogBody(
    db: Db,
    opts: GenerateBlogBodyOptions,
): Promise<GenerateBlogBodyResult> {
    const { blogPostId, organisationId, userId } = opts;
    const topic = str(opts.topic, 300);
    const keywords = str(opts.keywords, 300);
    const notes = str(opts.notes, 4000);

    const [post] = await db
        .select({ id: blogPosts.id, title: blogPosts.title, assistantId: blogPosts.assistantId, publishDate: blogPosts.publishDate })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) throw new BlogPostNotFoundError(blogPostId);

    // Voice: the assistant's profile is the source of truth; the caller-supplied tone is the fallback.
    let tone = str(opts.tone, 200);
    let assistantPrompt = '';
    // The account's own zone, for the date block below. Defaults when there is no authoring
    // assistant — a blog post can be drafted without one.
    let timezone = resolvePostingSchedule(null).timezone;
    if (post.assistantId) {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, systemPrompt: aiAssistants.systemPrompt })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, post.assistantId), eq(aiAssistants.organisationId, organisationId)))
            .limit(1);
        const actx = (assistant?.onboardingContext as Record<string, unknown> | null) ?? {};
        if (typeof actx.tone_of_voice === 'string' && actx.tone_of_voice.trim()) tone = actx.tone_of_voice.trim();
        if (assistant?.systemPrompt) assistantPrompt = assistant.systemPrompt.slice(0, 2000);
        timezone = resolvePostingSchedule(actx).timezone;
    }
    if (!tone) tone = DEFAULT_TONE;

    // Business grounding (cheap, materially improves relevance).
    const [org] = await db
        .select({ name: organisations.name, businessDescription: organisations.businessDescription, targetAudience: organisations.targetAudience })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

    const brief = [
        `Title: ${post.title}`,
        topic ? `Topic: ${topic}` : '',
        keywords ? `Target keywords: ${keywords}` : '',
        org?.targetAudience ? `Audience: ${org.targetAudience}` : '',
        org?.businessDescription ? `Business context: ${org.businessDescription}` : '',
        notes ? `Author notes / source material:\n${notes}` : '',
    ].filter(Boolean).join('\n');

    // Inspo (AC5) — the styles/tones the user parked in the Inspo tab. This is the SECOND
    // injection seam: blog never touches the blueprint, so the social path's injection in
    // process-content-jobs.ts does nothing for these drafts and this has to be done
    // separately. Bounded (capped distilled profile + top-K retrieval) and null when the
    // assistant has no inspo, so a user without any pays nothing. Never throws.
    const inspoBlock = post.assistantId
        ? await buildInspoBlock(db, {
            assistantId: post.assistantId,
            organisationId,
            // Rank retrieval against what this post is actually about.
            topic: [post.title, topic, keywords].filter(Boolean).join(' — '),
        })
        : null;

    // Content Rules + Business Knowledge from the compiled blueprint. Null for a post with no
    // authoring assistant, and null on any failure — never fails the draft.
    const guardrailsBlock = post.assistantId
        ? await buildBlueprintGuardrailsBlock(db, {
            assistantId: post.assistantId,
            organisationId,
            compiledBy: String(userId),
        })
        : null;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: BLOG_MODEL,
        // ⚠️ Raised from 2500 with the layout. A long-form post is the one place structured output
        // is genuinely risky: the same 1,200 words now arrive wrapped in JSON nodes, and a reply
        // that runs out of tokens loses the WHOLE object rather than its tail. The headroom is what
        // keeps the structured path from being a worse deal than the wall of Markdown it replaced —
        // and the raw-Markdown fallback below is what catches it when it happens anyway.
        max_tokens: 6000,
        system:
            // Blog is the most year-exposed surface there is — "the 2025 guide to…" is a title
            // format a blog writer reaches for unprompted, and an H1 with a stale year is visible
            // on the customer's own domain. Leads the prompt, as on the social path.
            `${currentDatePromptBlock({ publishDate: post.publishDate, timezone })}\n\n` +
            `You are a blog writer${org?.name ? ` for ${org.name}` : ''}. Write in a ${tone} tone. ` +
            (assistantPrompt ? `Voice guidance: ${assistantPrompt}\n` : '') +
            'Produce a complete, publish-ready blog post: a single level-1 heading as the title, a ' +
            'short hook intro, 3–6 level-2 sections with substantive paragraphs, and a brief ' +
            'conclusion. Weave the target keywords in naturally — never keyword-stuff.\n' +
            // ⚠️ THE LENGTH TARGET IS LOAD-BEARING, and it was measured rather than guessed. Asking
            // for a layout instead of a wall of Markdown made drafts ~30% SHORTER on the same brief
            // (mean 773 words against 1,101 over two runs each): the model keeps the same number of
            // sections and thins every one of them, spending its budget on structure. Without this
            // line, adding layouts would have quietly downgraded every blog post the product writes.
            'Write 900–1,200 words in total. Each section needs real substance — two or three full ' +
            'paragraphs, examples, specifics — not a sentence under a heading.\n' +
            'Return ONLY a JSON object with one key, "layout", SET OUT as described under LAYOUT ' +
            'below.\n' +
            // ⚠️ The escape hatch, and on this surface it is doing more work than on the newsletter:
            // a blog post is long enough that a model can run out of room mid-object. A reply that
            // is plain Markdown is used as the draft exactly as it was before layouts existed.
            'If you cannot produce a layout, return the post as plain Markdown instead, with no ' +
            'JSON and no preamble.' +
            // Order matters: the workspace's binding rules and authoritative business facts are
            // established FIRST, so the Inspo styling that follows can shape the voice but never
            // override them. Mirrors the social path, where inspo sits after the blueprint.
            `\n\n${layoutIrPromptBlock({ images: 'encouraged' })}` +
            (guardrailsBlock ? `\n\n${guardrailsBlock}` : '') +
            (inspoBlock ? `\n\n${inspoBlock}` : ''),
        messages: [{ role: 'user', content: brief }],
    });

    const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
    if (!raw) throw new Error('Empty draft.');

    void logAiUsage({
        userId, workspaceId: organisationId, model: BLOG_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    // ── Layout, pictures, prose ─────────────────────────────────────────────────────────────────
    //
    // Three outcomes, in order of how much the reader gets:
    //   1. a valid layout → pictures are sourced for the ones it asked for, and the body is
    //      compiled with `:::media` directives placed where the drafter wanted them;
    //   2. no usable layout but plain Markdown → the draft it has always produced, unchanged;
    //   3. neither → an error, and specifically NOT a post whose body is JSON scaffolding.
    const parsed = parseModelJson<{ layout?: unknown }>(raw);
    const layout = normaliseLayoutIr(parsed?.layout);

    let bodyMarkdown: string;
    let sourcedImages = 0;

    if (layout) {
        // The brief is the only place a real URL can have come from — same anti-fabrication rule
        // the prompt applies to statistics, and it matters more here than in an inbox: an invented
        // link on a blog post is a 404 published on the customer's own domain.
        const grounded = groundLinks(layout, brief);

        // ⚠️ Only source pictures for a post that has none. A redraft must not pile a second set of
        // stock photographs onto a post somebody has already given media — and on the autopilot
        // path a retried job would otherwise attach three more on every attempt.
        const wanted = mediaIntents(grounded.ir).slice(0, MAX_SOURCED_IMAGES);
        let assetIds: (number | null)[] = [];
        if (wanted.length) {
            const [existingMedia] = await db
                .select({ id: blogPostAssets.contentAssetId })
                .from(blogPostAssets)
                .where(eq(blogPostAssets.blogPostId, blogPostId))
                .limit(1);
            if (!existingMedia) {
                assetIds = await sourceBlogImages(db, {
                    blogPostId,
                    organisationId,
                    userId,
                    // The words the drafter itself wrote for the search, so no model call is spent
                    // re-deriving them. Falls back to the alt text when it left `query` empty.
                    queries: wanted.map((m) => m.query || m.alt),
                });
                sourcedImages = assetIds.filter(Boolean).length;
            }
        }

        // ⚠️ An unresolved picture is DROPPED from the body, not faked: the directive names a real
        // blog_post_assets row and there is no placeholder form. The description is not lost — the
        // asset is attached to the post either way, so the Studio's media panel shows what the
        // drafter found.
        bodyMarkdown = irToBlogMarkdown(grounded.ir, { assetFor: (_image, i) => assetIds[i] ?? null });
    } else if (parsed) {
        // It parsed as JSON and there was no layout in it. Whatever is in `raw` is an object, and
        // persisting it would put `{"layout":[{"kind":…` on a customer's blog — the exact failure
        // src/utils/model-json.ts exists to prevent. Fail the run instead; the caller retries.
        throw new Error('The draft came back in a form we could not read. Try again.');
    } else {
        // Plain Markdown: the model ignored the schema and wrote the post. Exactly the behaviour
        // this path had before layouts existed.
        bodyMarkdown = raw;
    }

    if (!bodyMarkdown.trim()) throw new Error('Empty draft.');

    // Stamp the body AND the provenance marker in one write, so a machine-drafted post can never
    // exist without the flag the AI transparency badge reads (src/utils/blog-ai-assisted.ts).
    // COALESCE, not a plain set: the autopilot worker inserts 'autopilot_schedule' and then calls
    // this function, so overwriting would erase the more specific reason. First writer wins.
    await db.update(blogPosts)
        .set({
            bodyMarkdown,
            generationReason: sql`COALESCE(${blogPosts.generationReason}, ${ASSISTANT_DRAFT_REASON})`,
            updatedAt: new Date(),
        })
        .where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, organisationId)));

    return { bodyMarkdown, tone, sourcedImages };
}
