// src/utils/art-direction-context.ts
// What a prompt writer needs to know before it describes a picture: the business, its brand colours,
// its picture guidelines, and what has been turned down. One source for both writers — the Brand
// Designer's art direction (visual-briefs.ts) and the post editor's generate button
// (post-image-direction.ts), so neither can drift into knowing less than the other.
//
// ⚠️ Its own module because visual-briefs.ts pulls in the card and flyer renderers, and the post
// editor's button runs inside a 26-second function that should not load them on a cold start.

import { and, eq } from 'drizzle-orm';
import { aiAssistants, organisations } from '../../db/schema';
import type { getDb } from '../../db/client';
import { normalizeBrandKit, type BrandKit } from './brand-kit';
import { guidelinesPromptLines, normaliseGuidelines, type BrandGuidelines } from './brand-guidelines';
import {
    FLYER_SOURCE, FLYER_SOURCE_LABEL, OWN_SOURCE, OWN_SOURCE_LABEL, REJECT_REASON_LABELS, SOURCE_SPECS, type RejectReason,
} from '../config/visual-brief-vocab';

type Db = ReturnType<typeof getDb>;

export interface BriefContext {
    kit: BrandKit; orgName: string; industry: string | null; description: string | null;
    /**
     * The workspace's picture guidelines (src/utils/brand-guidelines.ts) — the same ones every
     * automatic AI image reads. Phase 1 asked the Brand Designer's own setup for a photo style and a
     * "never show"; those answers still fill a guideline the workspace has left EMPTY, so nobody who
     * answered them loses the steer when Phase 2 lands.
     */
    guidelines: BrandGuidelines;
}

export interface PastRejection { source: string; reason: string; note: string | null; prompt: string | null }

export function clip(s: string | null | undefined, n: number): string {
    return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** One setup answer, as a trimmed string or null. A plain lookup — the keys match the schema. */
export function setupAnswer(onboardingContext: unknown, key: string): string | null {
    const v = onboardingContext && typeof onboardingContext === 'object' ? (onboardingContext as Record<string, unknown>)[key] : null;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Phase 1 setup answers fill only the guidelines the workspace left empty — never override one. */
export function withSetupFallback(g: BrandGuidelines, onboardingContext: unknown): BrandGuidelines {
    return {
        ...g,
        photoStyle: g.photoStyle ?? setupAnswer(onboardingContext, 'photoStyle'),
        mustAvoid: g.mustAvoid ?? setupAnswer(onboardingContext, 'avoidAlways'),
    };
}

export async function readBriefContext(db: Db, orgId: number, assistantId: number): Promise<BriefContext> {
    const [[org], [assistant]] = await Promise.all([
        db.select({
            name: organisations.name, industry: organisations.industry,
            description: organisations.businessDescription, brandKit: organisations.brandKit,
            guidelines: organisations.brandGuidelines,
        }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
        db.select({ onboardingContext: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1),
    ]);
    return {
        kit: normalizeBrandKit(org?.brandKit),
        orgName: org?.name ?? '',
        industry: org?.industry ?? null,
        description: org?.description ?? null,
        guidelines: withSetupFallback(normaliseGuidelines(org?.guidelines), assistant?.onboardingContext),
    };
}

/**
 * A brand colour as words an image model can use ("deep green", "warm cream"). Hex codes in an image
 * prompt can be painted into the picture as text (audit, 2026-10-25). Pure; '' for a bad value.
 */
export function colourWords(hex: string | null | undefined): string {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex ?? '').trim());
    if (!m) return '';
    const h6 = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h6.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (l > 0.93) return s > 0.25 ? 'warm cream' : 'white';
    if (l < 0.1) return 'near-black';
    let hue = 0;
    if (d) hue = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (hue < 0) hue += 360;
    const shade = l < 0.3 ? 'deep ' : l > 0.75 ? 'pale ' : '';
    if (s < 0.15) return l < 0.3 ? 'charcoal' : l > 0.75 ? 'light grey' : 'grey';
    const name = hue < 15 || hue >= 345 ? (l < 0.45 ? 'wine red' : 'red') : hue < 40 ? (l < 0.45 ? 'brown' : 'orange') : hue < 65 ? 'yellow'
        : hue < 160 ? 'green' : hue < 195 ? 'teal' : hue < 255 ? 'blue' : hue < 290 ? 'purple' : hue < 345 ? (l < 0.4 ? 'plum' : 'pink') : 'red';
    return `${shade}${name}`;
}

/** An image or video prompt with every colour code taken out — the code guard behind the prompt rule. Pure. */
export function withoutColourCodes(prompt: string): string {
    return prompt
        .replace(/\s*\(\s*#[0-9a-f]{3,8}\s*\)/gi, '')
        .replace(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,;])/g, '$1')
        .trim();
}

/** Who the picture is for and how it should look, as prompt lines. Pure. */
export function businessPromptLines(ctx: BriefContext): string[] {
    return [
        `BUSINESS: ${clip(ctx.orgName, 120)}${ctx.industry ? ` (${clip(ctx.industry, 80)})` : ''}`,
        ctx.description ? `ABOUT THEM: ${clip(ctx.description, 400)}` : '',
        // In words as well as codes: the codes are for the cards; an image prompt must use the words.
        `BRAND COLOURS (describe them in words in the prompts, never as codes): accent ${colourWords(ctx.kit.primaryColor)} (${ctx.kit.primaryColor}), ink ${colourWords(ctx.kit.textColor)} (${ctx.kit.textColor}), background ${colourWords(ctx.kit.backgroundColor)} (${ctx.kit.backgroundColor}).`,
        ...guidelinesPromptLines(ctx.guidelines),
    ].filter(Boolean);
}

/** An option's stored "<reason key>" or "<reason key>: <the user's words>" as a rejection. Pure. */
export function parseStoredRejection(source: string, stored: string, prompt: string | null): PastRejection {
    const [key, ...rest] = stored.split(':');
    return {
        source,
        reason: REJECT_REASON_LABELS[key as RejectReason] ?? key,
        note: rest.join(':').trim() || null,
        prompt,
    };
}

export function sourceLabel(source: string): string {
    if (source === FLYER_SOURCE) return FLYER_SOURCE_LABEL;
    return source === OWN_SOURCE ? OWN_SOURCE_LABEL : (SOURCE_SPECS[source as keyof typeof SOURCE_SPECS]?.label ?? source);
}

/** The pictures turned down earlier, newest last, as one prompt section ('' for none). Pure. */
export function rejectionPromptSection(rejections: PastRejection[]): string {
    if (!rejections.length) return '';
    return `TURNED DOWN EARLIER:\n${rejections.slice(-8).map((r) => `- a ${sourceLabel(r.source).toLowerCase()} option: ${r.reason}${r.note ? ` — "${clip(r.note, 200)}"` : ''}${r.prompt ? ` (it was made from: ${clip(r.prompt, 160)})` : ''}`).join('\n')}`;
}
