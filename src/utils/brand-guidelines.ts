// src/utils/brand-guidelines.ts
// The workspace's picture guidelines — what its images should look like, and what they must never
// show. docs/brand-designer-plan.md §4.5 (Phase 2).
//
// ── Why a column of their own, not fields on brand_kit ──────────────────────────────────────────
// The plan first said "new fields on brand_kit". Two things made that a trap:
//   • brand_kit is REPLACED WHOLESALE by website extraction — brand-kit.ts `extract` and the lazy
//     path in brand-extract-fetch.ts both write a freshly derived kit. A guideline typed by a person
//     would be wiped the next time the colours were re-read, silently.
//   • Every branded card stores the WHOLE kit in its render_params, so guidelines would be copied
//     into every card ever drawn.
// So they live in organisations.brand_guidelines (db/z-brand-guidelines.sql) — still no new table,
// which was the point of the plan's rule — and only a person, or a chat card a person clicked,
// writes them.
//
// ── Who reads them ──────────────────────────────────────────────────────────────────────────────
// Every AUTOMATIC AI image: generateAndPersistImage (src/lib/media-persist.ts) — the one function the
// post editor's regenerate, autopilot drafting and the media suggestions all go through — and the
// Brand Designer's art direction (src/utils/visual-briefs.ts). NOT the manual "Generate with AI" box
// in My Content (generate-ai-image.ts): there the user wrote the prompt themselves, and silently
// rewriting what someone typed is worse than leaving it alone. Stock photo search cannot honour
// "never show" — Pexels has no exclusion filter — and the Brand Designer's tab says so.

import { eq } from 'drizzle-orm';
import { organisations } from '../../db/schema';
import type { getDb } from '../../db/client';
import { normalizeHex } from '../public/brand-contrast.js';

type Db = ReturnType<typeof getDb>;

export interface BrandGuidelines {
    /** What the business's pictures should look like: light, people, setting, feel. */
    photoStyle: string | null;
    /** What a picture should include when it can (a product, a place, a colour). */
    mustInclude: string | null;
    /** What a picture must never show. */
    mustAvoid: string | null;
    /** Extra brand colours beyond the kit's three — steer for AI images, max 4. */
    secondaryColors: string[];
    updatedAt: string | null;
}

export const EMPTY_GUIDELINES: BrandGuidelines = { photoStyle: null, mustInclude: null, mustAvoid: null, secondaryColors: [], updatedAt: null };

export const GUIDELINE_LIMITS = { photoStyle: 500, mustInclude: 300, mustAvoid: 300, secondaryColors: 4 } as const;

function text(raw: unknown, max: number): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.replace(/\s+/g, ' ').trim();
    return v ? v.slice(0, max) : null;
}

/** Coerce whatever is stored (or posted) into complete guidelines. Every field falls back alone. */
export function normaliseGuidelines(raw: unknown): BrandGuidelines {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_GUIDELINES, secondaryColors: [] };
    const r = raw as Record<string, unknown>;
    const colours = Array.isArray(r.secondaryColors) ? r.secondaryColors : [];
    const seen = new Set<string>();
    const secondaryColors: string[] = [];
    for (const c of colours) {
        const hex = normalizeHex(c);
        if (hex && !seen.has(hex)) { seen.add(hex); secondaryColors.push(hex); }
        if (secondaryColors.length >= GUIDELINE_LIMITS.secondaryColors) break;
    }
    const at = typeof r.updatedAt === 'string' && !Number.isNaN(Date.parse(r.updatedAt)) ? new Date(r.updatedAt).toISOString() : null;
    return {
        photoStyle: text(r.photoStyle, GUIDELINE_LIMITS.photoStyle),
        mustInclude: text(r.mustInclude, GUIDELINE_LIMITS.mustInclude),
        mustAvoid: text(r.mustAvoid, GUIDELINE_LIMITS.mustAvoid),
        secondaryColors,
        updatedAt: at,
    };
}

export function hasGuidelines(g: BrandGuidelines): boolean {
    return !!(g.photoStyle || g.mustInclude || g.mustAvoid || g.secondaryColors.length);
}

/**
 * Apply a partial change: only keys PRESENT in `patch` change; an empty string or [] clears one.
 * Returns the error instead when a colour is not a colour — a bad hex is refused, not dropped,
 * because the person who typed it would otherwise think it was saved.
 */
export function mergeGuidelines(current: BrandGuidelines, patch: Record<string, unknown>, now = new Date())
    : { ok: true; guidelines: BrandGuidelines } | { ok: false; error: string } {
    const next: Record<string, unknown> = { ...current };
    for (const k of ['photoStyle', 'mustInclude', 'mustAvoid'] as const) {
        if (patch[k] !== undefined) next[k] = patch[k] === null ? null : patch[k];
    }
    if (patch.secondaryColors !== undefined) {
        const list = Array.isArray(patch.secondaryColors) ? patch.secondaryColors : [];
        const bad = list.find((c) => !normalizeHex(c));
        if (bad !== undefined) return { ok: false, error: `"${String(bad).slice(0, 20)}" is not a colour — use a hex code like #ff007f.` };
        if (list.length > GUIDELINE_LIMITS.secondaryColors) return { ok: false, error: `At most ${GUIDELINE_LIMITS.secondaryColors} extra colours.` };
        next.secondaryColors = list;
    }
    next.updatedAt = now.toISOString();
    return { ok: true, guidelines: normaliseGuidelines(next) };
}

export async function readBrandGuidelines(db: Db, orgId: number): Promise<BrandGuidelines> {
    const [org] = await db.select({ g: organisations.brandGuidelines }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
    return normaliseGuidelines(org?.g);
}

/** The guidelines as prompt lines for a model that writes image prompts (art direction, chat). */
export function guidelinesPromptLines(g: BrandGuidelines): string[] {
    return [
        g.photoStyle ? `HOUSE PHOTO STYLE (applies to every picture): ${g.photoStyle}` : '',
        g.mustInclude ? `INCLUDE WHERE IT FITS: ${g.mustInclude}` : '',
        g.mustAvoid ? `NEVER SHOW (applies to every picture): ${g.mustAvoid}` : '',
        g.secondaryColors.length ? `EXTRA BRAND COLOURS: ${g.secondaryColors.join(', ')}` : '',
    ].filter(Boolean);
}

/** Max characters the guidelines may add to an image prompt — the subject must stay the subject. */
const SUFFIX_MAX = 450;

/**
 * Append the guidelines to an image prompt that was written WITHOUT them (the automatic paths).
 * Unchanged when there are none, so a workspace that never set any generates exactly as before.
 */
export function applyGuidelinesToImagePrompt(prompt: string, g: BrandGuidelines): string {
    const parts = [
        g.photoStyle ? `Style: ${g.photoStyle}.` : '',
        g.mustInclude ? `Where it fits, include: ${g.mustInclude}.` : '',
        g.mustAvoid ? `Never show: ${g.mustAvoid}.` : '',
        g.secondaryColors.length ? `Colour accents may use ${g.secondaryColors.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    if (!parts) return prompt;
    return `${prompt.trim()} ${parts.slice(0, SUFFIX_MAX)}`.trim();
}
