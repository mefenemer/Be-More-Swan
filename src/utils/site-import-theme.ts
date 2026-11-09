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
import { contrastRatio, normalizeHex, saturation } from './brand-kit';
import type { CardStyleKey, FontKey, RadiusKey, SiteTheme } from './site-definition';

/** What we brought across, for the import report ("Their colours and lettering"). */
export interface ImportedLook {
    primaryColor: string | null;
    textColor: string | null;
    backgroundColor: string | null;
    /** A second brand colour their buttons use (themeWithLook → secondaryColor); null = none told apart. */
    secondaryColor?: string | null;
    /** Filled, outlined or pill-shaped buttons; their cards' border, shadow or neither (2026-11-08). */
    buttonStyle?: 'solid' | 'outline' | 'pill' | null;
    cardStyle?: 'bordered' | 'shadow' | 'flat' | null;
    /** Their headings' own colour, and their header and footer bands' colours, when they differ from the page. */
    headingColor?: string | null;
    headerColor?: string | null;
    footerColor?: string | null;
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

const differs = (a: string | null, b: string | null) => (a && a !== b ? a : null);
/**
 * Whether a main colour can be told apart on the page. 2:1 — the colour mostly fills buttons (with ink
 * that reads on it, buttonInk), so orange and red brands (#f97015 on white is 2.8:1) keep their colour,
 * while washed-out picks (pale pink 1.3:1, pale blue 1.6:1) give way.
 */
export const readsOn = (colour: string, background: string) => contrastRatio(colour, background) >= 2;

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

/** Classes on the links drawn as buttons (padded both sides), in the page's content (not its menu). */
function buttonClasses(html: string): string[] {
    const content = html.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, '');
    return [...content.matchAll(/<a\b[^>]*class=['"]([^'"]*\bpx-\d[^'"]*)['"]/gi)].map((m) => ` ${m[1]} `);
}
/** Filled, outlined or pill: what most of their buttons are. */
function buttonStyleOf(html: string): ImportedLook['buttonStyle'] {
    const cls = buttonClasses(html);
    if (!cls.length) return null;
    const filled = cls.filter((c) => /\sbg-(?!transparent\s)[a-z]/.test(c));
    const outlined = cls.filter((c) => !/\sbg-(?!transparent\s)[a-z]/.test(c) && /\sborder(-\d)?\s/.test(c));
    if (outlined.length > filled.length) return 'outline';
    if (!filled.length) return null;
    return filled.filter((c) => /\srounded-full\s/.test(c)).length * 2 >= filled.length ? 'pill' : 'solid';
}
/** Their cards (a rounded, padded box holding a heading): shadowed, bordered or flat. */
function cardStyleOf(html: string, css: string): CardStyleKey | null {
    const counts: Record<CardStyleKey, number> = { bordered: 0, shadow: 0, flat: 0 };
    for (const m of html.matchAll(/<(?:article|div|li)\b[^>]*class=['"]([^'"]*\brounded[^'"]*)['"][^>]*>/gi)) {
        const c = ` ${m[1]} `;
        if (!/\sp-\d|\sp[xy]-\d|\soverflow-hidden\s/.test(c)) continue;
        if (/\sshadow(-(md|lg|xl|2xl))?\s/.test(c)) counts.shadow++;
        else if (/\sborder(-\d)?\s/.test(c)) counts.bordered++;
        else if (/\sbg-/.test(c)) counts.flat++;
    }
    if (!Object.values(counts).some(Boolean)) {
        const rule = css.match(/\.(?:card|tile|box)[^{]*\{([^}]*)\}/i)?.[1] ?? '';
        if (/box-shadow\s*:\s*(?!none)/i.test(rule)) return 'shadow';
        if (/border\s*:\s*\d/i.test(rule)) return 'bordered';
        return null;
    }
    return (Object.entries(counts) as Array<[CardStyleKey, number]>).sort((a, b) => b[1] - a[1])[0][0];
}
/** A colour set on an element: its Tailwind bg-/text- class from their palette, or a CSS rule for it. */
function elementColour(html: string, css: string, tag: 'header' | 'footer' | 'h1', prop: 'bg' | 'text', tw: TailwindLook | null): string | null {
    // Every element of that kind (a testimonial's <footer> comes before the site's), the last one that says.
    const found = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class=['"]([^'"]*)['"]`, 'gi'))].map((m) => classColour(m[1], prop, tw)).filter(Boolean);
    if (found.length) return found[found.length - 1];
    const rule = css.match(new RegExp(`(?:^|[},\\s])${tag}\\s*\\{([^}]*)\\}`, 'i'))?.[1] ?? '';
    const v = rule.match(prop === 'bg' ? /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8})\b/i : /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,8})\b/i)?.[1];
    return v ? normalizeHex(v) : null;
}

// ── Design tokens: HSL triples (shadcn) and oklch() (Tailwind v4) ─────────────────────────────

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
function hslToHex(h: number, s: number, l: number): string {
    s /= 100; l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}
/** oklch(L C H) → sRGB hex (via OKLab and linear sRGB), clipped to the gamut. */
function oklchToHex(L: number, C: number, H: number): string {
    const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    const g = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055) * 255;
    return `#${lin.map((x) => hex2(g(x))).join('')}`;
}
/** A token's value as hex: a bare HSL triple, hsl(), oklch(), rgb() or hex. Null when not a colour. */
export function tokenColour(raw: string): string | null {
    const v = raw.trim().replace(/\s*!important$/, '');
    const hsl = v.match(/^(?:hsla?\()?\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)?$/i);
    if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
    const ok = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i);
    if (ok) return oklchToHex(Number(ok[1]) / (ok[2] ? 100 : 1), Number(ok[3]), Number(ok[4]));
    const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
    if (rgb) return `#${hex2(+rgb[1])}${hex2(+rgb[2])}${hex2(+rgb[3])}`;
    return normalizeHex(v);
}
/** The first light-mode value of each shadcn / Tailwind v4 colour token (the dark-mode block comes later). */
export function designTokens(css: string): { primary: string | null; background: string | null; foreground: string | null } {
    const first = (names: string[]) => {
        for (const n of names) {
            const m = css.match(new RegExp(`--${n}\\s*:\\s*([^;}]+)`, 'i'));
            const hex = m ? tokenColour(m[1]) : null;
            if (hex) return hex;
        }
        return null;
    };
    return { primary: first(['primary', 'color-primary', 'brand', 'color-brand']), background: first(['background', 'color-background']), foreground: first(['foreground', 'color-foreground']) };
}

/** The palette a Tailwind colour name belongs to: brand-700 → brand. */
const paletteOf = (name: string) => name.replace(/-\d{2,3}$/, '');

/**
 * A second colour: on a Tailwind site, the button background used most that is not from the main
 * colour's palette and not a near-grey; otherwise a --secondary / --accent variable in their CSS.
 */
function secondColour(html: string, css: string, tw: TailwindLook | null, primary: string | null): string | null {
    if (tw) {
        const primaryPalette = primary ? [...tw.colours].find(([, hex]) => hex === primary)?.[0] : undefined;
        const counts = new Map<string, number>();
        for (const m of html.matchAll(/<a\b[^>]*class=['"]([^'"]*\bpx-\d[^'"]*)['"]/gi)) {
            for (const c of m[1].split(/\s+/)) {
                const k = c.match(/^bg-([a-z]+-\d{2,3})$/)?.[1];
                const hex = k ? tw.colours.get(k) : null;
                if (!k || !hex || (primaryPalette && paletteOf(k) === paletteOf(primaryPalette)) || saturation(hex) < 0.35) continue;
                counts.set(k, (counts.get(k) ?? 0) + 1);
            }
        }
        const top = [...counts].sort((a, b) => b[1] - a[1])[0];
        if (top) return tw.colours.get(top[0]) ?? null;
    }
    const v = css.match(/--(?:color-|brand-)?(?:secondary|accent)(?:-colou?r)?\s*:\s*(#[0-9a-f]{3,8})\b/i)?.[1];
    const hex = v ? normalizeHex(v) : null;
    return hex && hex !== primary && saturation(hex) >= 0.35 ? hex : null;
}

/**
 * Their site's look, as much of it as we could read. Every value is null when not found — the
 * caller keeps the current theme's value for that one. Colours only from what is on their site.
 */
export function readImportedLook(html: string, baseUrl: string, css = ''): ImportedLook {
    const signals = harvestBrandSignals(html, baseUrl, css);
    const tw = readTailwindConfig(html);
    const bodyClass = html.match(/<body\b[^>]*class=['"]([^'"]*)['"]/i)?.[1] ?? '';
    // Design tokens (shadcn's "--primary: 222 47% 11%", Tailwind v4's oklch()) say outright which colour
    // is which; the brand harvest reads only hex and rgb, so AI-built sites came out uncoloured.
    const tokens = designTokens(`${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')}\n${css}`);
    const background = classColour(bodyClass, 'bg', tw) ?? tokens.background ?? signals.lights[0] ?? null;
    const text = classColour(bodyClass, 'text', tw) ?? tokens.foreground ?? signals.darks[0] ?? null;
    // A main colour colours links and buttons on the page, so it must read on it: a pale pick (Squarespace's
    // #fed9db, a Webflow site's #8dd9e7 on white, 2026-11-09) gives way to the next candidate that does.
    const bg = background ?? '#ffffff';
    const primary = [tokens.primary, ...signals.candidates.map((c) => c.hex)].find((c) => c && readsOn(c, bg)) ?? null;

    // Headings by their own rule (h1/h2 in their CSS or <style>), the body by body's; the brand
    // reader's single font is whichever it found first.
    const allCss = `${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')}\n${css}`;
    const ruleFont = (sel: RegExp) => firstFamily(allCss.match(new RegExp(`(?:^|[},])\\s*[^{}]*${sel.source}[^{}]*\\{[^}]*font-family\\s*:\\s*([^;}]+)`, 'i'))?.[1]);
    const headingFont = firstFamily(tw?.fonts.display ?? tw?.fonts.heading ?? tw?.fonts.serif) ?? ruleFont(/\bh[12]\b/) ?? signals.fontFamily;
    const bodyFont = firstFamily(tw?.fonts.sans ?? tw?.fonts.body) ?? ruleFont(/\bbody\b/) ?? null;
    return {
        primaryColor: primary, textColor: text, backgroundColor: background,
        secondaryColor: secondColour(html, allCss, tw, primary),
        buttonStyle: buttonStyleOf(html),
        cardStyle: cardStyleOf(html, allCss),
        // Only when they differ from what the page already uses (the same colour adds nothing).
        headingColor: differs(elementColour(html, allCss, 'h1', 'text', tw), text),
        headerColor: differs(elementColour(html, allCss, 'header', 'bg', tw), background),
        footerColor: differs(elementColour(html, allCss, 'footer', 'bg', tw), background),
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
        ...(look.secondaryColor ? { secondaryColor: look.secondaryColor } : {}),
        ...(look.buttonStyle ? { buttonStyle: look.buttonStyle } : {}),
        ...(look.cardStyle ? { cardStyle: look.cardStyle } : {}),
        ...(look.headingColor ? { headingColor: look.headingColor } : {}),
        ...(look.headerColor ? { headerColor: look.headerColor } : {}),
        ...(look.footerColor ? { footerColor: look.footerColor } : {}),
        ...(look.backgroundColor ? { backgroundColor: look.backgroundColor } : {}),
        ...(look.font ? { font: look.font } : {}),
        ...(look.radius ? { radius: look.radius } : {}),
    };
}

/** Whether anything at all was read (else the import says it kept their current design). */
export const lookFound = (l: ImportedLook | null | undefined): boolean => !!l && !!(l.primaryColor || l.font);
