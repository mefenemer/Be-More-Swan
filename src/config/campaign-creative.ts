// src/config/campaign-creative.ts
// A campaign's tone of voice and its own visuals. docs/campaign-orchestrator-plan.md §9.3.
//
// Pure and import-free, like campaign-audience.ts: campaigns.ts, the blueprint, the media resolver
// and the chat all apply the same limits, and a second copy is how one surface saves a tone
// another silently truncates.
//
// ── Why a campaign tone at all ───────────────────────────────────────────────
// "Use the holiday brand guidelines." The brand kit is one per workspace, and a Q3 launch needs a
// voice for six weeks without rewriting the brand for everything else. So the campaign carries a
// short tone that drafting reads INSIDE the brand voice — it narrows, it never replaces (the
// directive says so explicitly). A per-campaign brand kit variant was considered and deferred:
// tone + the campaign's own pictures cover the stated need without a second kit to keep in sync.

export const CAMPAIGN_TONE_MAX = 300;
/** More pictures than this is a library, not a campaign's visual identity. */
export const MAX_CAMPAIGN_ASSETS = 30;

/** A tone as stored: trimmed, capped, or null when nothing was said. */
export function normaliseTone(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, CAMPAIGN_TONE_MAX) : null;
}

/** Positive integer ids, de-duplicated and capped. Junk is dropped, never coerced. */
export function normaliseAssetIds(raw: unknown, max = MAX_CAMPAIGN_ASSETS): number[] {
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const v of raw) {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * What a campaign asset counts as, for everything downstream that cares where media came from —
 * above all the auto-publish gate, where AI imagery must NEVER qualify. Read from the asset's own
 * provider, never assumed: a campaign can hold an AI image someone generated earlier, and calling
 * it 'manual' because it sits in a campaign would let it publish unattended.
 * ⚠️ An UNKNOWN provider is treated as 'ai' — the direction that fails safe.
 */
export function mediaSourceForProvider(provider: string | null | undefined): 'manual' | 'stock' | 'brand_card' | 'ai' {
    if (provider == null || provider === '' || provider === 'canva') return 'manual';
    if (provider === 'pexels') return 'stock';
    if (provider === 'brand_card') return 'brand_card';
    return 'ai';
}
