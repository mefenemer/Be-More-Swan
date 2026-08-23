// netlify/functions/rewrite-section.ts
// Autonomous Content Engine — US 1.2 AC2/AC3: rewrite ONLY a highlighted section of a blog draft.
//
// One-shot, buffered Anthropic call (Netlify buffers responses — no streaming; the editor shows a
// skeleton, matching chat-session.js). Returns just the replacement fragment for the selected text;
// the client splices it into the block and re-renders (docs/content-engine-epic-plan.md §10).
//
// POST { blogPostId, action:'expand'|'condense'|'tone'|'custom', tone?, instruction?,
//        selectedText, blockContext?, docContext? }  →  { rewrittenText }

import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';
import { stripCodeFences } from '../../src/utils/model-json';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_SELECTION_CHARS = 6000;

type Action = 'expand' | 'condense' | 'tone' | 'custom';
const VALID_ACTIONS: Action[] = ['expand', 'condense', 'tone', 'custom'];

function buildInstruction(action: Action, tone?: string, instruction?: string): string {
    switch (action) {
        case 'expand':
            return 'Expand the selected text with more detail, examples, or supporting points, while keeping the same voice.';
        case 'condense':
            return 'Condense the selected text to be tighter and more concise without losing key meaning.';
        case 'tone':
            return `Rewrite the selected text in a ${tone || 'professional'} tone.`;
        case 'custom':
            return `Rewrite the selected text according to this instruction: ${instruction || 'improve it'}.`;
    }
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
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }

    const { blogPostId, action, tone, instruction, selectedText, blockContext, docContext } = body;

    if (!VALID_ACTIONS.includes(action)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action.' }) };
    }
    if (typeof selectedText !== 'string' || selectedText.trim().length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'selectedText is required.' }) };
    }
    if (selectedText.length > MAX_SELECTION_CHARS) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Selection too large to rewrite.' }) };
    }

    // Tenant guard: the post must belong to the caller's active organisation.
    const [post] = await db
        .select({ id: blogPosts.id, title: blogPosts.title })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, Number(blogPostId)), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    const directive = buildInstruction(action, tone, instruction);

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1500,
            system:
                'You revise a single highlighted passage inside a larger Markdown blog post. ' +
                'Return ONLY the replacement for the selected passage — no preamble, no explanation, ' +
                'no surrounding quotes, and no code fences. Preserve valid Markdown syntax. ' +
                'Do not restate the rest of the document.',
            messages: [{
                role: 'user',
                content:
                    `Post title: ${post.title || docContext?.title || 'Untitled'}\n` +
                    (docContext?.headings ? `Nearby headings: ${docContext.headings}\n` : '') +
                    (blockContext ? `Surrounding block (for context, do NOT return it):\n"""${String(blockContext).slice(0, 3000)}"""\n` : '') +
                    `\nTask: ${directive}\n\nSelected passage to rewrite:\n"""${selectedText}"""`,
            }],
        });

        let rewrittenText = (response.content[0] as { text?: string })?.text?.trim() ?? '';
        // Strip an accidental wrapping code fence if the model added one.
        rewrittenText = stripCodeFences(rewrittenText);
        if (!rewrittenText) throw new Error('Empty rewrite result.');

        void logAiUsage({
            userId: ctx.userId,
            workspaceId: ctx.organisationId,
            model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
        });

        return { statusCode: 200, body: JSON.stringify({ rewrittenText }) };
    } catch (error) {
        console.error('[rewrite-section] error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'The rewrite could not be completed. Please try again.' }) };
    }
});
