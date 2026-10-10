// src/utils/blog-topic-ideation.ts
// Blog Autopilot topic ideation — decide what an unattended blog draft should be ABOUT.
//
// Why this exists at all: the social autopilot never needed it. Social drafts inherit their subject
// from the assistant's compiled blueprint sections (process-content-jobs.ts), but blog never touches
// the blueprint — generate-blog has always required a caller-supplied topic and an already-created
// post row, because until now every blog draft started from a human clicking "Write Blog Post".
// Drafting on a cadence means something has to choose the subject, so this does.
//
// Grounding, in order of influence: the org's own business description and audience, the assistant's
// Inspo profile (the styles/ideas the user actually parked), and the titles of recent posts — the
// last purely as a NEGATIVE constraint, so a weekly cadence doesn't rewrite the same article
// fifty-two times a year.

import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, blogPosts, organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { buildInspoBlock } from './inspo-profile';
import { pickInspoTopic } from './inspo-topics';
import { buildBlueprintGuardrailsBlock } from './blog-generate';
import { currentDatePromptBlock } from './current-date-prompt';
import { parseModelJson } from './model-json';
import { loadProductsBlock } from './org-products';

type Db = ReturnType<typeof getDb>;

const MODEL = 'claude-haiku-4-5-20251001';

/** How many recent titles to show the model as "don't repeat these". Bounded so a large library
 *  doesn't grow the prompt without limit — recency is what matters for avoiding near-duplicates. */
const RECENT_TITLE_LIMIT = 25;

export interface BlogTopicIdea {
    /** The H1 the draft will be written under. */
    title: string;
    /** One-line angle, passed to generateBlogBody as `topic` to steer the body. */
    topic: string;
    /** Comma-separated target keywords, or '' when the model offered none. */
    keywords: string;
}

export interface IdeateBlogTopicOptions {
    assistantId: number;
    organisationId: number;
    /** Whose AI usage this run is billed to — the assistant's owner. */
    userId: number;
    /** The slot being filled. Decides whether this draft is built around an Inspo item
     *  (src/utils/inspo-topics.ts); omitted = never. */
    slot?: Date | string | null;
    /** Direction carried by the job (context_prompt): a reviewer's reason for rejecting the last
     *  draft for this slot, or a campaign order's brief. Outranks an Inspo topic. */
    guidance?: string | null;
}


const str = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * Propose the next blog topic for an assistant.
 *
 * Returns null when ideation genuinely cannot produce something usable: no business context to
 * ground on, or a reply we cannot read. The caller treats null as "skip this slot and try again next
 * tick", which is right — a bad unattended topic costs the user a review-queue rejection, a skipped
 * slot costs nothing and self-heals.
 *
 * ⚠️ AN API FAILURE THROWS. It used to be swallowed into the same null, and that told three customers
 * something untrue. Between 2026-09-19 and 09-28 the Anthropic balance was exhausted, every call here
 * failed, and all 36 of them were reported as "Could not ground a topic for this slot." — a sentence
 * that names the one cause the reader can act on, and blames their business profile for our unpaid
 * bill. All three organisations had a business description AND a target audience; the topic was
 * perfectly groundable every time.
 *
 * Four causes collapsed into one message is not a small inaccuracy. "We could not think of anything
 * to write about you" and "our account stopped working" call for opposite responses from the person
 * reading it, so they must not be the same return value.
 */
export async function ideateBlogTopic(
    db: Db,
    opts: IdeateBlogTopicOptions,
): Promise<BlogTopicIdea | null> {
    const { assistantId, organisationId, userId, slot } = opts;
    const guidance = (opts.guidance || '').trim().slice(0, 1000);

    const [org] = await db
        .select({
            name: organisations.name,
            businessDescription: organisations.businessDescription,
            targetAudience: organisations.targetAudience,
        })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

    // Without any business grounding the model can only produce generic filler, which is worse than
    // nothing when nobody is watching. Inspo alone is enough to proceed — it's user-authored signal.
    // Products count as grounding: a business that listed what it sells has told us what to write about.
    const productsBlock = await loadProductsBlock(db, organisationId, org?.name ?? null);
    const hasOrgContext = !!(org?.businessDescription || org?.targetAudience || productsBlock);

    // Inspo as a SUBJECT on a share of slots — see inspo-topics.ts. The style block below is
    // unchanged; this is the part of the library that says what to write ABOUT.
    const [asst] = await db
        .select({ configuration: aiAssistants.configuration, onboardingContext: aiAssistants.onboardingContext })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, assistantId))
        .limit(1);
    // "Topics & themes" from the Blog Writer's own setup (assistant-onboarding-schemas.js blogTopics).
    // It was asked at hire and read by NOTHING — the user named their subjects and autopilot ignored
    // them. It is the most direct statement of what this blog is about, so it leads the brief.
    const setupTopics = str((asst?.onboardingContext as Record<string, unknown> | null)?.blogTopics, 500);
    // A job that carries its own direction (a rejection's reason, a campaign brief) is ABOUT that;
    // an Inspo topic would compete with it, so it only applies to an undirected slot.
    const inspoTopic = guidance ? null : await pickInspoTopic(db, {
        assistantId, organisationId, slot, configuration: asst?.configuration ?? null, artifact: 'blog post',
    });
    if (inspoTopic) console.log(`ideateBlogTopic: assistant ${assistantId} slot built around inspo item ${inspoTopic.itemId}`);

    const inspoBlock = await buildInspoBlock(db, { assistantId, organisationId, topic: inspoTopic?.retrievalQuery ?? null });
    if (!hasOrgContext && !inspoBlock && !setupTopics) return null;

    // Recent titles across the whole org, not just this assistant: a duplicate is a duplicate to the
    // reader regardless of which assistant (or human) wrote the earlier one.
    const recent = await db
        .select({ title: blogPosts.title })
        .from(blogPosts)
        .where(eq(blogPosts.organisationId, organisationId))
        .orderBy(desc(blogPosts.createdAt))
        .limit(RECENT_TITLE_LIMIT);

    const brief = [
        org?.name ? `Business: ${org.name}` : '',
        org?.businessDescription ? `What they do: ${org.businessDescription}` : '',
        org?.targetAudience ? `Audience: ${org.targetAudience}` : '',
        setupTopics ? `Topics they want this blog to cover (pick one of these, or something squarely within them): ${setupTopics}` : '',
        productsBlock ?? '',
        recent.length
            ? `Already written (choose something genuinely different):\n${recent.map(r => `- ${r.title}`).join('\n')}`
            : 'Nothing has been published yet — a strong foundational post is a good choice.',
        inspoTopic?.brief ?? '',
        guidance ? `Direction for THIS post — follow it: ${guidance}` : '',
    ].filter(Boolean).join('\n\n');

    // The workspace's content rules — including every reason a reviewer gave for rejecting a draft —
    // and its business facts. Ideation picks the SUBJECT, so a rule like "stop writing about pricing"
    // has to reach it here: blog-generate applies the same block to the body, but by then the topic
    // is already chosen. Never throws (returns null on failure).
    const guardrailsBlock = await buildBlueprintGuardrailsBlock(db, {
        assistantId, organisationId, compiledBy: String(userId),
    });

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 400,
            system:
                // Ideation picks the TITLE, so a stale year here is baked in before a word of the
                // body is written — and the body generator, handed "The 2025 Guide To…", will
                // reasonably keep it. Fixing blog-generate alone would not have caught this.
                `${currentDatePromptBlock()}\n\n` +
                'You plan a blog content calendar. Propose ONE blog post that would genuinely help ' +
                'this business\'s audience — specific and useful, never generic filler, and not a ' +
                'rehash of anything in the already-written list. ' +
                'Reply with ONLY a JSON object: ' +
                '{"title": string, "topic": string, "keywords": string}. ' +
                '"title" is a compelling H1 under 70 characters. "topic" is one sentence on the angle ' +
                'to take. "keywords" is 2-4 comma-separated search terms.' +
                (guardrailsBlock ? `\n\n${guardrailsBlock}` : '') +
                (inspoBlock ? `\n\n${inspoBlock}` : ''),
            messages: [{ role: 'user', content: brief }],
        });

        void logAiUsage({
            userId, workspaceId: organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });

        const parsed = parseModelJson<Record<string, unknown>>((response.content[0] as { text?: string })?.text ?? '');
        if (!parsed) return null;

        const title = str(parsed.title, 200);
        if (!title) return null; // the title becomes blog_posts.title, which is NOT NULL

        return { title, topic: str(parsed.topic, 300), keywords: str(parsed.keywords, 300) };
    } catch (err) {
        // ⚠️ RE-THROWN, not swallowed. The caller can tell an outage from an ungroundable assistant
        // only if the two arrive differently — and only the caller can decide whether to park the
        // job, retry it, or tell the user their profile is thin.
        console.error(`ideateBlogTopic: assistant ${assistantId} failed`, err);
        throw err;
    }
}
