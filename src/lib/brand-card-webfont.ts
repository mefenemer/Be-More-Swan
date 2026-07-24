// src/lib/brand-card-webfont.ts — render a brand card in the org's OWN display font.
//
// Website extraction can tell us a client sets their headings in, say, Poppins. Storing that and
// then drawing every card in Plus Jakarta Sans anyway would make brandKit.fontFamily dead config —
// so this resolves the family to real font bytes satori can lay out.
//
// Google Fonts is the only source, on purpose: it is where the overwhelming majority of SMB sites
// get their type, it serves TrueType (satori cannot read woff2 — there is no decoder in the
// function runtime), and it is ONE fixed host, which keeps this from becoming a fetch-arbitrary-
// binaries primitive. A self-hosted font is not followed.
//
// Every failure path returns null and the caller falls back to the bundled family. A card in the
// wrong-but-good font is a non-event; a card that failed to render is not.

import { cleanFontFamily } from '../utils/brand-kit';

/** What satori's `fonts` option takes. Declared rather than derived from brandCardFonts: that
 *  array's buffers come from base64 (Buffer<ArrayBuffer>) while these come off the wire
 *  (Buffer<ArrayBufferLike>), and the two are not assignable to one another. */
export interface SatoriFont {
    name: string;
    data: Buffer;
    weight: 400 | 800;
    style: 'normal';
}

const CSS_HOST = 'https://fonts.googleapis.com/css2';
const FONT_HOST = 'fonts.gstatic.com';
// Google serves woff2 to modern browsers and TrueType to old ones. satori needs TrueType, so we
// ask as a browser old enough to be given it.
const LEGACY_UA = 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0 Safari/537.36';
const TIMEOUT_MS = 5_000;
const MAX_FONT_BYTES = 2 * 1024 * 1024;

/**
 * Resolved families for this container. Negative results are cached too: a family Google has never
 * heard of would otherwise cost two dead round-trips on every card the org ever renders.
 */
const cache = new Map<string, SatoriFont[] | null>();

/** Exposed for tests — a module-scope cache otherwise leaks between cases. */
export function _clearWebFontCache(): void { cache.clear(); }

/**
 * Fetch the @font-face CSS for a family, asking for the two weights the card needs.
 *
 * Retries without the weight axis because `:wght@400;700` is a 400 error for any family that
 * doesn't publish both — a single-weight display face would otherwise be reported as "font not
 * found" when it exists and would render perfectly well.
 */
async function fetchFontCss(name: string): Promise<string> {
    const get = (suffix: string) => fetch(
        `${CSS_HOST}?family=${encodeURIComponent(name)}${suffix}&display=swap`,
        { headers: { 'User-Agent': LEGACY_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    let res = await get(':wght@400;700');
    if (!res.ok) res = await get('');
    return res.ok ? res.text() : '';
}

/**
 * URL of the font file for one weight, preferring the plain `latin` subset.
 *
 * Google splits a family into per-script @font-face blocks (devanagari, cyrillic, latin-ext,
 * latin…) each labelled by a preceding comment. Taking the first or last `url()` in the file — as
 * this first did — picks a Devanagari subset with no Latin glyphs in it at all.
 *
 * .woff is accepted alongside .ttf/.otf: modern Google Fonts serves woff for static families even
 * to an ancient user-agent, and satori reads it. Only woff2 is unsupported.
 */
export function pickFaceUrl(css: string, weight: number): string | null {
    const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)]
        .map((m) => ({ subset: m[1], body: m[2] }));
    // A family with no subset comments still has usable @font-face blocks.
    const all = blocks.length ? blocks : [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => ({ subset: '', body: m[1] }));

    const atWeight = all.filter((b) => new RegExp(`font-weight:\\s*${weight}\\b`).test(b.body));
    const pool = atWeight.length ? atWeight : all;
    const preferred = pool.find((b) => b.subset === 'latin') ?? pool[0];
    return preferred ? /url\((https:\/\/[^)]+\.(?:ttf|otf|woff))\)/.exec(preferred.body)?.[1] ?? null : null;
}

async function fetchBinary(url: string): Promise<Buffer | null> {
    // Host is pinned to Google's font CDN rather than taken from the page, so this is not a
    // user-controlled fetch and does not need the SSRF guard (which is text-only anyway).
    if (new URL(url).hostname !== FONT_HOST) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength && buf.byteLength <= MAX_FONT_BYTES ? buf : null;
}

/**
 * Font buffers for `family`, or null to use the bundled family.
 *
 * Both weights are requested; whichever arrives is registered at 400 and 800 to match the weights
 * the card's styles ask for. A family with no true extrabold therefore renders its bold as the
 * headline — visibly correct, and far better than satori finding no match at that weight and
 * falling back mid-layout.
 */
export async function loadWebFont(family: string | null | undefined): Promise<SatoriFont[] | null> {
    const name = cleanFontFamily(family);
    if (!name) return null;
    if (cache.has(name)) return cache.get(name)!;

    let result: SatoriFont[] | null = null;
    try {
        const css = await fetchFontCss(name);
        const regularUrl = pickFaceUrl(css, 400);
        const boldUrl = pickFaceUrl(css, 700);
        if (regularUrl && boldUrl) {
            const [regular, bold] = await Promise.all([fetchBinary(regularUrl), fetchBinary(boldUrl)]);
            if (regular && bold) {
                result = [
                    { name, data: regular, weight: 400, style: 'normal' },
                    // Registered at 800 because that is the weight the card's headline asks for.
                    // Google will not serve an 800 for every family, and a family with no match at
                    // the requested weight makes satori fall back mid-layout — the site's real bold
                    // standing in for extrabold is the better of the two outcomes.
                    { name, data: bold, weight: 800, style: 'normal' },
                ];
            }
        }
    } catch (err) {
        console.warn(`[brand-card] web font "${name}" unavailable, using the bundled family:`, err instanceof Error ? err.message : err);
    }

    cache.set(name, result);
    return result;
}
