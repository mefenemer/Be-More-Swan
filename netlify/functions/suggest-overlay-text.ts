// netlify/functions/suggest-overlay-text.ts
// Wording for a text overlay on a post's image or video — written from scratch, or improved.
//
// Overlay text is not a caption. It is read in about a second, at a glance, over a picture, often
// on mute — so the whole job is "few words, high contrast of meaning". A caption model left to
// itself writes a sentence, which is the wrong artefact: it wraps to three lines on a 1080 canvas
// and stops being readable. Hence the hard character ceiling in the prompt AND enforced on the way
// out, rather than a request that the model please be brief.
//
// POST { postId, mode: 'suggest'|'improve', currentText? } → { text }

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
import { withLambda } from '@netlify/aws-lambda-compat';
import { stripCodeFences } from '../../src/utils/model-json';

const MODEL = 'claude-haiku-4-5-20251001';
/** What fits on a still at a readable size. The overlay renderer shrinks past this, it does not wrap well. */
const MAX_OVERLAY_CHARS = 80;
const MAX_INPUT_CHARS = 400;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (await isGlobalAiDisabled()) {
        return json(503, { error: 'AI services are temporarily unavailable. Please try again later.' });
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { postId?: unknown; mode?: unknown; currentText?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId is required.' });
    const mode = body.mode === 'improve' ? 'improve' : 'suggest';
    const currentText = typeof body.currentText === 'string' ? body.currentText.trim().slice(0, MAX_INPUT_CHARS) : '';
    // "Improve" with nothing to improve is a suggest request wearing the wrong hat — asking the model
    // to improve an empty string reliably returns an apology rather than any wording.
    if (mode === 'improve' && !currentText) return json(400, { error: 'There is no wording to improve yet.' });

    // Tenant guard on the post, and its caption is the only context worth sending: the overlay has
    // to say something the post is actually about.
    const [post] = await db
        .select({
            id: scheduledPosts.id,
            caption: scheduledPosts.caption,
            platform: scheduledPosts.platform,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    // A model call on the user's behalf is a task. Unmetered, the plan's cap quietly stops being a
    // cap — and this is a button that can be pressed indefinitely.
    const credit = await consumeTaskCredit(db, ctx.organisationId);
    if (!credit.allowed) {
        // A cap that could not be EVALUATED is a server fault, not a plan limit — answering it with
        // the upgrade message would tell the user to buy a bigger plan to fix an outage.
        if (credit.failed) return json(503, { error: credit.limitMessage });
        return json(403, { error: credit.limitMessage, upgradeRequired: true });
    }

    const caption = displayCaption(post.caption) || '';

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 120,
            system:
                'You write the TEXT OVERLAY that sits on top of a social post\'s image or video — a hook ' +
                'read at a glance, usually on mute, in about one second. Not a caption.\n' +
                `Rules: at most ${MAX_OVERLAY_CHARS} characters. Prefer far fewer. No hashtags, no emoji, ` +
                'no quotation marks, no trailing full stop, no preamble. Do not repeat the caption ' +
                'verbatim — the reader can already see it. Match the caption\'s language and voice.\n' +
                'Return ONLY the overlay wording itself, on one line.',
            messages: [{
                role: 'user',
                content: mode === 'improve'
                    ? `The post's caption, for context:\n"""${caption.slice(0, 1200)}"""\n\n`
                      + `Improve this overlay wording — sharper and easier to read at a glance, same meaning and language:\n"""${currentText}"""`
                    : `The post's caption:\n"""${caption.slice(0, 1200)}"""\n\n`
                      + 'Write the overlay wording for this post.',
            }],
        });

        let text = (response.content[0] as { text?: string })?.text?.trim() ?? '';
        // The model is asked for one line and no decoration; strip what it adds anyway rather than
        // showing the user a quoted, fenced, or multi-line "hook" they then have to tidy by hand.
        text = stripCodeFences(text);
        text = text.split('\n')[0].trim().replace(/^["'“”']+|["'“”']+$/g, '').trim();
        if (text.length > MAX_OVERLAY_CHARS) text = text.slice(0, MAX_OVERLAY_CHARS).trimEnd();
        if (!text) throw new Error('Empty suggestion.');

        void logAiUsage({
            userId: ctx.userId,
            workspaceId: ctx.organisationId,
            model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
        });

        return json(200, { text });
    } catch (error) {
        console.error('[suggest-overlay-text] error:', error);
        return json(500, { error: 'Could not write that wording. Please try again.' });
    }
});
