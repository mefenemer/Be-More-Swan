// media-sources.ts — the per-assistant Media Source Selection model.
//
// An assistant stores aiAssistants.mediaSources as an ORDERED array of the sources it may use
// to obtain media for a post. Order = priority, membership = enabled. The resolver
// (media-resolver.ts) walks this list, trying each enabled source until one yields an asset
// (AC2.3 graceful fallback / AC3.1 priority matrix).
//
//   manual → the org's own uploaded content library (content_assets, provider IS NULL)
//   stock  → AI Stock Search via Pexels (images + videos)
//   ai     → on-demand AI generation (Fal)

export type MediaSource = 'manual' | 'stock' | 'ai';

// AC3.1 default priority matrix: Check Manual Library → Search Pexels → Generate with AI.
export const DEFAULT_ORDER: MediaSource[] = ['manual', 'stock', 'ai'];

const VALID = new Set<MediaSource>(['manual', 'stock', 'ai']);

// Coerce whatever is stored (or posted from the client) into a clean, de-duped, ordered list of
// valid sources. Unknown/garbage values are dropped; null/empty falls back to the default matrix
// so an assistant always has at least one working source.
export function normalizeMediaSources(raw: unknown): MediaSource[] {
    if (!Array.isArray(raw)) return [...DEFAULT_ORDER];
    const seen = new Set<MediaSource>();
    const out: MediaSource[] = [];
    for (const v of raw) {
        if (typeof v !== 'string') continue;
        const s = v.toLowerCase() as MediaSource;
        if (VALID.has(s) && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out.length ? out : [...DEFAULT_ORDER];
}

export const MEDIA_SOURCE_LABELS: Record<MediaSource, string> = {
    manual: 'Manual Upload',
    stock: 'AI Stock Search',
    ai: 'AI Generation',
};
