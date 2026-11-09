// src/utils/site-rich-text.ts — the little markup a hosted site's text may carry (2026-11-08).
//
// Text on a hosted site is plain text, escaped when drawn. Two things plain text could not say, both
// found missing on imported sites (Restorative Futures):
//   · a link inside a sentence:  "Read our [course notes](/building-relationships) first."
//   · a subheading inside a text section, on a line of its own:  "### Who it's for"
// Nothing else is markup — no HTML, no bold, no pictures. Links are drawn only through the same gate
// as every button (cleanHref: https, mailto, tel, #anchor or one of the site's own pages), and a link
// to a page that doesn't exist is drawn as its words alone.
//
// "[words]" with no "(address)" after it stays what it always was: a placeholder the owner fills in.

/** [label](href) — label on one line, no brackets inside; href with no spaces or brackets. */
export const INLINE_LINK = /\[([^\]\[\n]{1,80})\]\(([^()\s]{1,500})\)/g;
/** A [placeholder]: square brackets NOT followed by "(" (that is a link). */
export const PLACEHOLDER = /\[[^\][]{1,60}\](?!\()/g;
/** A subheading line inside a text body. */
export const SUBHEADING = /^###\s+(.{1,120})$/;

/** The words alone: links become their labels, subheading marks go. For word counts and checks. */
export function plainOf(text: string): string {
    return text.replace(INLINE_LINK, '$1').split('\n').map((l) => l.replace(/^###\s+/, '')).join('\n');
}

/** Every link's address rewritten by `fn` (null = keep the words, drop the link). */
export function mapInlineLinks(text: string, fn: (href: string) => string | null): string {
    return text.replace(INLINE_LINK, (_m, label: string, href: string) => {
        const to = fn(href);
        return to ? `[${label}](${to})` : label;
    });
}

/** The words with one link put on the first place `label` appears (not already inside a link). */
export function linkFirst(text: string, label: string, href: string): string {
    if (!label.trim() || /[\[\]()]/.test(label) || /[\s()]/.test(href)) return text;
    // Only outside existing links: split the text on them and look in the plain stretches.
    const parts = text.split(/(\[[^\]\[\n]{1,80}\]\([^()\s]{1,500}\))/);
    for (let i = 0; i < parts.length; i += 2) {
        const at = parts[i].indexOf(label);
        if (at >= 0) {
            parts[i] = `${parts[i].slice(0, at)}[${label}](${href})${parts[i].slice(at + label.length)}`;
            return parts.join('');
        }
    }
    return text;
}

/** Every string inside a section's props, rewritten (for link moves when pages are combined or split). */
export function mapPropStrings<T>(value: T, fn: (s: string) => string): T {
    if (typeof value === 'string') return fn(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => mapPropStrings(v, fn)) as unknown as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapPropStrings(v, fn)])) as T;
    }
    return value;
}
