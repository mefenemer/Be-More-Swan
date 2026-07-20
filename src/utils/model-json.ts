// src/utils/model-json.ts
// Shared, hardened extraction of a JSON object out of a model reply.
//
// Why this exists: the generation seams used to do `rawText.match(/\{[\s\S]*\}/)` +
// JSON.parse, and on a throw fell back to `caption: rawText`. When the model wrapped its
// reply in a ```json fence with prose around it — or ran out of tokens mid-object — the
// parse failed and the ENTIRE raw reply (fence, braces, `"caption":`, literal \n escapes)
// was persisted as the post caption and shown to users on the dashboard and review queue.
//
// The rules here: strip fences, parse with brace balancing (string/escape aware), and if
// the object is unrecoverable still never hand back JSON scaffolding as human-facing copy.

/** Remove a leading ```json / ``` fence and its closing fence, plus surrounding whitespace. */
export function stripCodeFences(raw: string): string {
    return String(raw ?? '')
        .trim()
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
}

/**
 * Slice out the first balanced `{…}` object, honouring quoted strings and escapes so a
 * brace inside a caption doesn't truncate the object. Returns null when no `{` is present
 * or the object never closes (a truncated reply).
 */
function balancedObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

/**
 * Parse a model reply into an object. Tries, in order: the whole (de-fenced) reply, the
 * first balanced object, then the widest `{…}` span. Returns null if none parse — callers
 * decide what a missing object means rather than getting a half-populated one.
 */
export function parseModelJson<T = Record<string, unknown>>(raw: string): T | null {
    const text = stripCodeFences(raw);
    if (!text) return null;

    const candidates = [text, balancedObject(text)];
    const greedy = text.match(/\{[\s\S]*\}/);
    if (greedy) candidates.push(greedy[0]);

    for (const c of candidates) {
        if (!c) continue;
        try {
            const parsed = JSON.parse(c);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
        } catch { /* try the next candidate */ }
    }
    return null;
}

/**
 * Slice out the first balanced `[…]` array, honouring quoted strings and escapes.
 * Returns null when no `[` is present or the array never closes.
 */
function balancedArray(text: string): string | null {
    const start = text.indexOf('[');
    if (start === -1) return null;
    let depth = 0, inStr = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') depth++;
        else if (ch === ']' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

/**
 * Array counterpart to parseModelJson, for the prompts that ask for a top-level list.
 * Returns null (never a partial list) when nothing parses.
 */
export function parseModelJsonArray<T = unknown>(raw: string): T[] | null {
    const text = stripCodeFences(raw);
    if (!text) return null;

    const candidates = [text, balancedArray(text)];
    const greedy = text.match(/\[[\s\S]*\]/);
    if (greedy) candidates.push(greedy[0]);

    for (const c of candidates) {
        if (!c) continue;
        try {
            const parsed = JSON.parse(c);
            if (Array.isArray(parsed)) return parsed as T[];
        } catch { /* try the next candidate */ }
    }
    return null;
}

/** JSON-unescape a raw string body (the bit between the quotes) without needing it terminated. */
function unescapeJsonString(body: string): string {
    try {
        return JSON.parse(`"${body}"`) as string;
    } catch {
        // Truncated reply: the tail may end mid-escape. Drop a dangling backslash and retry,
        // then fall back to hand-unescaping the escapes we actually emit in prompts.
        const trimmed = body.replace(/\\+$/, '');
        try { return JSON.parse(`"${trimmed}"`) as string; } catch { /* hand-roll below */ }
        return trimmed
            .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
            .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

/**
 * Best-effort recovery of one string field from a reply whose JSON did not parse — used both
 * as the write-time fallback and to repair rows already persisted with raw JSON in them.
 * Handles the truncated case (opening quote, no closing quote) too.
 */
export function salvageStringField(raw: string, field: string): string | null {
    const text = stripCodeFences(raw);
    const closed = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(text);
    if (closed) return unescapeJsonString(closed[1]).trim() || null;

    const open = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*)$`).exec(text);
    if (open) return unescapeJsonString(open[1]).trim() || null;

    return null;
}

/**
 * Turn any model reply into caption copy that is safe to show a user. Prefers the parsed
 * `caption`, then a salvaged one, and only as a last resort the de-fenced prose — never a
 * JSON blob. Returns '' when nothing human-readable can be recovered.
 */
export function toCaptionText(raw: string): string {
    const parsed = parseModelJson<{ caption?: unknown }>(raw);
    if (parsed && typeof parsed.caption === 'string' && parsed.caption.trim()) return parsed.caption.trim();

    const salvaged = salvageStringField(raw, 'caption');
    if (salvaged) return salvaged;

    const text = stripCodeFences(raw);
    // Still JSON-shaped with no recoverable caption — showing braces is worse than showing nothing.
    if (/^\s*[{[]/.test(text)) return '';
    return text;
}

/**
 * Read-time repair for captions already stored in the DB. Text that never was JSON passes
 * through untouched; a stored raw reply is unwrapped to its caption.
 */
export function displayCaption(stored: string | null | undefined): string {
    const text = String(stored ?? '').trim();
    if (!text) return '';
    // Fast path: the overwhelming majority of rows are plain captions.
    if (!/^```|^\s*\{/.test(text)) return text;
    return toCaptionText(text) || text;
}
