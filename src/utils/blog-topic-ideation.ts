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
import { blogPosts, organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { buildInspoBlock } from './inspo-profile';

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
}

/**
 * Strip the model's most common wrapper habits off a JSON reply: ```json fences, and any prose
 * either side of the object. Returns null when nothing object-shaped survives.
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

const str = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * Propose the next blog topic for an assistant.
 *
 * Returns null rather than throwing when ideation can't produce something usable — no business
 * context to ground on, an unparseable reply, or an API failure. The caller treats null as "skip
 * this slot and try again next tick", which is the right outcome: a bad unattended topic costs the
 * user a review-queue rejection, whereas a skipped slot costs nothing and self-heals.
 */
export async function ideateBlogTopic(
    db: Db,
    opts: IdeateBlogTopicOptions,
): Promise<BlogTopicIdea | null> {
    const { assistantId, organisationId, userId } = opts;

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
    const hasOrgContext = !!(org?.businessDescription || org?.targetAudience);

    const inspoBlock = await buildInspoBlock(db, { assistantId, organisationId });
    if (!hasOrgContext && !inspoBlock) return null;

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
        recent.length
            ? `Already written (choose something genuinely different):\n${recent.map(r => `- ${r.title}`).join('\n')}`
            : 'Nothing has been published yet — a strong foundational post is a good choice.',
    ].filter(Boolean).join('\n\n');

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 400,
            system:
                'You plan a blog content calendar. Propose ONE blog post that would genuinely help ' +
                'this business\'s audience — specific and useful, never generic filler, and not a ' +
                'rehash of anything in the already-written list. ' +
                'Reply with ONLY a JSON object: ' +
                '{"title": string, "topic": string, "keywords": string}. ' +
                '"title" is a compelling H1 under 70 characters. "topic" is one sentence on the angle ' +
                'to take. "keywords" is 2-4 comma-separated search terms.' +
                (inspoBlock ? `\n\n${inspoBlock}` : ''),
            messages: [{ role: 'user', content: brief }],
        });

        void logAiUsage({
            userId, workspaceId: organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });

        const parsed = parseJsonObject((response.content[0] as { text?: string })?.text ?? '');
        if (!parsed) return null;

        const title = str(parsed.title, 200);
        if (!title) return null; // the title becomes blog_posts.title, which is NOT NULL

        return { title, topic: str(parsed.topic, 300), keywords: str(parsed.keywords, 300) };
    } catch (err) {
        console.error(`ideateBlogTopic: assistant ${assistantId} failed`, err);
        return null;
    }
}
