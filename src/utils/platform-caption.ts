// src/utils/platform-caption.ts
// Fit one generated idea to a specific platform.
//
// The autopilot fan-out generates ONE caption/idea and ships it to every target platform. LinkedIn,
// Facebook and Instagram tolerate a long-form essay; X (280 chars) and Threads (500) do not — a
// LinkedIn-length post pasted to X is truncated/rejected, and a 10-hashtag block reads as spam there.
// This turns the single generated idea into a post that fits the platform:
//   • short-form platforms get the model's short caption variant (or a derived trim), hard-clamped so
//     caption + disclosure footer + hashtags stays under the platform limit — the footer (a legal
//     requirement) is NEVER dropped or truncated;
//   • hashtags are de-duplicated, acronym-cased, and capped to a platform-appropriate count.

import { appendFooter } from './disclosure-footer';

export const SHORT_FORM_PLATFORMS = new Set(['x', 'threads']);
export function isShortForm(platform: string | null | undefined): boolean {
    return SHORT_FORM_PLATFORMS.has((platform || '').toLowerCase());
}

// Hard character ceilings. The publisher joins caption + hashtags with a blank line and BOTH count
// toward the platform limit, so these are the budget for the whole assembled post. Long-form
// platforms are generous enough that we don't actively trim them.
const TEXT_LIMIT: Record<string, number> = { x: 280, threads: 500 };
export function platformTextLimit(platform: string | null | undefined): number {
    return TEXT_LIMIT[(platform || '').toLowerCase()] ?? 3000;
}

// Hashtag count cap per platform. Short-form platforms want 1–2; long-form can carry a fuller set.
function hashtagCap(platform: string | null | undefined): number {
    return isShortForm(platform) ? 2 : 10;
}

// Whole-tag acronym casing so a free-generated "#ai"/"#seo"/"#saas" lands as the brand-correct form.
// Only applied when the ENTIRE tag is the acronym — never mangles embedded text (e.g. "#SaasFatigue"
// is left alone rather than risk a wrong edit).
const ACRONYM_CASE: Record<string, string> = {
    ai: 'AI', seo: 'SEO', saas: 'SaaS', b2b: 'B2B', b2c: 'B2C', d2c: 'D2C', roi: 'ROI',
    crm: 'CRM', sme: 'SME', smes: 'SMEs', kpi: 'KPI', ceo: 'CEO', ux: 'UX', ui: 'UI',
    diy: 'DIY', faq: 'FAQ', uk: 'UK', usa: 'USA', us: 'US',
};

/** De-dupe (case-insensitive), acronym-case, and cap a raw hashtag string for one platform. */
export function normalizeHashtags(raw: string | null | undefined, platform: string | null | undefined): string {
    if (!raw) return '';
    const seen = new Set<string>();
    const out: string[] = [];
    for (const token of String(raw).split(/[\s,]+/)) {
        const tag = token.replace(/^#+/, '').trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push('#' + (ACRONYM_CASE[key] ?? tag));
    }
    return out.slice(0, hashtagCap(platform)).join(' ');
}

// Fallback when the model didn't return a short variant: take the opening of the long caption up to a
// sentence/word boundary, and re-attach any URL it contained (the CTA link must survive the trim).
function deriveShort(longCaption: string, budget: number): string {
    const url = (longCaption.match(/https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co|io|ai|app)\b\S*/i) || [])[0] || '';
    const urlTail = url ? ` ${url}` : '';
    const room = Math.max(0, budget - urlTail.length);
    let body = longCaption.replace(/\s+/g, ' ').trim();
    if (body.length > room) {
        body = body.slice(0, room);
        // Prefer to end on a sentence, else a word boundary — never mid-word.
        const lastStop = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '));
        body = lastStop > room * 0.5 ? body.slice(0, lastStop + 1) : body.replace(/\s+\S*$/, '');
    }
    return (body + urlTail).trim();
}

// Trim a body so that `body + footer + credit` fits `limit`, preserving the footer and credit in full.
function clampBodyPreservingFooter(body: string, footer: string | null, credit: string, limit: number): string {
    const reserved = (footer ? footer.length + 2 : 0) + credit.length; // +2 for the "\n\n" separator
    const room = Math.max(0, limit - reserved);
    let b = body.trim();
    if (b.length > room) b = b.slice(0, room).replace(/\s+\S*$/, '').trim();
    return appendFooter(b, footer) + credit;
}

export interface FitInput {
    platform: string;
    longCaption: string;              // full caption body, WITHOUT footer
    shortCaption?: string | null;     // model's short variant, WITHOUT footer (may be absent)
    hashtagsRaw?: string | null;
    footer: string | null;            // disclosure footer — legal, never dropped
    creditSuffix?: string;            // e.g. Pexels photographer credit, appended after the footer
}

/**
 * Assemble a platform-fit `{ caption, hashtags }` from one generated idea. Long-form platforms get the
 * full caption; short-form platforms get the short variant (or a derived trim), guaranteed to fit the
 * platform's character limit with the footer intact.
 */
export function fitForPlatform(input: FitInput): { caption: string; hashtags: string } {
    const { platform, longCaption, footer } = input;
    const credit = input.creditSuffix ?? '';
    const hashtags = normalizeHashtags(input.hashtagsRaw, platform);

    if (!isShortForm(platform)) {
        return { caption: appendFooter(longCaption, footer) + credit, hashtags };
    }

    const limit = platformTextLimit(platform);
    // Budget the body: leave room for footer, credit, and the hashtag line the publisher appends.
    const footerLen = footer ? footer.length + 2 : 0;
    const tagLen = hashtags ? hashtags.length + 2 : 0;
    const bodyBudget = Math.max(40, limit - footerLen - credit.length - tagLen);

    let body = (input.shortCaption?.trim() || deriveShort(longCaption, bodyBudget));
    if (body.length > bodyBudget) body = deriveShort(body, bodyBudget);

    let caption = appendFooter(body, footer) + credit;
    let tags = hashtags;

    // Defensive final clamp (the model can overrun its instructed length): shed hashtags first, then
    // trim the body — the footer and credit always survive.
    const combined = (c: string, h: string) => (h ? `${c}\n\n${h}`.length : c.length);
    if (combined(caption, tags) > limit) {
        tags = '';
        if (caption.length > limit) caption = clampBodyPreservingFooter(body, footer, credit, limit);
    }
    return { caption, hashtags: tags };
}
