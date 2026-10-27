// src/lib/image-prompt.ts
// Turning what a person types into something an image model can draw (owner, 2026-10-27).
//
// ── The failure ──────────────────────────────────────────────────────────────
// Asked for an image of "Hiring an outcome flips the arrangement. Instead of buying a tool and
// learning to run it, you bring on a specialist that already knows the job and gets on with it.",
// FLUX received that sentence word for word. A diffusion model reads a sentence as "draw these
// words", so all four results were posters with the sentence painted on — misspelt ("arrargements",
// "knows the ob the job"), because these models draw letters as shapes, not spelling — and a stock
// scene that barely related to the idea. Not a quality setting: a higher tier still misspells long
// text, and still illustrates the words rather than the meaning.
//
// ── The fix, in two parts ────────────────────────────────────────────────────
//   1. visualisePrompt(): one cheap model call rewrites the request as a concrete scene — subject,
//      setting, composition, light, style — a visual metaphor for an abstract idea. Fails OPEN: on
//      any error the person's own words are used, exactly as before.
//   2. NO_TEXT_RULE, appended to EVERY image prompt in fal-gateway.ts generateImages(): no words,
//      letters or captions in the picture. If a post needs a headline on the image, that belongs in
//      a text layer a person can read and correct, not in pixels a model guessed at.

import Anthropic from '@anthropic-ai/sdk';
import { logAiUsage } from '../utils/ai-usage';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';
/** The image call shares a 26s function budget, so this step must be quick or not happen. */
const TIMEOUT_MS = 4000;

export const NO_TEXT_RULE = 'No text of any kind in the image: no words, letters, numbers, captions, headlines, signs, labels, logos or typography.';

const SYSTEM = `You write prompts for an image-generation model (FLUX). You are given what a person asked for.
Return ONE prompt, 50-90 words, describing a single image to draw: the main subject, what they are doing, the setting, the composition and camera angle, the lighting and mood, and the visual style (photographic unless they asked for illustration).
If the request is an idea, a quote, a slogan or a sentence from an article, do NOT reproduce its words: depict what it MEANS as a concrete scene or visual metaphor a viewer would understand at a glance.
Never ask for text, words, letters, captions, signs or logos in the image. Never invent brand names.
Return only the prompt — no preamble, no quotation marks.`;

/** A drawable scene for `request`, or `request` itself when the rewrite is unavailable. Never throws. */
export async function visualisePrompt(
    request: string,
    usage?: { workspaceId?: number | null; userId?: number | null; assistantId?: number | null },
): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) return request;
    try {
        const resp = await anthropic.messages.create(
            { model: MODEL, max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content: request.slice(0, 1000) }] },
            { timeout: TIMEOUT_MS, maxRetries: 0 },
        );
        void logAiUsage({
            workspaceId: usage?.workspaceId ?? null, userId: usage?.userId ?? null, assistantId: usage?.assistantId ?? null,
            model: MODEL, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens,
            sessionId: 'image-prompt', dataCategories: ['business_context'],
        });
        const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ').trim();
        return text.length >= 20 ? text.replace(/^["“]|["”]$/g, '').slice(0, 1500) : request;
    } catch (err) {
        console.warn('[image-prompt] rewrite unavailable — using the request as written:', err instanceof Error ? err.message : err);
        return request;
    }
}
