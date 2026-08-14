// netlify/functions/rewrite-post-text.ts
// Targeted rewrites of a post's OWN words — tone, hashtags, grammar — returned to the caller.
//
// The quick actions in step 1 used to go through request-post-changes, which is a different
// operation wearing the same clothes: it CANCELS the draft (status 'cancelled') and queues a job
// that generates a replacement post with a new id. So "suggest hashtags" threw the post away,
// redrafted the whole thing from the blueprint, and dropped the user back in the Review Queue to
// wait — which is exactly what it looked like from the outside.
//
// This edits nothing and creates nothing. It returns the rewritten text and the browser puts it in
// the field the user is looking at, so the post they were editing is still the post they are
// editing. request-post-changes remains the right endpoint for the free-text "Regenerate" box,
// where redrafting from scratch IS the request.
//
// POST { postId, action:'tone'|'hashtags'|'grammar', tone? } → { caption? , hashtags? }

import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import { displayCaption } from '../../src/utils/model-json';
import { buildInspoBlock } from '../../src/utils/inspo-profile';
import { currentDatePromptBlock } from '../../src/utils/current-date-prompt';
import { platformFormat } from '../../src/config/platform-formats';
import { withLambda } from '@netlify/aws-lambda-compat';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_CAPTION_CHARS = 5000;

type Action = 'tone' | 'hashtags' | 'grammar';
const VALID: Action[] = ['tone', 'hashtags', 'grammar'];

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Which field each action is allowed to touch. Hashtags must never rewrite the caption behind the user. */
const FIELD: Record<Action, 'caption' | 'hashtags'> = {
    tone: 'caption', grammar: 'caption', hashtags: 'hashtags',
};

function directive(action: Action, tone: string, limit: number): string {
    switch (action) {
        case 'tone':
            return `Rewrite the caption in a ${tone || 'warmer, more conversational'} tone. Keep the same message, `
                + `the same language, and roughly the same length. Stay within ${limit} characters.`;
        case 'grammar':
            return 'Fix grammar, spelling and flow. Do NOT change the meaning, the tone, the language or the length.';
        case 'hashtags':
            return 'Write a better set of hashtags for this post and platform. Return ONLY the hashtags, space separated, '
                + 'each starting with #. No caption, no explanation. Between 3 and 8 of them.';
    }
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (await isGlobalAiDisabled()) {
        return json(503, { error: 'AI services are temporarily unavailable. Please try again later.' });
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { postId?: unknown; action?: unknown; tone?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId is required.' });
    const action = VALID.includes(body.action as Action) ? body.action as Action : null;
    if (!action) return json(400, { error: 'Unknown action.' });
    const tone = typeof body.tone === 'string' ? body.tone.slice(0, 40) : '';

    const [post] = await db
        .select({
            id: scheduledPosts.id,
            caption: scheduledPosts.caption,
            hashtags: scheduledPosts.hashtags,
            platform: scheduledPosts.platform,
            status: scheduledPosts.status,
            assistantId: scheduledPosts.assistantId,
            publishDate: scheduledPosts.publishDate,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    const caption = displayCaption(post.caption) || '';
    // Nothing to work with. Refused before a credit is spent — a model asked to improve an empty
    // caption returns an apology, which would then be pasted into the caption box.
    if (!caption.trim()) return json(400, { error: 'Write or draft a caption first — there is nothing to rewrite yet.' });

    const credit = await consumeTaskCredit(db, ctx.organisationId);
    if (!credit.allowed) {
        // A cap that could not be EVALUATED is a server fault, not a plan limit.
        if (credit.failed) return json(503, { error: credit.limitMessage });
        return json(403, { error: credit.limitMessage, upgradeRequired: true });
    }

    const limit = platformFormat(post.platform ?? 'instagram').charLimit ?? 2200;

    // Inspo applies to 'tone' ONLY, and the exclusions are deliberate rather than an oversight:
    // 'grammar' is told in as many words not to change the tone, so handing it a "write in this
    // voice" directive sets the two instructions fighting; 'hashtags' returns no prose for a prose
    // style directive to shape. 'tone' is the one action whose entire job is the voice, which is
    // exactly what the user's Inspo library teaches. Retrieval ranks on the caption being revised.
    // Never throws — degrades to a plain rewrite rather than failing the user's edit.
    const inspoBlock = action === 'tone' && post.assistantId
        ? await buildInspoBlock(db, {
            assistantId: post.assistantId,
            organisationId: ctx.organisationId,
            topic: caption,
        })
        : null;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1200,
            system:
                // Leading with the date for the same reason the generator does: a rewrite is free to
                // introduce a year that was never in the original ("a 2025 guide to…"), and an action
                // like 'tone' rewrites the whole caption. Scoped to the post's own slot, which is the
                // date this text will actually be read on.
                `${currentDatePromptBlock({ publishDate: post.publishDate })}\n\n`
                + 'You revise the words of ONE social media post. Return ONLY the replacement text — no preamble, '
                + 'no explanation, no surrounding quotes, no code fences, and no commentary about what you changed. '
                + 'Match the language of the original.'
                // Appended after the base rules, with the output-format rule restated last so the
                // exemplars — which are themselves finished social posts — can't be mistaken for a
                // template for the reply's SHAPE.
                + (inspoBlock
                    ? `\n\n${inspoBlock}\n\nReturn only the replacement text, on its own, with no other commentary.`
                    : ''),
            messages: [{
                role: 'user',
                content: `Platform: ${post.platform || 'instagram'} (caption limit ${limit} characters)\n`
                    + `Caption:\n"""${caption.slice(0, MAX_CAPTION_CHARS)}"""\n`
                    + `Current hashtags: ${post.hashtags || '(none)'}\n\n`
                    + `Task: ${directive(action, tone, limit)}`,
            }],
        });

        let text = (response.content[0] as { text?: string })?.text?.trim() ?? '';
        text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        if (!text) throw new Error('Empty rewrite.');

        void logAiUsage({
            userId: ctx.userId,
            workspaceId: ctx.organisationId,
            model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
        });

        if (FIELD[action] === 'hashtags') {
            // Keep only things that are actually hashtags: the model occasionally prefixes a
            // sentence, and that sentence would otherwise be saved into the hashtags field.
            const tags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).slice(0, 12).join(' ');
            if (!tags) throw new Error('No hashtags returned.');
            return json(200, { hashtags: tags });
        }
        // A rewrite that blows the platform limit is not usable — say so rather than silently
        // truncating mid-sentence, which is how a caption ends up ending in the middle of a word.
        return json(200, { caption: text.slice(0, MAX_CAPTION_CHARS), overLimit: text.length > limit });
    } catch (error) {
        console.error('[rewrite-post-text] error:', error);
        return json(500, { error: 'Could not rewrite that. Please try again.' });
    }
});
