// src/utils/site-import-theme.ts — the look of the site being imported: its colours, lettering and
// corners, as a hosted-site theme (owner, 2026-11-08: "it also needs to bring in the original
// site's CSS — this looks black and white").
//
// We never copy their stylesheet: a hosted site's look is a closed set of tokens (site-definition.ts
// SiteTheme), and everything a visitor's browser loads comes from us. So this reads the tokens from
// what their site shows:
//   · colours — brand-extract.ts's harvest (theme-color, CSS custom properties, frequency), plus the
//     page's own Tailwind config when it has one (Tailwind's CDN build keeps the palette in an inline
//     `tailwind.config = {…}` script, and the <body> classes say which of it is the page and the words);
//   · lettering — their heading and body fonts, matched to one of our hosted pairings by name, else
//     serif or sans by kind;
//   · corners — their buttons' rounding (Tailwind classes, or border-radius on button rules).
// Pure: HTML and CSS strings in, a partial theme out. The fetching is site-import.ts's deps.

import { harvestBrandSignals } from './brand-extract';
import { normalizeHex } from './brand-kit';
import type { FontKey, RadiusKey, SiteTheme } from './site-definition';

/** What we brought across, for the import report ("Their colours and lettering"). */
export interface ImportedLook {
    primaryColor: string | null;
    textColor: string | null;
    backgroundColor: string | null;
    /** Their heading font as their site names it, and the pairing it became. */
    headingFont: string | null;
    font: FontKey | null;
    radius: RadiusKey | null;
}

/**
 * Our hosted pairings by their heading face (site-render.ts FONT_PAIRS — a test keeps the two in
 * step). A body face alone decides only when the heading face is ours too, so Inter on its own
 * never picks "Crisp" over "Editorial".
 */
const PAIR_BY_HEADING: Record<string, FontKey> = {
    fraunces: 'editorial', 'playfair display': 'classic', 'cormorant garamond': 'elegant', cormorant: 'elegant',
    manrope: 'modern', oswald: 'bold', nunito: 'friendly', 'nunito sans': 'friendly', 'space grotesk': 'tech', 'dm serif display': 'warm',
};
const SERIF_HINT = /serif|georgia|garamond|times|baskerville|caslon|didot|bodoni|merriweather|lora|playfair|libre|crimson|spectral|cormorant|fraunces|domine|bitter|slab/i;
const SANS_HINT = /sans|inter|helvetica|arial|roboto|lato|open sans|montserrat|poppins|raleway|work sans|source sans|system-ui|segoe|dm sans|figtree|outfit|plus jakarta/i;

/** First family in a CSS font-family list, unquoted ("'Fraunces', Georgia, serif" → Fraunces). */
function firstFamily(list: string | null | undefined): string | null {
    const f = (list ?? '').split(',')[0]?.trim().replace(/^['"]|['"]$/g, '').trim();
    return f && !/^(inherit|initial|unset|var\()/i.test(f) ? f : null;
}

/** A pairing for their heading font (and body font, for "serif or sans" when it is none of ours). */
export function fontKeyFor(heading: string | null, body: string | null = null): FontKey | null {
    const h = (heading ?? '').toLowerCase().trim();
    if (h && PAIR_BY_HEADING[h]) return PAIR_BY_HEADING[h];
    const kind = (s: string | null) => (!s ? null : SERIF_HINT.test(s) && !/sans/i.test(s) ? 'serif' : SANS_HINT.test(s) ? 'sans' : null);
    return kind(heading) ?? kind(body);
}

// ── Tailwind's CDN config ─────────────────────────────────────────────────────────────────────

interface TailwindLook { colours: Map<string, string>; fonts: Record<string, string>; }

/**
 * The palette and fonts in an inline `tailwind.config = {…}` script. Read as text with narrow
 * patterns — never evaluated: `brand: { 50: '#f0f9f8', … }` gives brand-50…, `sand: '#…'` gives
 * sand, and `display: ['Fraunces', …]` gives display.
 */
export function readTailwindConfig(html: string): TailwindLook | null {
    const at = html.search(/tailwind\.config\s*=\s*\{/);
    if (at < 0) return null;
    const src = html.slice(at, at + 20000).split(/<\/script>/i)[0];
    const colours = new Map<string, string>();
    const colorsAt = src.search(/colors\s*:\s*\{/);
    if (colorsAt >= 0) {
        const block = src.slice(colorsAt);
        for (const m of block.matchAll(/['"]?([a-z][\w-]*)['"]?\s*:\s*\{([^{}]*)\}/gi)) {
            for (const s of m[2].matchAll(/['"]?(\d{2,3}|DEFAULT)['"]?\s*:\s*['"](#[0-9a-f]{3,8})['"]/gi)) {
                const hex = normalizeHex(s[2]);
                if (hex) colours.set(s[1] === 'DEFAULT' ? m[1] : `${m[1]}-${s[1]}`, hex);
            }
        }
        for (const m of block.matchAll(/['"]?([a-z][\w-]*)['"]?\s*:\s*['"](#[0-9a-f]{3,8})['"]/gi)) {
            const hex = normalizeHex(m[2]);
            if (hex && !colours.has(m[1])) colours.set(m[1], hex);
        }
    }
    const fonts: Record<string, string> = {};
    const fontAt = src.search(/fontFamily\s*:\s*\{/);
    if (fontAt >= 0) {
        const block = src.slice(fontAt, src.indexOf('}', fontAt) + 1);
        for (const m of block.matchAll(/['"]?([a-z][\w-]*)['"]?\s*:\s*\[\s*['"]([^'"]+)['"]/gi)) fonts[m[1]] = m[2].trim();
    }
    return colours.size || Object.keys(fonts).length ? { colours, fonts } : null;
}

const WHITE_BLACK: Record<string, string> = { white: '#ffffff', black: '#000000' };

/** A Tailwind colour class's hex from the page's own palette: bg-sand-50 → sand-50. */
function classColour(classes: string, prefix: 'bg' | 'text', tw: TailwindLook | null): string | null {
    for (const c of classes.split(/\s+/)) {
        const m = c.match(new RegExp(`^${prefix}-([a-z]+(?:-\\d{2,3})?)$`));
        if (!m) continue;
        if (WHITE_BLACK[m[1]]) return WHITE_BLACK[m[1]];
        const hex = tw?.colours.get(m[1]);
        if (hex) return hex;
    }
    return null;
}

/** The rounding their buttons use, by the classes on their links (Tailwind) or button rules in their CSS. */
function buttonRadius(html: string, css: string): RadiusKey | null {
    const counts: Record<RadiusKey, number> = { none: 0, small: 0, medium: 0, large: 0 };
    // Links drawn as buttons: padded on both sides — in the page's content, not its menu (menu links
    // are padded too, and usually rounded differently from the buttons).
    const content = html.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, '');
    for (const m of content.matchAll(/<a\b[^>]*class=['"]([^'"]*\bpx-\d[^'"]*)['"]/gi)) {
        const cls = ` ${m[1]} `;
        if (/\srounded-full\s/.test(cls)) counts.large++;
        else if (/\srounded-(?:xl|2xl|3xl)\s/.test(cls)) counts.large++;
        else if (/\srounded-(?:lg|md)\s/.test(cls)) counts.medium++;
        else if (/\srounded(?:-sm)?\s/.test(cls)) counts.small++;
        else if (/\srounded-none\s/.test(cls)) counts.none++;
    }
    if (!Object.values(counts).some(Boolean)) {
        for (const m of css.matchAll(/(?:\.btn|\.button|button)[^{]*\{[^}]*border-radius\s*:\s*([\d.]+)(px|rem|em|%)/gi)) {
            const px = m[2] === 'px' ? Number(m[1]) : m[2] === '%' ? (Number(m[1]) >= 50 ? 999 : 8) : Number(m[1]) * 16;
            counts[px >= 16 ? 'large' : px >= 7 ? 'medium' : px >= 1 ? 'small' : 'none']++;
        }
    }
    const best = (Object.entries(counts) as Array<[RadiusKey, number]>).sort((a, b) => b[1] - a[1])[0];
    return best[1] ? best[0] : null;
}

/**
 * Their site's look, as much of it as we could read. Every value is null when not found — the
 * caller keeps the current theme's value for that one. Colours only from what is on their site.
 */
export function readImportedLook(html: string, baseUrl: string, css = ''): ImportedLook {
    const signals = harvestBrandSignals(html, baseUrl, css);
    const tw = readTailwindConfig(html);
    const bodyClass = html.match(/<body\b[^>]*class=['"]([^'"]*)['"]/i)?.[1] ?? '';
    const background = classColour(bodyClass, 'bg', tw) ?? signals.lights[0] ?? null;
    const text = classColour(bodyClass, 'text', tw) ?? signals.darks[0] ?? null;
    const primary = signals.candidates[0]?.hex ?? null;

    // Headings by their own rule (h1/h2 in their CSS or <style>), the body by body's; the brand
    // reader's single font is whichever it found first.
    const allCss = `${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')}\n${css}`;
    const ruleFont = (sel: RegExp) => firstFamily(allCss.match(new RegExp(`(?:^|[},])\\s*[^{}]*${sel.source}[^{}]*\\{[^}]*font-family\\s*:\\s*([^;}]+)`, 'i'))?.[1]);
    const headingFont = firstFamily(tw?.fonts.display ?? tw?.fonts.heading ?? tw?.fonts.serif) ?? ruleFont(/\bh[12]\b/) ?? signals.fontFamily;
    const bodyFont = firstFamily(tw?.fonts.sans ?? tw?.fonts.body) ?? ruleFont(/\bbody\b/) ?? null;
    return {
        primaryColor: primary, textColor: text, backgroundColor: background,
        headingFont, font: fontKeyFor(headingFont, bodyFont),
        radius: buttonRadius(html, css),
    };
}

/**
 * The imported look laid over a theme: colours (and a soft tint of the main colour for alternate
 * sections), lettering and corners. Logo, header and spacing stay as they are. The gate
 * (normaliseSiteDefinition) still checks the colours can be read against each other.
 */
export function themeWithLook(base: SiteTheme, look: ImportedLook): SiteTheme {
    return {
        ...base,
        ...(look.primaryColor ? { primaryColor: look.primaryColor, accentColor: look.primaryColor } : {}),
        ...(look.textColor ? { textColor: look.textColor } : {}),
        ...(look.backgroundColor ? { backgroundColor: look.backgroundColor } : {}),
        ...(look.font ? { font: look.font } : {}),
        ...(look.radius ? { radius: look.radius } : {}),
    };
}

/** Whether anything at all was read (else the import says it kept their current design). */
export const lookFound = (l: ImportedLook | null | undefined): boolean => !!l && !!(l.primaryColor || l.font);
