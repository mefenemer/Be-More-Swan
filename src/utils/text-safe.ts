// src/utils/text-safe.ts
// Cutting text without breaking it.
//
// ⚠️ Found on prod 2026-10-14: EVERY social draft for one workspace failed with Anthropic's
// "The request body is not valid JSON: unexpected end of hex escape". A caption that opens with an
// emoji was quoted into the drafting prompt cut at a fixed length with .slice(), which counts
// UTF-16 units, not characters, so the cut fell between the two halves of the emoji. JSON.stringify
// writes the orphaned half as "\ud83d" with no partner, and the API refuses the whole request. One
// emoji in one recent post was enough to stop all drafting, and every retry hit the same post.

/** A high (leading) surrogate with no low partner after it, or a low one with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove any half-emoji. Safe on any string; a no-op on well-formed text. */
export function stripLoneSurrogates(s: string): string {
    return s.replace(LONE_SURROGATE, '');
}

/** `s.slice(0, max)` that never cuts a character in half. */
export function safeSlice(s: string, max: number): string {
    if (s.length <= max) return s;
    const code = s.charCodeAt(max - 1);
    // The last unit kept is the first half of a pair: drop it rather than orphan it.
    return code >= 0xD800 && code <= 0xDBFF ? s.slice(0, max - 1) : s.slice(0, max);
}

/**
 * Deep-clean a value bound for a model (system prompt, messages, tool input): every string has its
 * half-emoji removed. The last line of defence for prompts assembled from many sources, any of
 * which may have cut something carelessly.
 */
export function sanitizeForModel<T>(value: T): T {
    if (typeof value === 'string') return stripLoneSurrogates(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => sanitizeForModel(v)) as unknown as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeForModel(v);
        return out as T;
    }
    return value;
}
