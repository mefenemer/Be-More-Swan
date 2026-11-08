// src/utils/site-source-page.ts — the words of ONE page of the owner's current website, for the
// chat's site_words card ("take the wording from my existing website").
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Prod 2026-11-08 (Restorative Futures, org 41): the import had left pages out, the chat added them
// empty, and when asked to "take the wording from my existing website" it said it couldn't copy words
// from their live site — paste them in. The import can read that page; one page could not be asked
// for. Now the site_words card names the page's address and the server reads it the same way the
// import does (robots.txt + SSRF fence, readImportPage), so the words are theirs by construction —
// never retyped by the model. Placement is then the ordinary site_words flow (proposeOwnWords).
//
// Only a page on THEIR website: the host must be their current website in the business details, or
// the site they imported from. Prices are left out, as the import leaves them out (they belong in
// Business Information ▸ Products & Services).

import { statesPrice, type ImportPage } from './site-extract';

/** www-insensitive host match. */
export function sameSiteHost(a: string, b: string): boolean {
    const h = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
    const x = h(a);
    return !!x && x === h(b);
}

/** Whether `url` is a page of one of `ownSites` (their website, the site they imported from). */
export function isOwnSitePage(url: string, ownSites: Array<string | null | undefined>): boolean {
    return ownSites.some((s) => !!s && sameSiteHost(url, s));
}

/**
 * The page's own words as plain text for wordsToBlocks: every heading, paragraph, list item and quote
 * in their order, a blank line between each, so each stays its own block. Pictures and buttons are
 * not words; a block stating a price is counted and left out.
 */
export function sourcePageText(page: Pick<ImportPage, 'blocks'>): { text: string; prices: number } {
    const out: string[] = [];
    let prices = 0;
    for (const b of page.blocks) {
        if (b.kind === 'image' || b.kind === 'button') continue;
        const t = b.text.trim();
        if (!t) continue;
        if (statesPrice(t)) { prices++; continue; }
        if (out[out.length - 1] !== t) out.push(t);
    }
    return { text: out.join('\n\n'), prices };
}
