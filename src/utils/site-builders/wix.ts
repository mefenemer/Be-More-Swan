// src/utils/site-builders/wix.ts — Website import adapter for Wix (the classic editor; Wix Studio has its own).
// Findings, what is covered and what is not: docs/site-import-platforms/wix.md
// Tests: tests/site-platform-wix.test.ts (fixtures in tests/fixtures/site-platforms/wix/).
//
// Classic Wix pages are drawn on Wix's server (Thunderbolt): the words, menu and pictures are all in
// the HTML a plain fetch gets. What goes wrong is Wix's own markup:
//  - picture addresses carry commas (…/v1/fill/w_490,h_288,al_c,…/name.jpg), so a srcset split on
//    commas gives broken addresses; pictures below the fold may have no src at all, only the
//    original's file name in the <wow-image data-image-info> JSON beside them;
//  - every menu entry has the class "wixui-dropdown-menu__item", which reads as a drop-down box, and
//    a real drop-down's sub-menu sits in a wrapper <div> rather than straight inside its entry;
//  - older sites style their titles as paragraphs (<p class="font_0">) instead of headings;
//  - the free-plan banner, "top of page"/"bottom of page" anchors and the menu's hidden help text.
// The look lives in Wix's theme variables (--color_N as "r,g,b", --font_N as a CSS font shorthand):
// readWixLook reads it, for site-import-theme.ts to use (see the report's "Can be done").
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';
import type { ImportedLook } from '../site-import-theme';
import { fontKeyFor } from '../site-import-theme';
import { normalizeHex, saturation } from '../brand-kit';

const MEDIA = 'https://static.wixstatic.com/media/';

/** A Wix picture's address: the file in the Media Manager, and an optional crop the owner chose. */
function wixMedia(src: string): { file: string; crop: string | null; name: string } | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    if (!/(^|\.)wixstatic\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/media\/([^/]+)(?:\/v1\/(.+))?$/);
    if (!m) return null;
    const ops = m[2] ? m[2].split('/') : [];
    const name = ops.length > 1 ? ops[ops.length - 1] : m[1];
    const cropAt = ops.indexOf('crop');
    const crop = cropAt >= 0 && /^x_\d+,y_\d+,w_\d+,h_\d+$/.test(ops[cropAt + 1] ?? '') ? ops[cropAt + 1] : null;
    return { file: m[1], crop, name };
}

/**
 * Wix serves any size of the original from one address: ask for a sensible large one (not the
 * camera's 6000px), keep the owner's crop, and drop the blur and AVIF the placeholder asked for.
 */
export function wixFullSize(src: string): string | null {
    const w = wixMedia(src);
    if (!w) return null;
    return `${MEDIA}${w.file}/v1/${w.crop ? `crop/${w.crop}/` : ''}fit/w_1600,h_1600,q_85/${w.name}`;
}

/** The largest address in a srcset whose addresses contain commas: split only at ", http…" / ", /…". */
function largestWixSrc(srcset: string): string | null {
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(/,\s+(?=https?:|\/)/)) {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) continue;
        const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
        if (!best || w > best.w) best = { url, w };
    }
    return best?.url ?? null;
}

/** The original's file name from <wow-image data-image-info> (a picture whose <img> has no src yet). */
function infoUri(raw: string | undefined): string | null {
    if (!raw) return null;
    try {
        const uri = (JSON.parse(raw) as { imageData?: { uri?: unknown } }).imageData?.uri;
        return typeof uri === 'string' && /^[\w~.%-]+\.(jpe?g|png|webp|gif|avif)$/i.test(uri) ? uri : null;
    } catch { return null; }
}

/** Wix theme text styles used as titles → the heading level they stand for. */
const TITLE_STYLE: Record<string, number> = { font_0: 1, font_2: 2, font_3: 3, font_4: 3, font_5: 4, font_6: 5 };

function prepare($: cheerio.CheerioAPI): void {
    // Wix's own furniture: free-plan banner, the top/bottom anchors, the menu's hidden help text,
    // the menu's empty "More" overflow, background overlays.
    // The "Show more" toggle of a collapsible text box.
    $('.wixui-collapsible-text button, .wixui-collapsible-text [role="button"]').remove();
    $('#WIX_ADS, #SCROLL_TO_TOP, #SCROLL_TO_BOTTOM, [id$="hiddenA11ySubMenuIndication"], [data-index="__more__"], [id$="moreContainer"], [data-testid="bgOverlay"], .wixGuard').remove();

    // Pictures: one clean src per <img>, from the srcset (commas inside addresses), or from the
    // wow-image's data when Wix left the <img> empty until it scrolls into view.
    $('img').each((_, el) => {
        const $img = $(el);
        const srcset = $img.attr('srcset') ?? $img.attr('srcSet');
        const fromSet = srcset && /wixstatic\.com/i.test(srcset) ? largestWixSrc(srcset) : null;
        let src = fromSet ?? $img.attr('src') ?? '';
        if (!/^https?:|^\//.test(src)) {
            const uri = infoUri($img.closest('wow-image, [data-image-info]').attr('data-image-info'));
            if (uri) src = MEDIA + uri;
        }
        if (src && (fromSet || /wixstatic\.com/i.test(src))) {
            $img.attr('src', src);
            $img.removeAttr('srcset').removeAttr('sizes').removeAttr('data-src');
        }
    });

    // The menu: "wixui-dropdown-menu…" on every entry reads as a drop-down box, so the class goes;
    // a real drop-down's list moves straight under its entry (li > label + ul), which reads as one.
    $('.wixui-dropdown-menu__submenu').each((_, el) => {
        const $ul = $(el);
        const li = $ul.parent().closest('li');
        if (li.length) li.append($ul);
    });
    $('[class*="wixui-dropdown-menu"]').each((_, el) => {
        const $el = $(el);
        $el.attr('class', ($el.attr('class') ?? '').replace(/\bwixui-dropdown-menu\S*/g, '').trim());
    });

    // Titles styled as paragraphs (older sites): a short line in a title style, in a text box with
    // no heading of its own, becomes the heading it looks like. Words unchanged.
    $('.wixui-rich-text, [data-testid="richTextElement"]').each((_, box) => {
        const $box = $(box);
        if ($box.find('h1, h2, h3, h4, h5, h6').length) return;
        $box.find('p').each((__, p) => {
            const $p = $(p);
            const style = ($p.attr('class') ?? '').match(/\bfont_\d+\b/)?.[0];
            const level = style ? TITLE_STYLE[style] : undefined;
            const text = $p.text().replace(/\s+/g, ' ').trim();
            // Four letters at least: "New" and "Sale" ribbons stay text, "Bread." becomes a title.
            if (!level || text.length < 4 || text.length > 120 || !/[a-z]/i.test(text) || $p.closest('li').length) return;
            $p.replaceWith(`<h${level}>${$p.html() ?? ''}</h${level}>`);
        });
    });
}

// ── The look: Wix's theme variables ─────────────────────────────────────────────────────────────

const rgbHex = (triple: string | undefined): string | null => {
    const m = triple?.match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/);
    if (!m || [m[1], m[2], m[3]].some((c) => Number(c) > 255)) return null;
    return normalizeHex(`#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`);
};

/** A family from a --font_N shorthand ("normal normal normal 40px/1.3em 'playfair display',serif"). */
function shorthandFamily(v: string | undefined): string | null {
    const fam = v?.match(/\d+(?:\.\d+)?px(?:\/[\d.]+(?:em|px)?)?\s+(.+)$/)?.[1];
    const first = fam?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '').trim();
    if (!first) return null;
    // Wix's own web-font names: "avenir-lt-w01_35-light1475496" → "avenir lt", "helvetica-w01-bold" → "helvetica".
    return first.replace(/(?:[-_]?lt)?[-_]?w0\d[\s\S]*$/i, '').replace(/\d+$/, '').replace(/[-_\s]+$/, '').replace(/[-_]+/g, ' ').trim() || null;
}

/**
 * Their look from Wix's theme: the palette (--color_N: r,g,b), the colour each text style and
 * button points at, and the fonts of the title and paragraph styles. Only from what the page says;
 * every value null when not found. Wix's own interface colours (its blue banner) are never read.
 */
export function readWixLook(html: string): ImportedLook {
    const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const palette = new Map<string, string>();
    for (const m of css.matchAll(/--color_(\d+)\s*:\s*([\d\s,]+)[;}]/g)) {
        const hex = rgbHex(m[2]);
        if (hex && !palette.has(m[1])) palette.set(m[1], hex);
    }
    const fonts = new Map<string, string>();
    for (const m of css.matchAll(/--font_(\d+)\s*:\s*([^;}]+)[;}]/g)) if (!fonts.has(m[1])) fonts.set(m[1], m[2].trim());
    const ref = (v: string | undefined) => (v ? palette.get(v.match(/--color_(\d+)/)?.[1] ?? '') ?? null : null);
    const styleColour = (n: number) => ref(css.match(new RegExp(`\\.font_${n}\\s*\\{[^}]*color\\s*:\\s*([^;}]+)`))?.[1]);

    // Buttons: Wix gives each one a rule of its own, #comp-…{--bg:var(--color_N);--rd:24px;…}.
    const buttonIds = new Set([...html.matchAll(/<div\b[^>]*\bid="(comp-[\w-]+)"[^>]*>\s*<a\b[^>]*\bwixui-button\b/gi)].map((m) => m[1]));
    const fills = new Map<string, number>();
    const radii: number[] = [];
    for (const m of css.matchAll(/#(comp-[\w-]+)\s*\{([^}]*)\}/g)) {
        if (!buttonIds.has(m[1])) continue;
        const bg = ref(m[2].match(/(?:^|;)\s*--bg\s*:\s*([^;]+)/)?.[1]);
        if (bg && saturation(bg) >= 0.25) fills.set(bg, (fills.get(bg) ?? 0) + 1);
        const rd = m[2].match(/(?:^|;)\s*--rd\s*:\s*([\d.]+)px/)?.[1];
        if (rd !== undefined) radii.push(Number(rd));
    }
    const byUse = [...fills].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
    const titleColour = [styleColour(0), styleColour(2)].find((h) => h && saturation(h) >= 0.25) ?? null;
    const accentRow = ['18', '23', '28', '33'].map((n) => palette.get(n)).find((h) => h && saturation(h) >= 0.25) ?? null;
    const primary = byUse[0] ?? titleColour ?? accentRow;
    const secondary = byUse.find((h) => h !== primary) ?? null;

    const headingFamily = shorthandFamily(fonts.get('0') ?? fonts.get('2'));
    const bodyFamily = shorthandFamily(fonts.get('7') ?? fonts.get('8'));
    const r = radii.length ? radii.sort((a, b) => a - b)[Math.floor(radii.length / 2)] : null;
    return {
        primaryColor: primary,
        textColor: styleColour(7) ?? styleColour(8) ?? palette.get('15') ?? null,
        backgroundColor: palette.get('11') ?? null,
        secondaryColor: secondary,
        headingFont: headingFamily,
        font: fontKeyFor(headingFamily, bodyFamily),
        radius: r === null ? null : r >= 16 ? 'large' : r >= 7 ? 'medium' : r >= 1 ? 'small' : 'none',
    };
}

/** A classic Wix page (Wix Studio's own adapter runs first and claims its pages). */
const WIX_MARKUP = /static\.wixstatic\.com|wix-thunderbolt|id="SITE_CONTAINER"|\bwixui-[a-z]/;

export const adapter: BuilderAdapter = {
    key: 'wix',
    label: 'Wix',
    detect: (html, gen) => gen.includes('wix') || WIX_MARKUP.test(html),
    prepare: ($) => prepare($),
    contentRoot: '#PAGES_CONTAINER',
    // Lines Wix adds: the free-plan banner, form thank-yous, "show more" toggles, its footer credit.
    noise: /^(this (site|website) was (designed|built|created) with (the )?wix(\.com)?\b.*|create your website today\.?|powered (and secured )?by wix(\.com)?|thanks for (submitting|subscribing|your message)!?|your (form|details) (was|were|has been) (submitted|sent).*|show (more|less)|read less|load more|loading\.*)$/i,
    fullSizeImage: (src) => wixFullSize(src),
    rendersWithJs: false,
};
