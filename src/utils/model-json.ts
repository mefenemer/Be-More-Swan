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
    // Last resort: the same candidates with raw control characters escaped inside strings. Models
    // writing long prose into a JSON string routinely emit a REAL line break between paragraphs,
    // which JSON forbids — the whole reply then failed to parse, and on the blog path that put the
    // raw `{"layout":[{"kind":…` on a customer's post (Restorative Futures, 2026-09-30).
    for (const c of candidates) {
        if (!c) continue;
        try {
            const parsed = JSON.parse(escapeControlCharsInStrings(c));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
        } catch { /* nothing recoverable */ }
    }
    return null;
}

/**
 * Escape raw newlines, carriage returns and tabs that sit INSIDE JSON string literals, leaving the
 * whitespace between tokens alone. String/escape aware, so an already-escaped `\n` is untouched.
 */
export function escapeControlCharsInStrings(text: string): string {
    let out = '';
    let inStr = false, escaped = false;
    for (const ch of text) {
        if (escaped) { escaped = false; out += ch; continue; }
        if (ch === '\\') { escaped = inStr; out += ch; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && ch === '\n') { out += '\\n'; continue; }
        if (inStr && ch === '\r') { out += '\\r'; continue; }
        if (inStr && ch === '\t') { out += '\\t'; continue; }
        out += ch;
    }
    return out;
}

/**
 * The COMPLETE elements of an array field, from a reply too damaged to parse whole — typically one
 * that ran out of tokens part-way through the last element. Every element that closed is kept and
 * parsed on its own; the unfinished tail is dropped. Returns null when the field isn't found or no
 * element survives.
 */
export function salvageArrayElements(raw: string, field: string): unknown[] | null {
    const text = stripCodeFences(raw);
    const at = text.search(new RegExp(`"${field}"\\s*:\\s*\\[`));
    if (at === -1) return null;
    const open = text.indexOf('[', at);
    const out: unknown[] = [];
    let depth = 0, inStr = false, escaped = false, start = -1;
    for (let i = open + 1; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = inStr; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') { if (depth++ === 0) start = i; }
        else if (ch === '}' && depth > 0 && --depth === 0 && start !== -1) {
            const piece = text.slice(start, i + 1);
            try { out.push(JSON.parse(piece)); }
            catch {
                try { out.push(JSON.parse(escapeControlCharsInStrings(piece))); } catch { /* skip one bad element */ }
            }
            start = -1;
        } else if (ch === ']' && depth === 0) break;
    }
    return out.length ? out : null;
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
