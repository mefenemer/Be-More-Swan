// src/utils/moderation.ts
// US2 — pre-processing safety gate for user prompts (AC2.1–2.3).
//
// Runs a prompt through the free OpenAI Moderation API. When the prompt is flagged for a
// SEVERE category (violence, self-harm, sexual/minors, extreme hate), callers hard-block
// the request, return the standardised toast, and log to security_audits. When OPENAI_API_KEY
// is absent the check is a no-op (fail-open) — the system-prompt Safe Content Benchmark
// (Refusal & Pivot Protocol) still governs generation, so we never block legitimate work
// just because moderation is unconfigured.

import { getDb } from '../../db/client';
import { securityAudits } from '../../db/schema';

/** Standardised UI error (AC2.2). */
export const SAFE_CONTENT_BLOCK_MESSAGE =
    'This request violates the Be More Swan Safe Content Benchmark and cannot be processed.';

// Severe categories that trigger a hard block. Softer flags (e.g. mild "harassment")
// are left to the in-prompt Refusal & Pivot Protocol rather than a hard block.
const SEVERE_CATEGORIES = [
    'violence', 'violence/graphic',
    'self-harm', 'self-harm/intent', 'self-harm/instructions',
    'sexual/minors',
    'hate/threatening',
    'harassment/threatening',
    'illicit', 'illicit/violent',
];

export interface ModerationResult {
    /** True when a severe category was flagged and the request must be blocked. */
    blocked: boolean;
    /** All flagged categories (for the audit log). */
    categories: string[];
}

/**
 * Run the OpenAI Moderation API on `text`. Returns { blocked, categories }.
 * Fail-open on any error or missing key.
 */
export async function moderatePrompt(text: string): Promise<ModerationResult> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || !text?.trim()) return { blocked: false, categories: [] };

    try {
        const res = await fetch('https://api.openai.com/v1/moderations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
            body: JSON.stringify({ input: text }),
        });
        if (!res.ok) return { blocked: false, categories: [] };

        const data = await res.json();
        const result = data.results?.[0];
        if (!result?.flagged) return { blocked: false, categories: [] };

        const categories = Object.entries(result.categories || {})
            .filter(([, v]) => v === true)
            .map(([k]) => k);
        const blocked = categories.some(c => SEVERE_CATEGORIES.includes(c));
        return { blocked, categories };
    } catch (err) {
        console.error('[moderation] check failed (fail-open):', err);
        return { blocked: false, categories: [] };
    }
}

/** AC2.3 — log a hard block for admin review. Best-effort; never throws. */
export async function logSecurityAudit(opts: {
    userId: number | null;
    organisationId?: number | null;
    source: string;
    categories: string[];
    prompt: string;
}): Promise<void> {
    try {
        await getDb().insert(securityAudits).values({
            userId: opts.userId,
            organisationId: opts.organisationId ?? null,
            source: opts.source,
            flaggedCategories: opts.categories,
            promptExcerpt: (opts.prompt || '').slice(0, 200),
        });
    } catch (err) {
        console.error('[moderation] security_audits insert failed (non-blocking):', err);
    }
}

/** Ready-to-return 422 block response with the standardised toast (AC2.2). */
export function blockedResponse() {
    return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: SAFE_CONTENT_BLOCK_MESSAGE, code: 'SAFE_CONTENT_BLOCKED' }),
    };
}

/**
 * Convenience guard: moderate a prompt, and on a severe flag log + return the block response.
 * Returns the block response to return immediately, or null to proceed.
 */
export async function enforcePromptModeration(opts: {
    text: string;
    userId: number | null;
    organisationId?: number | null;
    source: string;
}) {
    const { blocked, categories } = await moderatePrompt(opts.text);
    if (!blocked) return null;
    await logSecurityAudit({ userId: opts.userId, organisationId: opts.organisationId, source: opts.source, categories, prompt: opts.text });
    return blockedResponse();
}
