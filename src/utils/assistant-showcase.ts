// src/utils/assistant-showcase.ts
// The shape of an assistant's public page content (assistant_showcases.content — rendered by
// assistant.html), and the one function that cleans what an admin saves.
//
// Admin ▸ Assistants ▸ Website page writes through normaliseShowcase (admin-assistants.ts
// ?action=showcase). The seed is db/assistant-showcases.json → db/z-assistant-showcases.sql, which
// passes through the same shape. Pure — tested without a database.

export interface ShowcaseStep { title: string; body: string }
export interface ShowcaseFeature { title: string; body: string; image?: string; alt?: string }
export interface ShowcaseFaq { q: string; a: string }
export interface Showcase {
    headline: string;
    overview: string[];
    highlights: string[];
    steps: ShowcaseStep[];
    features: ShowcaseFeature[];
    faqs: ShowcaseFaq[];
}

export const SHOWCASE_LIMITS = {
    headline: 160, paragraph: 1200, overview: 4, highlight: 60, highlights: 6,
    title: 120, body: 800, steps: 6, features: 8, faqs: 12, url: 500,
} as const;

const str = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const para = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/**
 * Only our own paths or https — the page puts these in <img src>, and an admin-typed
 * `javascript:` or `data:` URL must never reach it. assistant.html checks again (safeUrl).
 */
export function cleanImageUrl(v: unknown): string {
    const u = String(v ?? '').trim().slice(0, SHOWCASE_LIMITS.url);
    return /^(\/(?!\/)|https:\/\/)/.test(u) ? u : '';
}

export type NormaliseResult = { ok: true; showcase: Showcase } | { ok: false; error: string };

export function normaliseShowcase(raw: unknown): NormaliseResult {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Nothing to save.' };
    const r = raw as Record<string, unknown>;
    const L = SHOWCASE_LIMITS;
    const list = (v: unknown) => (Array.isArray(v) ? v : []);

    const showcase: Showcase = {
        headline: str(r.headline, L.headline),
        overview: list(r.overview).map((p) => para(p, L.paragraph)).filter(Boolean).slice(0, L.overview),
        highlights: list(r.highlights).map((h) => str(h, L.highlight)).filter(Boolean).slice(0, L.highlights),
        steps: list(r.steps).map((s) => ({ title: str((s as ShowcaseStep)?.title, L.title), body: para((s as ShowcaseStep)?.body, L.body) }))
            .filter((s) => s.title).slice(0, L.steps),
        features: list(r.features).map((f) => {
            const x = (f || {}) as ShowcaseFeature;
            const out: ShowcaseFeature = { title: str(x.title, L.title), body: para(x.body, L.body) };
            const image = cleanImageUrl(x.image);
            if (image) { out.image = image; out.alt = str(x.alt, L.title) || out.title; }
            return out;
        }).filter((f) => f.title).slice(0, L.features),
        faqs: list(r.faqs).map((f) => ({ q: str((f as ShowcaseFaq)?.q, L.title), a: para((f as ShowcaseFaq)?.a, L.body) }))
            .filter((f) => f.q && f.a).slice(0, L.faqs),
    };

    if (!showcase.headline) return { ok: false, error: 'Add a headline — it is the first line a visitor reads.' };
    // A feature whose image was refused is saved without one rather than failing the save — but say so.
    const dropped = list(r.features).filter((f) => {
        const img = String((f as ShowcaseFeature)?.image ?? '').trim();
        return img && !cleanImageUrl(img);
    }).length;
    if (dropped) return { ok: false, error: `${dropped} screenshot link${dropped === 1 ? ' is' : 's are'} not allowed — use an uploaded image, a /path on our site, or an https:// link.` };
    return { ok: true, showcase };
}

/** Where admin-uploaded screenshots live in R2, and the public URL that serves one. */
export const SHOWCASE_MEDIA_PREFIX = 'showcase/';
export const SHOWCASE_KEY_RE = /^showcase\/[a-z][a-z0-9_]{1,60}\/[a-z0-9-]{8,80}\.(png|jpe?g|webp)$/;
export const showcaseMediaUrl = (key: string) => `/.netlify/functions/showcase-media?key=${encodeURIComponent(key)}`;
