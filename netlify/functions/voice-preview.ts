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
            ? `Write 2 samples. Sample 1 is the owner's text below REWRITTEN in this voice: keep its meaning and every fact in it, add nothing new. Sample 2 is a fresh piece (under 90 words).`
            : `Write ${picked.length} samples, each under 90 words, each about something this business would genuinely say.`,
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
        const response = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: user }] });
        void logAiUsage({
            userId: ctx.userId, workspaceId: ctx.organisationId, model: MODEL,
            inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        });
        const raw = (response.content[0] as { text?: string })?.text ?? '';
        const parsed = parseModelJson<{ samples?: unknown }>(raw);
        const texts = Array.isArray(parsed?.samples) ? parsed!.samples.map((t) => String(t).trim()).filter(Boolean) : [];
        if (!texts.length) return json(502, { error: 'The preview came back empty — try again.' });
        return json(200, { samples: texts.slice(0, labels.length).map((text, i) => ({ shape: labels[i] || '', text })) });
    } catch (err) {
        console.error('[voice-preview] failed', err);
        return json(502, { error: 'Could not write a preview right now — try again.' });
    }
});
