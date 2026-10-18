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
 * Text a reader will see, shortened to at most `max` units without looking broken: never a
 * half-emoji, never half a word. It ends at a sentence when one ends late enough, otherwise at a
 * word with "…" so nobody mistakes the cut for the author's own ending.
 *
 * Found on prod 2026-10-18: a website's hero line ended "…connect to the tools y" because the
 * starter site and the site gate both cut with .slice().
 */
export function clampText(s: string, max: number): string {
    if (s.length <= max) return s;
    if (max < 2) return safeSlice(s, max);
    // A sentence that ends in the second half of the room is the cleanest place to stop. The probe
    // takes one unit more, so a full stop right at the limit still counts as followed by a space.
    const probe = s.slice(0, safeSlice(s, max).length + 1);
    let sentenceEnd = 0;
    for (const m of probe.matchAll(/[.!?]["'”’)]?(?=\s)/g)) sentenceEnd = m.index + m[0].length;
    if (sentenceEnd >= max / 2) return s.slice(0, sentenceEnd);
    // Otherwise the last whole word, leaving room for the ellipsis. One very long word is cut.
    const room = safeSlice(s, max - 1);
    const lastSpace = /\s/.test(s[room.length] ?? '') ? room.length : room.search(/\s\S*$/);
    const words = lastSpace >= max / 2 ? room.slice(0, lastSpace) : room;
    return `${words.trimEnd().replace(/[\s,;:–—-]+$/, '')}…`;
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
