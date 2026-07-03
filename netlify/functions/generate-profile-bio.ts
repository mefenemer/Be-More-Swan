// netlify/functions/generate-profile-bio.ts
// AC1 (SMM): Profile bio generator — produces platform-tailored social bios from the
// assistant blueprint, stores them in the assistant's onboardingContext, and returns
// them for the workspace to display. The canonical `business_bio` + the per-platform
// `profile_bios` are what social-profile-sync.ts pushes to Meta / LinkedIn.
//
// POST { assistantId? }                — generate fresh bios from the blueprint.
// POST { assistantId?, editedDraft }   — persist user-edited bios (no LLM call).
//
// Migration-free: everything lives in the existing onboarding_context JSONB column.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// Platform char budgets — mirror the slices social-profile-sync applies when pushing.
const LIMITS = { instagram: 150, facebook: 255, linkedin: 700 } as const;

interface BioDraft { instagram: string; facebook: string; linkedin: string }

function clampDraft(d: BioDraft): BioDraft {
    return {
        instagram: (d.instagram || '').slice(0, LIMITS.instagram),
        facebook: (d.facebook || '').slice(0, LIMITS.facebook),
        linkedin: (d.linkedin || '').slice(0, LIMITS.linkedin),
    };
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId } = ctx;

    let body: { assistantId?: number; editedDraft?: BioDraft };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const { assistantId, editedDraft } = body;

    // Load the active assistant (scoped to the tenant).
    const [assistant] = await db
        .select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            systemPrompt: aiAssistants.systemPrompt,
            configuration: aiAssistants.configuration,
            onboardingContext: aiAssistants.onboardingContext,
        })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, organisationId),
            ...(assistantId ? [eq(aiAssistants.id, assistantId)] : []),
            eq(aiAssistants.isActive, true),
        ))
        .limit(1);

    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'No active assistant found' }) };

    // Runtime connection sandboxing: only social-capable assistants get profile bios.
    const roleArg = { roleKey: (assistant.configuration as { type?: string } | null)?.type, role: assistant.name };
    if (!isServiceAllowedForAssistant('instagram', roleArg) && !isServiceAllowedForAssistant('linkedin', roleArg)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'This assistant is not permitted to manage social profiles.', code: 'CONNECTION_NOT_RELEVANT' }) };
    }

    const onboarding = (assistant.onboardingContext as Record<string, unknown>) ?? {};

    // ── Persist-only path: save user-edited bios without regenerating. ──────────
    if (editedDraft) {
        const draft = clampDraft(editedDraft);
        await persistBios(db, assistant.id, onboarding, draft);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, draft }) };
    }

    // ── Generate path. ──────────────────────────────────────────────────────────
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, organisationId)).limit(1);
    const businessName = org?.name ?? 'the business';

    const toneOfVoice = (onboarding.tone_of_voice as string) ?? 'friendly and professional';
    const targetAudience = (onboarding.target_audience as string) ?? 'customers';
    const contentPillars = Array.isArray(onboarding.content_pillars)
        ? (onboarding.content_pillars as string[]).join(', ')
        : (onboarding.content_pillars as string) ?? '';
    const serviceOfferings = (onboarding.service_offerings as string) ?? '';
    const existingBio = (onboarding.business_bio as string) ?? '';

    const blueprintContext = [
        assistant.systemPrompt ? `## System Prompt\n${assistant.systemPrompt}` : '',
        contentPillars ? `## Content Pillars\n${contentPillars}` : '',
        serviceOfferings ? `## Service Offerings\n${serviceOfferings}` : '',
        (onboarding.brand_guidelines as string) ? `## Brand Guidelines\n${onboarding.brand_guidelines}` : '',
        existingBio ? `## Current Bio (for reference — improve on it)\n${existingBio}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `You are writing social media profile bios for ${businessName}. Tone: ${toneOfVoice}. Target audience: ${targetAudience}.

${blueprintContext ? `## Blueprint Context\n${blueprintContext}\n\n` : ''}Write profile bios tailored to each platform's conventions. Return ONLY valid JSON with these exact keys:
{
  "instagram": "string, MAX 150 chars — punchy, may use 1-3 relevant emojis, line breaks ok, no hashtags",
  "facebook": "string, MAX 255 chars — the Facebook Page 'About' / short description, clear and professional",
  "linkedin": "string, MAX 700 chars — the LinkedIn organisation 'About', a fuller value-led description in 2-3 short paragraphs"
}

Rules:
- Use the business name naturally; write in the brand voice above
- Speak to the target audience and lead with the value you provide
- Do NOT include placeholders like [NAME], [CITY] or [DATE]
- Do NOT invent claims, awards, pricing or statistics not present in the context
- Respect each platform's character limit exactly`;

    let draft: BioDraft | null = null;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 700,
                messages: [{ role: 'user', content: prompt }],
            });
            const raw = (response.content[0] as { text: string }).text.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            if (parsed?.instagram && parsed?.facebook && parsed?.linkedin) {
                draft = clampDraft(parsed);
                break;
            }
            console.warn(`[generate-profile-bio] Attempt ${attempt}: invalid LLM response format`);
        } catch (err) {
            console.warn(`[generate-profile-bio] Attempt ${attempt} error:`, err);
            if (attempt === MAX_RETRIES) {
                return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate profile bios after retries' }) };
            }
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }
    if (!draft) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate valid profile bios' }) };
    }

    await persistBios(db, assistant.id, onboarding, draft);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, draft }),
    };
};

// Store bios in onboarding_context: per-platform variants under `profile_bios`, and the
// canonical `business_bio` (Facebook variant) that social-profile-sync falls back to.
async function persistBios(
    db: ReturnType<typeof getDb>,
    assistantId: number,
    onboarding: Record<string, unknown>,
    draft: BioDraft,
): Promise<void> {
    await db.update(aiAssistants).set({
        onboardingContext: {
            ...onboarding,
            profile_bios: draft,
            profile_bios_generated_at: new Date().toISOString(),
            business_bio: draft.facebook,
        },
        updatedAt: new Date(),
    }).where(eq(aiAssistants.id, assistantId));
}
