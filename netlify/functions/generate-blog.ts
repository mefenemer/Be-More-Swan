// netlify/functions/generate-blog.ts
// Autonomous Content Engine — US 1.1: draft a full blog post in the assistant's voice.
//
// Tone is sourced from the authoring assistant's profile (onboardingContext.tone_of_voice — the
// same field social-auto-responder reads); when the post has no assistant, the author-supplied
// `tone` is used, falling back to a sensible default. The generated Markdown is saved to
// blog_posts.bodyMarkdown. Org-scoped, credit-metered.
//
// POST { blogPostId, topic?, keywords?, notes?, tone? }  →  { bodyMarkdown, tone }

import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts, organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';

const MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TONE = 'friendly and professional';

function str(v: unknown, max: number): string {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const id = Number(body.blogPostId);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };

    const topic = str(body.topic, 300);
    const keywords = str(body.keywords, 300);
    const notes = str(body.notes, 4000);

    const [post] = await db
        .select({ id: blogPosts.id, title: blogPosts.title, assistantId: blogPosts.assistantId })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    // Voice: the assistant's profile is the source of truth; the author-supplied tone is the fallback.
    let tone = str(body.tone, 200);
    let assistantPrompt = '';
    if (post.assistantId) {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, systemPrompt: aiAssistants.systemPrompt })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, post.assistantId), eq(aiAssistants.organisationId, ctx.organisationId)))
            .limit(1);
        const actx = (assistant?.onboardingContext as Record<string, unknown> | null) ?? {};
        if (typeof actx.tone_of_voice === 'string' && actx.tone_of_voice.trim()) tone = actx.tone_of_voice.trim();
        if (assistant?.systemPrompt) assistantPrompt = assistant.systemPrompt.slice(0, 2000);
    }
    if (!tone) tone = DEFAULT_TONE;

    // Business grounding (cheap, materially improves relevance).
    const [org] = await db
        .select({ name: organisations.name, businessDescription: organisations.businessDescription, targetAudience: organisations.targetAudience })
        .from(organisations)
        .where(eq(organisations.id, ctx.organisationId))
        .limit(1);

    const brief = [
        `Title: ${post.title}`,
        topic ? `Topic: ${topic}` : '',
        keywords ? `Target keywords: ${keywords}` : '',
        org?.targetAudience ? `Audience: ${org.targetAudience}` : '',
        org?.businessDescription ? `Business context: ${org.businessDescription}` : '',
        notes ? `Author notes / source material:\n${notes}` : '',
    ].filter(Boolean).join('\n');

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 2500,
            system:
                `You are a blog writer${org?.name ? ` for ${org.name}` : ''}. Write in a ${tone} tone. ` +
                (assistantPrompt ? `Voice guidance: ${assistantPrompt}\n` : '') +
                'Produce a complete, publish-ready blog post in Markdown: a single H1 title, a short ' +
                'hook intro, 3–6 H2 sections with substantive paragraphs, and a brief conclusion. Weave ' +
                'the target keywords in naturally — never keyword-stuff. Return ONLY the Markdown, no preamble.',
            messages: [{ role: 'user', content: brief }],
        });

        const bodyMarkdown = (response.content[0] as { text?: string })?.text?.trim() ?? '';
        if (!bodyMarkdown) throw new Error('Empty draft.');

        void logAiUsage({
            userId: ctx.userId, workspaceId: ctx.organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });

        await db.update(blogPosts)
            .set({ bodyMarkdown, updatedAt: new Date() })
            .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)));

        return { statusCode: 200, body: JSON.stringify({ bodyMarkdown, tone }) };
    } catch (error) {
        console.error('[generate-blog] error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate the draft. Please try again.' }) };
    }
});
