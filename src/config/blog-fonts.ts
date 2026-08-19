// src/config/blog-fonts.ts
//
// The fonts a Blog Writer can set on their published blog (Blog Studio ▸ Widget ▸ Font family).
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The picker used to offer three hardcoded options — System, Georgia, Inter — and, worse, NOTHING
// ever loaded a webfont. `theme.fontFamily` was written straight into a `font-family:` declaration
// and that was the end of it, so "Inter" silently fell back to whatever the *reader* happened to
// have installed. Two of the three choices were therefore indistinguishable on most machines.
//
// A font is only really chosen when the page also fetches it, so a family here carries BOTH halves:
// the CSS stack, and the Google Fonts stylesheet URL that makes the stack mean something.
//
// ── The contract with the browser ───────────────────────────────────────────────────────────────
// `theme.fontFamily` (the stack) and `theme.fontUrl` (the stylesheet) are stored together on
// widget_configs.theme. Three surfaces read them, and all three must agree:
//   · widget.js        — the embed on the customer's own site
//   · blog-seo.ts      — the server-rendered /b/:key/:slug permalink
//   · blog-studio-modal.js — the picker, via window.BlogFonts (generated; see below)
// save-widget-config.ts validates BOTH against this file before storing, so a stack can never
// arrive that the two renderers don't recognise, and fontUrl can only ever be a Google Fonts URL.
//
// ⚠️ The browser copy is GENERATED — `npm run gen:constants`, committed, no build step on deploy.
// Never hand-copy a family into blog-studio-modal.js; that is exactly the drift
// scripts/gen-client-constants.ts exists to make impossible.

export interface BlogFont {
    /** Display name in the picker. */
    label: string;
    /** The CSS font-family stack written into the published page. Also the STORED value. */
    stack: string;
    /** Grouping in the picker. */
    category: 'System' | 'Sans serif' | 'Serif' | 'Display' | 'Monospace';
    /**
     * The Google Fonts family name, or null for a font that needs no download (a system stack, or
     * a face like Georgia that ships with the OS). A null here means fontUrl is null too.
     */
    google: string | null;
    /**
     * Weights to request. Body copy needs 400, and **700 is not optional** — without it the browser
     * synthesises bold by smearing the regular face, which is the tell-tale look of a broken
     * webfont setup. Narrowed only for display faces that genuinely ship one weight.
     */
    weights?: string;
}

const DEFAULT_WEIGHTS = '400;700';

/**
 * Ordered as the picker renders it. The first entry is the fallback for anything unrecognised, so
 * it must stay a system stack that needs no network at all.
 */
export const BLOG_FONTS: readonly BlogFont[] = [
    // ── System (no download) ────────────────────────────────────────────────
    { label: 'System default', stack: 'system-ui, sans-serif', category: 'System', google: null },
    { label: 'Georgia', stack: 'Georgia, serif', category: 'System', google: null },
    { label: 'Helvetica / Arial', stack: 'Helvetica, Arial, sans-serif', category: 'System', google: null },
    { label: 'Times New Roman', stack: '"Times New Roman", Times, serif', category: 'System', google: null },

    // ── Sans serif ──────────────────────────────────────────────────────────
    // 'Inter' keeps its historic stack string EXACTLY, quotes and all: it is already stored in live
    // widget_configs rows, and the validator matches on the stack. Changing it would invalidate
    // every blog that has already picked it.
    { label: 'Inter', stack: "'Inter', sans-serif", category: 'Sans serif', google: 'Inter' },
    { label: 'Roboto', stack: "'Roboto', sans-serif", category: 'Sans serif', google: 'Roboto' },
    { label: 'Open Sans', stack: "'Open Sans', sans-serif", category: 'Sans serif', google: 'Open Sans' },
    { label: 'Lato', stack: "'Lato', sans-serif", category: 'Sans serif', google: 'Lato' },
    { label: 'Montserrat', stack: "'Montserrat', sans-serif", category: 'Sans serif', google: 'Montserrat' },
    { label: 'Poppins', stack: "'Poppins', sans-serif", category: 'Sans serif', google: 'Poppins' },
    { label: 'Raleway', stack: "'Raleway', sans-serif", category: 'Sans serif', google: 'Raleway' },
    { label: 'Nunito', stack: "'Nunito', sans-serif", category: 'Sans serif', google: 'Nunito' },
    { label: 'Nunito Sans', stack: "'Nunito Sans', sans-serif", category: 'Sans serif', google: 'Nunito Sans' },
    { label: 'Work Sans', stack: "'Work Sans', sans-serif", category: 'Sans serif', google: 'Work Sans' },
    { label: 'Rubik', stack: "'Rubik', sans-serif", category: 'Sans serif', google: 'Rubik' },
    { label: 'Manrope', stack: "'Manrope', sans-serif", category: 'Sans serif', google: 'Manrope' },
    { label: 'DM Sans', stack: "'DM Sans', sans-serif", category: 'Sans serif', google: 'DM Sans' },
    { label: 'Karla', stack: "'Karla', sans-serif", category: 'Sans serif', google: 'Karla' },
    { label: 'Mulish', stack: "'Mulish', sans-serif", category: 'Sans serif', google: 'Mulish' },
    { label: 'Figtree', stack: "'Figtree', sans-serif", category: 'Sans serif', google: 'Figtree' },
    { label: 'Outfit', stack: "'Outfit', sans-serif", category: 'Sans serif', google: 'Outfit' },
    { label: 'Barlow', stack: "'Barlow', sans-serif", category: 'Sans serif', google: 'Barlow' },
    { label: 'Source Sans 3', stack: "'Source Sans 3', sans-serif", category: 'Sans serif', google: 'Source Sans 3' },
    { label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', sans-serif", category: 'Sans serif', google: 'Plus Jakarta Sans' },
    { label: 'Quicksand', stack: "'Quicksand', sans-serif", category: 'Sans serif', google: 'Quicksand' },
    { label: 'Archivo', stack: "'Archivo', sans-serif", category: 'Sans serif', google: 'Archivo' },
    { label: 'Public Sans', stack: "'Public Sans', sans-serif", category: 'Sans serif', google: 'Public Sans' },
    { label: 'Space Grotesk', stack: "'Space Grotesk', sans-serif", category: 'Sans serif', google: 'Space Grotesk' },
    { label: 'Oswald', stack: "'Oswald', sans-serif", category: 'Sans serif', google: 'Oswald' },

    // ── Serif ───────────────────────────────────────────────────────────────
    { label: 'Merriweather', stack: "'Merriweather', serif", category: 'Serif', google: 'Merriweather' },
    { label: 'Playfair Display', stack: "'Playfair Display', serif", category: 'Serif', google: 'Playfair Display' },
    { label: 'Lora', stack: "'Lora', serif", category: 'Serif', google: 'Lora' },
    { label: 'PT Serif', stack: "'PT Serif', serif", category: 'Serif', google: 'PT Serif' },
    { label: 'Source Serif 4', stack: "'Source Serif 4', serif", category: 'Serif', google: 'Source Serif 4' },
    { label: 'Libre Baskerville', stack: "'Libre Baskerville', serif", category: 'Serif', google: 'Libre Baskerville' },
    { label: 'Crimson Text', stack: "'Crimson Text', serif", category: 'Serif', google: 'Crimson Text' },
    { label: 'EB Garamond', stack: "'EB Garamond', serif", category: 'Serif', google: 'EB Garamond' },
    { label: 'Bitter', stack: "'Bitter', serif", category: 'Serif', google: 'Bitter' },
    { label: 'Cormorant Garamond', stack: "'Cormorant Garamond', serif", category: 'Serif', google: 'Cormorant Garamond' },
    { label: 'Noto Serif', stack: "'Noto Serif', serif", category: 'Serif', google: 'Noto Serif' },
    { label: 'Zilla Slab', stack: "'Zilla Slab', serif", category: 'Serif', google: 'Zilla Slab' },
    { label: 'Domine', stack: "'Domine', serif", category: 'Serif', google: 'Domine' },
    { label: 'Arvo', stack: "'Arvo', serif", category: 'Serif', google: 'Arvo' },
    { label: 'Spectral', stack: "'Spectral', serif", category: 'Serif', google: 'Spectral' },

    // ── Display ─────────────────────────────────────────────────────────────
    // These ship ONE weight. Asking css2 for `wght@400;700` on a single-weight family is a 400 Bad
    // Request and the stylesheet never loads — the font silently doesn't apply, which is precisely
    // the failure this whole file exists to end.
    { label: 'Bebas Neue', stack: "'Bebas Neue', sans-serif", category: 'Display', google: 'Bebas Neue', weights: '400' },
    { label: 'Abril Fatface', stack: "'Abril Fatface', serif", category: 'Display', google: 'Abril Fatface', weights: '400' },
    { label: 'Lobster', stack: "'Lobster', cursive", category: 'Display', google: 'Lobster', weights: '400' },
    { label: 'Comfortaa', stack: "'Comfortaa', sans-serif", category: 'Display', google: 'Comfortaa' },

    // ── Monospace ───────────────────────────────────────────────────────────
    { label: 'JetBrains Mono', stack: "'JetBrains Mono', monospace", category: 'Monospace', google: 'JetBrains Mono' },
    { label: 'Roboto Mono', stack: "'Roboto Mono', monospace", category: 'Monospace', google: 'Roboto Mono' },
    { label: 'IBM Plex Mono', stack: "'IBM Plex Mono', monospace", category: 'Monospace', google: 'IBM Plex Mono' },
    { label: 'Source Code Pro', stack: "'Source Code Pro', monospace", category: 'Monospace', google: 'Source Code Pro' },
    { label: 'Space Mono', stack: "'Space Mono', monospace", category: 'Monospace', google: 'Space Mono' },
];

/** The stack stored when nothing has been chosen, or when a stored value is no longer recognised. */
export const DEFAULT_FONT_STACK = BLOG_FONTS[0].stack;

export const BLOG_FONT_CATEGORIES: readonly BlogFont['category'][] =
    ['System', 'Sans serif', 'Serif', 'Display', 'Monospace'];

/** Look a font up by its STORED value (the CSS stack). Undefined for anything not offered. */
export function findBlogFont(stack: string | null | undefined): BlogFont | undefined {
    if (typeof stack !== 'string') return undefined;
    const v = stack.trim();
    return BLOG_FONTS.find(f => f.stack === v);
}

/**
 * Look a font up by its DISPLAY FAMILY NAME — 'Poppins', 'Georgia', 'IBM Plex Mono'.
 *
 * The stored value everywhere else is the CSS stack, so findBlogFont above is the normal lookup.
 * This one exists for the brand kit (src/utils/brand-kit.ts), which records the family the org's
 * own website uses as a bare name because that is what the extractor reads out of their CSS. It is
 * matched against both the picker label and the Google family, case- and space-insensitively.
 *
 * Returns undefined for a family we cannot serve — the caller then leaves the font unset rather
 * than inventing a stack, exactly as with an unknown stored stack.
 */
export function matchBlogFontByFamily(family: string | null | undefined): BlogFont | undefined {
    if (typeof family !== 'string') return undefined;
    const want = family.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
    if (!want) return undefined;
    return BLOG_FONTS.find(f =>
        f.label.toLowerCase() === want || (f.google || '').toLowerCase() === want);
}

/**
 * The Google Fonts stylesheet for a family, or null when it needs no download.
 *
 * `display=swap` is deliberate: without it the reader stares at invisible text for up to 3s while
 * the face downloads, on a page whose entire job is being read. A fallback that swaps is better
 * than a blank article.
 */
export function googleFontUrl(font: BlogFont | null | undefined): string | null {
    if (!font || !font.google) return null;
    const family = font.google.trim().replace(/\s+/g, '+');
    return `https://fonts.googleapis.com/css2?family=${family}:wght@${font.weights || DEFAULT_WEIGHTS}&display=swap`;
}

/** The stylesheet for a stored stack, in one step. Null when the stack is unknown or needs no font. */
export function fontUrlForStack(stack: string | null | undefined): string | null {
    return googleFontUrl(findBlogFont(stack));
}

/**
 * Is this a URL we are willing to inject into a published page?
 *
 * The stored theme is written into a `<link href>` on the customer's own site and into the
 * server-rendered permalink, so it is NOT enough that it came from an authenticated admin — it must
 * be a URL this file could itself have produced. Exact-match against the generated set rather than
 * a pattern: a regex over "fonts.googleapis.com" still admits arbitrary query strings.
 */
export function isAllowedFontUrl(url: string | null | undefined): boolean {
    if (url == null || url === '') return true;   // absent is always fine — it means "no download"
    if (typeof url !== 'string') return false;
    return BLOG_FONTS.some(f => googleFontUrl(f) === url);
}

/** Preconnect origins the font stylesheet needs. Saves a round-trip on first paint. */
export const GOOGLE_FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] as const;
