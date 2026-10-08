// src/config/visual-brief-vocab.ts
// The Brand Designer's words — what a brief can be for, which sources can answer it, why an option
// gets turned down — and the one normaliser every brief passes through, whichever surface wrote it.
// docs/brand-designer-plan.md §4.
//
// ONE normaliser, shared by the Briefs tab, the chat card and (Phase 3) a campaign's commission, so a
// brief means the same thing whichever door it came in by. The browser never keeps its own copy of
// these lists: brand-briefs.ts sends them with every `list` response.

import { IMAGE_CREDIT_COST } from '../utils/ai-credits';

export const BRIEF_PURPOSES = ['social_post', 'blog_header', 'ad', 'email_header', 'story', 'other'] as const;
export type BriefPurpose = typeof BRIEF_PURPOSES[number];

export const BRIEF_ASPECT_RATIOS = ['1:1', '4:5', '16:9', '9:16'] as const;
export type BriefAspectRatio = typeof BRIEF_ASPECT_RATIOS[number];

/** A purpose suggests a shape; the user can always override it. */
export const PURPOSE_SPECS: Record<BriefPurpose, { label: string; aspectRatio: BriefAspectRatio }> = {
    social_post:  { label: 'Social post',              aspectRatio: '1:1' },
    blog_header:  { label: 'Blog header',              aspectRatio: '16:9' },
    ad:           { label: 'Advert',                   aspectRatio: '1:1' },
    email_header: { label: 'Email header',             aspectRatio: '16:9' },
    story:        { label: 'Story / Reel cover',       aspectRatio: '9:16' },
    other:        { label: 'Something else',           aspectRatio: '1:1' },
};

export const ASPECT_LABELS: Record<BriefAspectRatio, string> = {
    '1:1': 'Square (1:1)',
    '4:5': 'Portrait (4:5)',
    '16:9': 'Landscape (16:9)',
    '9:16': 'Tall (9:16)',
};

/**
 * Where options can come from in Phase 1. AI video, Canva and "a person makes it" are Phase 4.
 *
 * ⚠️ The cost line is a promise the card and the tab both print before the click. It must stay true
 * of what generate-brief-options-background.ts charges: AI images are ONE credit per round, and a
 * round returns several variations (the same rule as generate-ai-image — the credit buys the grid).
 */
export const BRIEF_SOURCES = ['stock', 'ai_image', 'brand_card'] as const;
export type BriefSource = typeof BRIEF_SOURCES[number];

export const SOURCE_SPECS: Record<BriefSource, { label: string; cost: string; optionsPerRound: number; credits: number }> = {
    stock:      { label: 'Stock photos',  cost: 'Free (Pexels)',                                         optionsPerRound: 4, credits: 0 },
    ai_image:   { label: 'AI images',     cost: `${IMAGE_CREDIT_COST} AI credit for 4 images`,          optionsPerRound: 4, credits: IMAGE_CREDIT_COST },
    brand_card: { label: 'Branded cards', cost: 'Free — your colours, font and logo',                   optionsPerRound: 2, credits: 0 },
};

/** Credits one round of this brief will hold. Only AI costs anything. */
export function roundCreditCost(sources: readonly string[]): number {
    return sources.reduce((n, s) => n + (SOURCE_SPECS[s as BriefSource]?.credits ?? 0), 0);
}

/**
 * Why an option was turned down. The reason is fed into the NEXT round's art direction, so each one
 * must say something the designer can act on — "other" carries the user's own words instead.
 */
export const REJECT_REASONS = ['off_brand', 'wrong_subject', 'looks_fake', 'text_wrong', 'too_busy', 'other'] as const;
export type RejectReason = typeof REJECT_REASONS[number];
export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
    off_brand: 'Off-brand',
    wrong_subject: 'Wrong subject',
    looks_fake: 'Looks fake or stock-y',
    text_wrong: 'Wrong words on it',
    too_busy: 'Too busy',
    other: 'Something else',
};

export const BRIEF_STATUSES = ['open', 'generating', 'in_review', 'approved', 'cancelled'] as const;
export type BriefStatus = typeof BRIEF_STATUSES[number];

/** A round may run this long before it is called failed and its credit refunded. */
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
/** Rounds per brief. A brief that has not landed in six rounds needs a different brief. */
export const MAX_ROUNDS = 6;

export interface NormalisedBrief {
    title: string;
    purpose: BriefPurpose;
    aspectRatio: BriefAspectRatio;
    message: string | null;
    headline: string | null;
    mood: string | null;
    mustInclude: string | null;
    mustAvoid: string | null;
    sources: BriefSource[];
    dueDate: string | null;
}

function text(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
}

/**
 * Turn an untrusted brief (a form, or a chat card the model wrote) into one the system can run.
 * Returns an error string instead when it cannot be run at all — never a half-brief.
 *
 * - A brief must say SOMETHING about the picture: a message or words for a card. A title alone is a
 *   label, and generating from it spends the user's credit on a guess.
 * - Unknown sources are dropped, not refused; NO valid source is refused (it would produce nothing).
 * - A free-text due date is never guessed into a date.
 */
export function normaliseBrief(raw: Record<string, unknown>): { ok: true; brief: NormalisedBrief } | { ok: false; error: string } {
    const title = text(raw.title, 120);
    const message = text(raw.message, 1000);
    const headline = text(raw.headline, 120);
    if (!title) return { ok: false, error: 'Give the brief a short name.' };
    if (!message && !headline) return { ok: false, error: 'Say what the picture should show, or the words it should carry.' };

    const purpose = (BRIEF_PURPOSES as readonly string[]).includes(String(raw.purpose)) ? raw.purpose as BriefPurpose : 'social_post';
    const aspectRatio = (BRIEF_ASPECT_RATIOS as readonly string[]).includes(String(raw.aspectRatio))
        ? raw.aspectRatio as BriefAspectRatio
        : PURPOSE_SPECS[purpose].aspectRatio;

    const asked = Array.isArray(raw.sources) ? raw.sources.map(String) : [...BRIEF_SOURCES];
    const sources = BRIEF_SOURCES.filter((s) => asked.includes(s));
    if (!sources.length) return { ok: false, error: 'Choose at least one place for the options to come from.' };

    const due = typeof raw.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate.trim()) ? raw.dueDate.trim() : null;

    return {
        ok: true,
        brief: {
            title, purpose, aspectRatio, message, headline,
            mood: text(raw.mood, 300),
            mustInclude: text(raw.mustInclude, 500),
            mustAvoid: text(raw.mustAvoid, 500),
            sources,
            dueDate: due,
        },
    };
}

/** Everything the browser needs to draw the form and the grid — sent with `list`, never hand-copied. */
export function briefVocabForClient() {
    return {
        purposes: BRIEF_PURPOSES.map((k) => ({ key: k, ...PURPOSE_SPECS[k] })),
        aspectRatios: BRIEF_ASPECT_RATIOS.map((k) => ({ key: k, label: ASPECT_LABELS[k] })),
        sources: BRIEF_SOURCES.map((k) => ({ key: k, ...SOURCE_SPECS[k] })),
        rejectReasons: REJECT_REASONS.map((k) => ({ key: k, label: REJECT_REASON_LABELS[k] })),
        maxRounds: MAX_ROUNDS,
    };
}
