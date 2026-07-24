// media-sources.ts — the per-assistant Media Source Selection model.
//
// An assistant stores aiAssistants.mediaSources as an ORDERED array of the sources it may use
// to obtain media for a post. Order = priority, membership = enabled. The resolver
// (media-resolver.ts) walks this list, trying each enabled source until one yields an asset
// (AC2.3 graceful fallback / AC3.1 priority matrix).
//
//   manual     → the org's own uploaded content library (content_assets, provider IS NULL)
//   stock      → AI Stock Search via Pexels (images + videos)
//   brand_card → a typographic card rendered in the org's brand kit (src/lib/brand-card.ts)
//   ai         → on-demand AI generation (Fal)

export type MediaSource = 'manual' | 'stock' | 'brand_card' | 'ai';

// AC3.1 default priority matrix: Check Manual Library → Search Pexels → Brand Card → Generate with AI.
//
// brand_card sits ahead of AI generation because it is free, deterministic and auto-publishable,
// and behind stock only nominally: the resolver ALTERNATES the two per post (see media-resolver),
// so a default assistant produces a feed that mixes photography with brand typography instead of
// one or the other. Only assistants with no stored preference get this — an assistant configured
// through onboarding keeps its explicit list untouched.
export const DEFAULT_ORDER: MediaSource[] = ['manual', 'stock', 'brand_card', 'ai'];

const VALID = new Set<MediaSource>(['manual', 'stock', 'brand_card', 'ai']);

// Coerce whatever is stored (or posted from the client) into a clean, de-duped, ordered list of
// valid sources. Unknown/garbage values are dropped; null/empty falls back to the default matrix
// so an assistant always has at least one working source.
export function normalizeMediaSources(raw: unknown): MediaSource[] {
    if (!Array.isArray(raw)) return [...DEFAULT_ORDER];
    const seen = new Set<MediaSource>();
    const out: MediaSource[] = [];
    for (const v of raw) {
        if (typeof v !== 'string') continue;
        // Accept the hyphenated spelling too: it is the natural thing to type in an API payload,
        // and silently dropping it would disable the source with no error anywhere.
        const s = v.toLowerCase().replace(/-/g, '_') as MediaSource;
        if (VALID.has(s) && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out.length ? out : [...DEFAULT_ORDER];
}

export const MEDIA_SOURCE_LABELS: Record<MediaSource, string> = {
    manual: 'Manual Upload',
    stock: 'AI Stock Search',
    brand_card: 'Branded Text Card',
    ai: 'AI Generation',
};
