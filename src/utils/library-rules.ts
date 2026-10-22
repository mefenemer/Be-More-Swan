// src/utils/library-rules.ts
// The rules for adding to an assistant's Knowledge Base (kb-articles.ts) and Inspo (inspo-items.ts),
// in one place so the chat's confirm cards (src/utils/chat-library.ts) check a proposal by exactly the
// rules the endpoint will apply to the click — a card must never offer a button its endpoint refuses.

export const KB_MAX_TITLE_CHARS = 300;
/** Big enough for a long policy doc; a bigger corpus should be split into articles. */
export const KB_MAX_CONTENT_CHARS = 50_000;
/** Per-assistant article ceiling — keeps ingestion and the tab listing bounded. */
export const KB_MAX_ARTICLES = 200;

export const INSPO_MAX_TITLE_CHARS = 300;
/** The user's "what I like about this" note — a paragraph of guidance, not an essay. */
export const INSPO_MAX_NOTE_CHARS = 2_000;
export const INSPO_MAX_BODY_CHARS = 50_000;
/** Per-assistant ceiling. Bounds STORAGE, not prompt size (distilled profile + top-K retrieval). */
export const INSPO_MAX_ITEMS = 200;

/** A typed note's title: its first line, cut to 60 characters. */
export function deriveInspoTitle(body: string): string {
    const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || 'Untitled note';
    return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
}

/**
 * Validate a user-supplied inspo URL at save time.
 *
 * Deliberately shape-only — no network. The real SSRF enforcement happens in safeFetchText()
 * inside the worker, at connect time, where it can't be raced by DNS. Checking here is purely
 * so an obviously-bad link fails in the composer with a clear message rather than silently
 * turning into a 'failed' card a minute later.
 */
export function validateInspoUrl(raw: string): { url: string } | { error: string } {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return { error: "That doesn't look like a valid link." }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'Only http and https links can be added.' };
    }
    if (parsed.username || parsed.password) {
        return { error: 'Links with embedded credentials are not supported.' };
    }
    // Google Docs links are login walls, not documents: fetching one returns a sign-in page,
    // which would ingest as garbage and quietly teach the assistant nothing. Real support
    // needs Drive OAuth (out of scope) — so say so plainly instead of failing mysteriously.
    if (/(^|\.)docs\.google\.com$/i.test(parsed.hostname)) {
        return { error: 'Google Docs links need sign-in, so we can\'t read them. Download the doc and upload the file instead.' };
    }
    return { url: parsed.toString() };
}
