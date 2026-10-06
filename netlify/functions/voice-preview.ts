// netlify/functions/voice-preview.ts
// Profile ▸ Voice builder ▸ "Hear it" — two short samples, about the workspace's own business, in
// the voice being built. Nothing is saved; the samples are a way to hear a setting before it drafts.
//
//   POST { assistantId, tone?, voice?, text? } → { samples: [{ shape, text }] }
//
// `text` (2026-10-06): the owner's OWN words to try the voice on. The first sample is that text
// rewritten in the voice — same meaning, same facts — because "I entered words and did not hear
// them" was the first thing a user said about a preview that only ever wrote fresh copy.
//
// The settings come from the REQUEST, not the stored profile, so the owner hears the slider they
// just moved rather than the last autosave. They go through the same voiceDirective the generators
// use (src/utils/voice-profile.ts), so the preview is not a second implementation of "the voice".
// Two different shapes from the assistant's Content mix, so voice and structure are heard together.
//
// Cheap on purpose: Haiku, ~120 words each, no task credit (it is setup, not work).

import { HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { voiceDirective, type VoiceSurface } from '../../src/utils/voice-profile';
import { allowedArticleTypes, allowedSocialShapes } from '../../src/utils/content-shapes';
import { parseModelJson } from '../../src/utils/model-json';
import { withLambda } from '@netlify/aws-lambda-compat';

const MODEL = 'claude-haiku-4-5-20251001';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (await isGlobalAiDisabled()) return json(503, { error: 'AI services are temporarily unavailable. Please try again later.' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { assistantId?: unknown; tone?: unknown; voice?: unknown; text?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body.' }); }
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId)) return json(400, { error: 'assistantId is required.' });

    const [a] = await db
        .select({ onboardingContext: aiAssistants.onboardingContext, roleKey: masterAssistants.roleKey })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(masterAssistants.id, aiAssistants.masterAssistantId))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId)))
        .limit(1);
    if (!a) return json(404, { error: 'Assistant not found.' });
    const actx = (a.onboardingContext as Record<string, unknown> | null) ?? {};

    const [org] = await db
        .select({ name: organisations.name, businessDescription: organisations.businessDescription, targetAudience: organisations.targetAudience })
        .from(organisations).where(eq(organisations.id, ctx.organisationId)).limit(1);

    const surface: VoiceSurface = a.roleKey === 'blog_writer' ? 'blog' : a.roleKey === 'newsletter_editor' ? 'email' : 'social';
    const tone = typeof body.tone === 'string' ? body.tone : (actx.tone_of_voice as string | undefined);

    // Two different shapes from what this assistant is allowed to write.
    const shapes = surface === 'blog'
        ? allowedArticleTypes(actx.allowed_article_types).map((t) => ({ label: t.label, brief: `the opening two short paragraphs of ${t.label.toLowerCase()} blog post` }))
        : surface === 'email'
            ? [{ label: 'Email', brief: 'the opening of an email to subscribers' }, { label: 'Email', brief: 'a short email announcing something new' }]
            : allowedSocialShapes(actx.allowed_post_shapes).map((s) => ({ label: s.label, brief: `a social post that is ${s.summary.toLowerCase()}` }));
    const own = typeof body.text === 'string' ? body.text.trim().slice(0, 1200) : '';
    const picked = [...shapes].sort(() => Math.random() - 0.5).slice(0, own ? 1 : 2);

    const system = [
        `You write short samples so a business owner can hear what their assistant will sound like.`,
        `Business: ${org?.name || 'this business'}.${org?.businessDescription ? ` ${String(org.businessDescription).slice(0, 600)}` : ''}`,
        org?.targetAudience ? `Audience: ${String(org.targetAudience).slice(0, 300)}` : '',
        voiceDirective(tone, { surface, fallback: 'friendly and professional', voice: body.voice }),
        own
            ? [
                `Write 2 samples.`,
                `Sample 1 is the owner's text below REWRITTEN in this voice. Rules for Sample 1, all of them strict:`,
                `- Change only HOW it is said — word choice, rhythm, sentence shape. Never WHAT is said.`,
                `- Every claim in the original stays, and NO new claim, benefit, feature, promise, comparison or detail is added — not even a small one ("no code", "no learning curve", "no oversight" are additions).`,
                `- Do not strengthen or weaken a claim (no "always", "guaranteed", "never" that the original does not say).`,
                `- Roughly the same length as the original (within about a third).`,
                `Sample 2 is a fresh piece (under 90 words)${surface === 'email' ? ' — written as an email to subscribers, never called a memo or letter' : ''}.`,
              ].join('\n')
            : `Write ${picked.length} samples, each under 90 words, each about something this business would genuinely say${surface === 'email' ? ' (each is an email to subscribers)' : ''}.`,
        // ⚠️ Previews invented product features ("connect in two clicks", named integrations, a menu
        // that does not exist). Anything not in the business description above is off limits.
        `ONLY use facts stated in the business description above or in the owner's text. Do not mention features, integrations, menus, numbers, prices, names, timeframes or results that are not stated there — talk about the reader and the problem instead. No hashtags.`,
        `Return ONLY JSON: {"samples": ["...", "..."]}`,
    ].filter(Boolean).join('\n\n');
    const user = own
        ? `Sample 1 — rewrite this in the voice:\n<owner_text>${own}</owner_text>\nSample 2: ${picked[0]?.brief || 'a short piece'}.`
        : picked.map((p, i) => `Sample ${i + 1}: ${p.brief}.`).join('\n');
    const labels = own ? ['Your words, in this voice', picked[0]?.label || ''] : picked.map((p) => p.label);

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        // Lower temperature when rewriting the owner's words: fidelity matters more than flair there.
        const response = await anthropic.messages.create({ model: MODEL, max_tokens: 700, temperature: own ? 0.4 : 0.9, system, messages: [{ role: 'user', content: user }] });
        void logAiUsage({
            userId: ctx.userId, workspaceId: ctx.organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });
        const raw = (response.content[0] as { text?: string })?.text ?? '';
        const parsed = parseModelJson<{ samples?: unknown }>(raw);
        const texts = Array.isArray(parsed?.samples) ? parsed!.samples.map((t) => String(t).trim()).filter(Boolean) : [];
        if (!texts.length) return json(502, { error: 'The preview came back empty — try again.' });

        // ── Fidelity check on the rewrite (2026-10-06) ────────────────────────────────────────────
        // Even told "add nothing", the rewrite padded ("no code, no learning curve") and once
        // inverted a fact ("without oversight" — every email IS approved by a person). A second,
        // small call compares it with the original and returns a corrected version with anything
        // new taken out. One check, no loop; if the check itself fails, the rewrite is shown as is.
        let checkNote: string | null = null;
        if (own && texts[0]) {
            const fixed = await checkRewrite(anthropic, own, texts[0], ctx);
            if (fixed && fixed.text) {
                texts[0] = fixed.text;
                if (fixed.removed.length) checkNote = `Checked against your original — removed: ${fixed.removed.join('; ')}.`;
            }
        }
        return json(200, {
            samples: texts.slice(0, labels.length).map((text, i) => ({ shape: labels[i] || '', text, ...(i === 0 && checkNote ? { note: checkNote } : {}) })),
        });
    } catch (err) {
        console.error('[voice-preview] failed', err);
        return json(502, { error: 'Could not write a preview right now — try again.' });
    }
});

/**
 * Compare a rewrite with the owner's original and strip anything the original does not say.
 * Returns the corrected text and what was removed, or null when the check could not run.
 */
async function checkRewrite(
    anthropic: Anthropic,
    original: string,
    rewrite: string,
    ctx: { userId: number; organisationId: number },
): Promise<{ text: string; removed: string[] } | null> {
    try {
        const res = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 500,
            temperature: 0,
            system: [
                'You check that a rewrite says nothing the original does not say.',
                'The rewrite was DELIBERATELY written in a different voice. Changes of tone, formality, word choice, rhythm and sentence shape are intended — never list them and never undo them.',
                'A paraphrase that means the same thing is NOT a change ("execute your instructions" = "get on with it"; "continuously" = "24/7").',
                'Look for exactly three problems: (1) a claim, benefit, feature, promise, comparison or detail in the REWRITE that the ORIGINAL does not make; (2) a claim made stronger or more absolute; (3) a claim reversed or contradicted.',
                'Then return the rewrite with only those problems removed — delete the added words, or soften the claim back — and EVERYTHING else exactly as the rewrite has it. If there are none, return it unchanged with an empty list.',
                'Return ONLY JSON: {"removed": ["what changed, in under 8 words", ...], "text": "the corrected rewrite"}',
            ].join('\n'),
            messages: [{ role: 'user', content: `<original>${original}</original>\n<rewrite>${rewrite}</rewrite>` }],
        });
        void logAiUsage({
            userId: ctx.userId, workspaceId: ctx.organisationId, model: MODEL,
            inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0,
        });
        const parsed = parseModelJson<{ removed?: unknown; text?: unknown }>((res.content[0] as { text?: string })?.text ?? '');
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
        if (!text) return null;
        const removed = Array.isArray(parsed?.removed) ? parsed!.removed.map((r) => String(r).trim()).filter(Boolean).slice(0, 5) : [];
        return { text, removed };
    } catch (err) {
        console.warn('[voice-preview] rewrite check skipped:', err instanceof Error ? err.message : err);
        return null;
    }
}
