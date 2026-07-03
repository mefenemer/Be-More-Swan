// netlify/functions/quality-review.ts
// US-AUD-2.2.1: Secondary LLM quality review for AI-generated content.
//
// POST /.netlify/functions/quality-review
//   Auth: aura_session
//   Body: { content: string, assistantId?: number }
//
// Tier gate (by tierKey on active plan):
//   'buster' (Tier 1) → 403 with upgrade callout
//   'saver'  (Tier 2) → Quick Review: 3 checks (factual, tone, hallucination); ✅/⚠️; max 3 lines; 5s timeout
//   'employee'+ (Tier 3/4) → Full Review: Quick checks + brand voice score + competitor + legal/compliance
//
// No usage cap — all eligible paid tiers may call without restriction.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, aiAssistants, plans, masterPlans } from '../../db/schema';
import { logAiUsage } from '../../src/utils/ai-usage';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';

const jwtSecret   = process.env.JWT_SECRET;
const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REVIEW_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS   = 5_000;

// Tiers that receive Full Review
const FULL_REVIEW_TIERS = new Set(['employee']);
// Tiers blocked from Quick Review (upgrade callout only)
const BLOCKED_TIERS = new Set(['buster']);

interface ReviewCheck {
    label: string;
    status: 'pass' | 'warn';
    detail?: string;
}

async function getUserPlanTierKey(db: any, userId: number): Promise<string | null> {
    const [row] = await db
        .select({ tierKey: masterPlans.tierKey })
        .from(plans)
        .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
        .limit(1);
    return row?.tierKey ?? null;
}

function buildPrompt(content: string, reviewType: 'quick' | 'full', brandVoice: string): string {
    const base = `You are a quality reviewer for AI-generated business content. Analyse the following content and respond ONLY with a valid JSON object (no markdown fences, no extra text).

Content:
"""
${content.slice(0, 3_000)}
"""

Always include these 3 checks:
{
  "factual":       { "status": "pass"|"warn", "detail": "one short sentence if warn, else omit" },
  "tone":          { "status": "pass"|"warn", "detail": "one short sentence if warn, else omit" },
  "hallucination": { "status": "pass"|"warn", "detail": "one short sentence if warn, else omit" }
}

Rules:
- "factual" warn: specific verifiable claims (statistics, dates, named persons, URLs) present without a source.
- "tone" warn: unprofessional, aggressive, or unsuitable language for business use.
- "hallucination" warn: internal contradictions, invented URLs, fictional citations.`;

    if (reviewType !== 'full') return base;

    const brandSection = brandVoice
        ? `Brand voice guide (first 500 chars): "${brandVoice}"`
        : 'No brand voice guide available — skip brandVoice check (set score to null, status "pass").';

    return `${base}

Also include these 3 Full Review checks:
  "brandVoice":  { "score": 0-100 | null, "status": "pass"|"warn", "detail": "..." },
  "competitors": { "status": "pass"|"warn", "detail": "..." },
  "compliance":  { "status": "pass"|"warn", "detail": "..." }

${brandSection}
- "competitors" warn: any recognisable competitor brand names present.
- "compliance" warn: legal, medical, financial, or regulatory language requiring professional sign-off.`;
}

function formatChecks(raw: Record<string, any>, isFull: boolean): ReviewCheck[] {
    const fmt = (key: string, passLabel: string, warnPrefix: string): ReviewCheck => ({
        label: raw[key]?.status === 'warn'
            ? `⚠️ ${warnPrefix}${raw[key]?.detail ? ': ' + raw[key].detail : ''}`
            : `✅ ${passLabel}`,
        status: raw[key]?.status === 'warn' ? 'warn' : 'pass',
        detail: raw[key]?.detail,
    });

    const checks: ReviewCheck[] = [
        fmt('factual',       'No factual red flags',          'Factual flag'),
        fmt('tone',          'Tone appropriate',              'Tone issue'),
        fmt('hallucination', 'No hallucination markers',      'Hallucination marker'),
    ];

    if (isFull) {
        if (raw.brandVoice) {
            const score = raw.brandVoice.score != null ? ` (${raw.brandVoice.score}/100)` : '';
            checks.push({
                label: raw.brandVoice.status === 'warn'
                    ? `⚠️ Brand voice mismatch${score}${raw.brandVoice.detail ? ': ' + raw.brandVoice.detail : ''}`
                    : `✅ Brand voice aligned${score}`,
                status: raw.brandVoice.status === 'warn' ? 'warn' : 'pass',
                detail: raw.brandVoice.detail,
            });
        }
        if (raw.competitors) checks.push(fmt('competitors', 'No competitor names', 'Competitor mention'));
        if (raw.compliance)  checks.push(fmt('compliance',  'No compliance flags', 'Compliance flag'));
    }

    return checks;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    }

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { content, assistantId } = body;

    if (!content || typeof content !== 'string' || content.trim().length < 10) {
        return { statusCode: 400, body: JSON.stringify({ error: 'content is required (min 10 characters).' }) };
    }

    const db = getDb();

    // Resolve the active organisation (member-shared assistant ownership; membership verified).
    const org = await resolveActiveOrg(db, userId, getSession(event)?.activeOrganisationId);
    if (!org) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation associated with this account.' }) };
    const orgId = org.organisationId;

    // US2: hard-block severe-violation prompts before any AI processing (AC2.1–2.3).
    const modBlock = await enforcePromptModeration({ text: content, userId, organisationId: orgId, source: 'quality-review' });
    if (modBlock) return modBlock;

    const tierKey = await getUserPlanTierKey(db, userId);

    // Tier 1 (buster) — upgrade callout
    if (!tierKey || BLOCKED_TIERS.has(tierKey)) {
        return {
            statusCode: 403,
            body: JSON.stringify({
                error: 'Quality Review is available on Saver and above.',
                upgradeRequired: true,
                upgradeMessage: 'Upgrade your plan to unlock AI Quality Review — instant fact-checking, tone analysis, and hallucination detection for every output.',
            }),
        };
    }

    const isFull = FULL_REVIEW_TIERS.has(tierKey);
    const reviewType: 'quick' | 'full' = isFull ? 'full' : 'quick';

    // Fetch brand voice context for Full Review
    let brandVoice = '';
    if (isFull && assistantId) {
        const [assistant] = await db
            .select({ systemPrompt: aiAssistants.systemPrompt })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (assistant?.systemPrompt) brandVoice = assistant.systemPrompt.slice(0, 500);
    }

    const prompt = buildPrompt(content, reviewType, brandVoice);

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await anthropic.messages.create({
            model:      REVIEW_MODEL,
            max_tokens: 600,
            messages:   [{ role: 'user', content: prompt }],
        }, { signal: controller.signal as any });

        clearTimeout(timeoutId);

        void logAiUsage({
            userId,
            model:        REVIEW_MODEL,
            inputTokens:  response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            assistantId:  assistantId ?? null,
            dataCategories: ['business_context'],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        let raw: Record<string, any> = {};
        try {
            const m = text.match(/\{[\s\S]*\}/);
            raw = m ? JSON.parse(m[0]) : {};
        } catch { /* leave raw empty; format will use pass defaults */ }

        const checks = formatChecks(raw, isFull);

        return {
            statusCode: 200,
            body: JSON.stringify({
                checks,
                reviewType,
                tierKey,
                upgradeHint: !isFull
                    ? 'Upgrade to Employee plan for Full Review: brand voice scoring, competitor detection, and legal/compliance flagging.'
                    : null,
            }),
        };

    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError' || err.message?.includes('abort')) {
            // 5-second timeout — return safe partial result rather than error
            return {
                statusCode: 200,
                body: JSON.stringify({
                    checks: [{ label: '⚠️ Review timed out — please try again', status: 'warn' }],
                    reviewType,
                    tierKey,
                    timedOut: true,
                    upgradeHint: null,
                }),
            };
        }
        console.error('[quality-review]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Quality review failed.' }) };
    }
};
