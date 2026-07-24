// src/utils/brand-extract.ts — derive an org's visual brand from its own website.
//
// Phase 2 of the brand-card epic. Phase 1 gave every org a card; orgs that never fill in a brand
// kit get the neutral monochrome default, which is safe but anonymous. Most SMBs will never open a
// brand-kit form — but they all have a website that already encodes the answer.
//
// SHAPE OF THE PROBLEM: a homepage contains dozens of colours and exactly one of them is "the brand
// colour". Getting that wrong is worse than the neutral default, because a confidently-wrong purple
// looks like a bug on every post. So this module is built as harvest → classify → (optionally) let
// a model choose among the harvested candidates. The model may only PICK FROM the list; it can
// never introduce a colour that isn't demonstrably on the site. That constraint is the whole
// safety story — an LLM asked "what colour is this brand" free-hand will happily invent one.
//
// The harvest is pure (HTML + CSS strings in, signals out) so the ranking can be tested against
// real-world page shapes with no network. Fetching lives in brand-extract-fetch.ts.

import * as cheerio from 'cheerio';
import {
    normalizeHex, relativeLuminance, saturation, contrastRatio, cleanFontFamily,
    DEFAULT_BRAND_KIT, MIN_DISPLAY_CONTRAST, type BrandKit,
} from './brand-kit';

/** One colour found on the page, with why we think it matters. */
export interface ColourCandidate {
    hex: string;
    /** Higher = more likely to be THE brand colour. See SOURCE_WEIGHT. */
    score: number;
    /** Where it was found, for the audit trail and for the model prompt. */
    reasons: string[];
}

export interface BrandSignals {
    candidates: ColourCandidate[];
    /** Near-white colours, lightest first — background candidates. */
    lights: string[];
    /** Near-black colours, darkest first — ink candidates. */
    darks: string[];
    wordmark: string | null;
    fontFamily: string | null;
    /** Same-origin stylesheet URLs worth fetching for a second pass. */
    stylesheets: string[];
}

// Why a colour was found, ranked. A CSS variable literally named "--brand-primary" is a designer
// telling us the answer; a hex that merely appears a lot might just be a border.
//
// CATEGORICAL EVIDENCE COUNTS ONCE. This is the correction that made the ranking work on real
// sites. Summing every occurrence meant monzo.com's near-black (#091723) scored 385 purely because
// it fills a lot of buttons, burying their actual coral (#ff4f40) — which the site labels
// `--color-brand`, the most authoritative name there is — at rank 6. Being a button fill twenty
// times over is not twenty times the evidence that a colour is the brand.
const SOURCE_WEIGHT = {
    exactBrandVar: 140, // --brand / --color-brand: a token named for the brand and nothing else
    exactAccentVar: 110, // --accent / --color-blue-accent: an accent, but not a claim to BE the brand
    brandVar: 100,      // --brand-600 / --primary-500: a step on a brand ramp
    themeColor: 80,     // <meta name="theme-color"> — the browser-chrome colour
    secondaryVar: 45,   // --secondary / --highlight
    button: 30,         // fill colour of a call-to-action
    frequency: 1,       // per occurrence in CSS, capped
} as const;

const FREQUENCY_CAP = 25;

/**
 * How much a numbered token step is worth relative to a plain name.
 *
 * A design-token ramp (--brand-50 … --brand-950) names a dozen colours "brand", and the accent is
 * the MIDDLE of it: the extremes are the tint used for backgrounds and the shade used for dark
 * text. stripe.com is the case in point — its darkest step (#1c1e54, brand-900/925) was winning
 * over the actual Stripe indigo at brand-600.
 */
/*  Weight peaks at 500–600 rather than sitting flat across 400–700, because that is where every
 *  mainstream token scale (Tailwind, Material, Radix) puts the primary. A flat band left the
 *  choice between --brand-400 and --brand-600 to whichever appeared more often, which is a real
 *  signal on a big site and pure luck on a small one. */
export function rampWeight(step: number | null): number {
    if (step === null) return 1;
    if (step >= 500 && step <= 600) return 1;
    if (step >= 400 && step <= 700) return 0.92;
    if (step >= 300 && step <= 800) return 0.7;
    if (step >= 200 && step <= 900) return 0.45;
    return 0.25;
}

// A brand accent has to be a COLOUR, not the page's canvas or its body text. Without these bounds
// the winner is almost always #ffffff or #000000 by sheer frequency.
//
// SATURATION does nearly all the work, and the threshold is set by a specific near-miss: a typical
// near-black body ink (#12131a) still scores ~0.18, so a looser bar lets body text be crowned the
// brand colour. Brand accents sit far above 0.25; neutral greys sit far below.
//
// The LUMINANCE floor is deliberately almost zero. It was 0.02 and that was a bug: a dark navy
// (#0b2545 — one of the most common SMB brand colours there is) computes to 0.0200 and was being
// rejected as "too dark to be a colour". Saturation already excludes true ink, so this only needs
// to catch near-black.
const MIN_ACCENT_SATURATION = 0.25;
const MAX_ACCENT_LUMINANCE = 0.82;
const MIN_ACCENT_LUMINANCE = 0.005;

const LIGHT_LUMINANCE = 0.85;
const DARK_LUMINANCE = 0.2;

/** Colour literals: #rgb, #rrggbb, rgb()/rgba(). Named CSS colours are deliberately ignored —
 *  they are vanishingly rare in a real brand stylesheet and add a 148-entry table for nothing. */
const COLOUR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;

/** Parse one colour literal to #rrggbb, dropping anything transparent or unparseable. */
export function parseColour(raw: string): string | null {
    const v = raw.trim().toLowerCase();

    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
    if (rgb) {
        // A near-transparent colour is not a brand colour — it's a shadow or an overlay.
        if (rgb[4] !== undefined && Number(rgb[4]) < 0.5) return null;
        const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
        if ([r, g, b].some((c) => c > 255)) return null;
        return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    }

    // 8-digit hex carries alpha in the last pair; same transparency rule.
    if (/^#[0-9a-f]{8}$/.test(v)) {
        return parseInt(v.slice(7, 9), 16) < 128 ? null : normalizeHex(v.slice(0, 7));
    }
    if (/^#[0-9a-f]{4}$/.test(v)) {
        return parseInt(v[4] + v[4], 16) < 128 ? null : normalizeHex(v.slice(0, 4));
    }
    return normalizeHex(v);
}

/** Whether a colour is plausible as a brand accent (not canvas, not ink, not grey). */
export function isAccentCandidate(hex: string): boolean {
    const lum = relativeLuminance(hex);
    return saturation(hex) >= MIN_ACCENT_SATURATION
        && lum <= MAX_ACCENT_LUMINANCE
        && lum >= MIN_ACCENT_LUMINANCE;
}

/**
 * Harvest colour/logo/type signals from a page and its CSS.
 *
 * `css` is the concatenation of inline <style> blocks and any fetched stylesheets — the caller
 * decides how much to gather, this only ranks what it is given.
 */
export function harvestBrandSignals(html: string, baseUrl: string, css = ''): BrandSignals {
    const $ = cheerio.load(html);
    const base = safeBase(baseUrl);

    // Best categorical weight per colour (NOT the sum — see SOURCE_WEIGHT), plus the reasons that
    // produced it, so the model prompt and the audit trail can show the evidence.
    const best = new Map<string, number>();
    const reasons = new Map<string, string[]>();
    const add = (raw: string | null | undefined, weight: number, reason: string): void => {
        if (!raw) return;
        const hex = parseColour(raw);
        if (!hex) return;
        best.set(hex, Math.max(best.get(hex) ?? 0, weight));
        const list = reasons.get(hex) ?? [];
        if (!list.includes(reason)) list.push(reason);
        reasons.set(hex, list);
    };

    // Inline <style> blocks travel with the HTML, so they are always available even when the
    // caller fetched no stylesheets.
    const inlineCss = $('style').map((_, el) => $(el).text()).get().join('\n');
    const allCss = `${inlineCss}\n${css}`;

    // 1. CSS custom properties. The strongest signal by far — a designer named these.
    for (const m of allCss.matchAll(/--([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
        const name = m[1].toLowerCase();
        const value = m[2].trim();
        // Skip var() indirection: "--brand: var(--pink-500)" names no colour of its own, and the
        // colour it points at is harvested on its own line anyway.
        if (value.startsWith('var(')) continue;
        if (/(^|-)(brand|primary|accent|main)(-|$)/.test(name)) {
            // "--brand-600" is one step of a ramp; "--color-brand" is the brand itself. The
            // optional trailing letter catches alpha variants like Stripe's "--brand-400a", which
            // without it read as an unnumbered token and outranked the real accent.
            const step = /-(\d{2,3})[a-z]?$/.exec(name);
            const numbered = step ? Number(step[1]) : null;
            // A token calling itself the BRAND is a stronger claim than one calling itself an
            // accent — monzo.com labels its coral --color-brand and its blue --color-blue-accent,
            // and only the first is the brand colour.
            const exact = /(^|-)(brand|primary)(-|$)/.test(name)
                ? SOURCE_WEIGHT.exactBrandVar : SOURCE_WEIGHT.exactAccentVar;
            const base = numbered === null ? exact : SOURCE_WEIGHT.brandVar;
            add(value, Math.round(base * rampWeight(numbered)), `--${name}`);
        } else if (/(^|-)(secondary|highlight|cta)(-|$)/.test(name)) {
            add(value, SOURCE_WEIGHT.secondaryVar, `--${name}`);
        }
    }

    // 2. theme-color — what the site tells a browser to paint its chrome. Almost always the brand.
    add($('meta[name="theme-color"]').attr('content'), SOURCE_WEIGHT.themeColor, 'meta theme-color');

    // 3. Button/CTA fills. A call-to-action is where a brand puts its accent.
    for (const m of allCss.matchAll(/\.(?:[\w-]*(?:btn|button|cta)[\w-]*)[^{]*\{([^}]*)\}/gi)) {
        const bg = /background(?:-color)?\s*:\s*([^;]+)/i.exec(m[1]);
        add(bg?.[1], SOURCE_WEIGHT.button, 'button fill');
    }

    // 4. Raw frequency across all CSS, capped so a utility framework's 500 greys can't win by bulk.
    const counts = new Map<string, number>();
    for (const m of allCss.matchAll(COLOUR_RE)) {
        const hex = parseColour(m[0]);
        if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    // Frequency is the one signal that legitimately accumulates, so it is added to the best
    // categorical weight rather than competing with it — it breaks ties between equally-named
    // colours without ever being able to outvote a named token on its own.
    const all: ColourCandidate[] = [];
    for (const hex of new Set([...best.keys(), ...counts.keys()])) {
        const n = counts.get(hex) ?? 0;
        const list = reasons.get(hex) ?? [];
        if (n) list.push(`used ${n}×`);
        all.push({ hex, score: (best.get(hex) ?? 0) + Math.min(n, FREQUENCY_CAP) * SOURCE_WEIGHT.frequency, reasons: list });
    }
    const candidates = all
        .filter((c) => isAccentCandidate(c.hex))
        .sort((a, b) => b.score - a.score);

    // Canvas and ink come from the same harvest but are ranked differently, and the difference
    // matters. The canvas is whichever near-white the page actually uses most, so lights go by
    // score. Ink CANNOT go by score: a named brand navy outscores the body colour and is itself
    // dark, so scoring would set every card's footer in the accent and call it the text colour.
    // The darkest colour on the page is the body ink, essentially always.
    const lights = all.filter((c) => relativeLuminance(c.hex) >= LIGHT_LUMINANCE)
        .sort((a, b) => b.score - a.score || relativeLuminance(b.hex) - relativeLuminance(a.hex))
        .map((c) => c.hex);
    const darks = all.filter((c) => relativeLuminance(c.hex) <= DARK_LUMINANCE)
        .sort((a, b) => relativeLuminance(a.hex) - relativeLuminance(b.hex))
        .map((c) => c.hex);

    return {
        candidates,
        lights,
        darks,
        wordmark: findWordmark($),
        fontFamily: findFontFamily($, allCss),
        stylesheets: findStylesheets($, base),
    };
}

function safeBase(raw: string): URL | null {
    try { return new URL(raw); } catch { return null; }
}

function absolute(base: URL | null, href: string | undefined): string | null {
    if (!href || !base) return null;
    try {
        const u = new URL(href, base);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch { return null; }
}

// NO AUTOMATIC LOGO EXTRACTION — deliberate, and the result of seeing it rendered.
//
// Cards come in two polarities, so a logo has to survive both a light canvas and a dark brand
// field. Nothing about a fetched image tells us it will: a favicon or touch-icon is usually a mark
// on transparency, and a dark-on-transparent logo vanishes on the bold variant while a
// light-on-transparent one vanishes on the light variant. Extracting stripe.com's favicon produced
// a white sliver in the corner of every card; the wordmark-only cards look right every time,
// because text is drawn in a colour we have already contrast-checked.
//
// BrandKit.logoUrl still works and is still rendered — it is just set by a human who has seen
// their own logo and can judge it, via the PATCH on netlify/functions/brand-kit.ts.

function findWordmark($: cheerio.CheerioAPI): string | null {
    const raw = $('meta[property="og:site_name"]').attr('content')
        || $('meta[name="application-name"]').attr('content')
        || $('title').first().text();
    if (!raw) return null;
    // A <title> is usually "Brand — tagline | Category"; the brand is the first segment.
    const first = raw.split(/[|–—·:]/)[0].trim();
    return first.length >= 2 && first.length <= 32 ? first : null;
}

function findFontFamily($: cheerio.CheerioAPI, css: string): string | null {
    // A Google Fonts <link> names the display family explicitly and unambiguously.
    const gf = $('link[href*="fonts.googleapis.com"]').attr('href');
    if (gf) {
        const fam = /family=([^:&]+)/.exec(gf)?.[1];
        const cleaned = cleanFontFamily(decodeURIComponent(fam ?? '').replace(/\+/g, ' '));
        if (cleaned) return cleaned;
    }
    // Otherwise the first family named on body/:root, skipping the generic fallbacks.
    const decl = /(?:body|:root|html)[^{]*\{[^}]*font-family\s*:\s*([^;}]+)/i.exec(css)?.[1];
    for (const part of (decl ?? '').split(',')) {
        const cleaned = cleanFontFamily(part);
        if (cleaned && !/^(sans|serif|monospace|system|ui|inherit|initial|arial|helvetica)/i.test(cleaned)) return cleaned;
    }
    return null;
}

/**
 * Stylesheets worth fetching, same-origin first.
 *
 * This started as a same-origin-ONLY rule, on the reasoning that third-party CSS describes someone
 * else's design system. Checked against real sites, that reasoning was wrong and the rule was
 * severe: stripe.com serves its own compiled CSS from b.stripecdn.com, and every Next.js/Vercel/
 * Shopify/Squarespace site does the same. Same-origin-only found zero stylesheets on most real
 * business websites — which is most of the addressable market.
 *
 * Cross-origin is safe to follow because every fetch goes through safeFetchText (full SSRF checks
 * on each hop, byte cap, timeout). What it costs is NOISE, so same-origin still sorts first and the
 * caller takes only the first few, and hosts that are definitionally not the brand are dropped.
 */
const NON_BRAND_CSS_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|cdn\.cookielaw\.org|consent\.cookiebot\.com)$/i;

function findStylesheets($: cheerio.CheerioAPI, base: URL | null): string[] {
    if (!base) return [];
    const sameOrigin: string[] = [];
    const other: string[] = [];
    $('link[rel="stylesheet"]').each((_, el) => {
        const url = absolute(base, $(el).attr('href'));
        if (!url) return;
        const { origin, hostname } = new URL(url);
        if (NON_BRAND_CSS_HOSTS.test(hostname)) return;
        const bucket = origin === base.origin ? sameOrigin : other;
        if (!bucket.includes(url)) bucket.push(url);
    });
    return [...sameOrigin, ...other];
}

/**
 * Turn harvested signals into a kit, choosing the accent deterministically (highest score).
 *
 * `chosenAccent` lets the caller substitute a model's pick; it is validated against the candidate
 * list, so a model that returns something not on the page is ignored rather than trusted.
 */
export function signalsToBrandKit(
    signals: BrandSignals,
    opts: { website?: string | null; chosenAccent?: string | null; now?: Date } = {},
): BrandKit | null {
    const now = opts.now ?? new Date();
    const picked = normalizeHex(opts.chosenAccent ?? null);
    const accent = (picked && signals.candidates.some((c) => c.hex === picked) ? picked : null)
        ?? signals.candidates[0]?.hex
        ?? null;

    // No usable accent means the extraction FAILED. Returning a kit built entirely from defaults
    // would mark the org 'website'-sourced and suppress the retry, permanently freezing it on the
    // neutral palette it would have had anyway.
    if (!accent) return null;

    const background = signals.lights[0] ?? DEFAULT_BRAND_KIT.backgroundColor;
    const ink = signals.darks[0] ?? DEFAULT_BRAND_KIT.textColor;

    return {
        primaryColor: accent,
        // A site whose body text is barely darker than its canvas would hand the card an
        // unreadable footer; fall back to the known-good ink rather than inheriting the problem.
        textColor: contrastRatio(ink, background) >= MIN_DISPLAY_CONTRAST ? ink : DEFAULT_BRAND_KIT.textColor,
        backgroundColor: background,
        wordmark: signals.wordmark,
        logoUrl: null,   // never auto-set — see the note above findWordmark
        website: opts.website ?? null,
        fontFamily: signals.fontFamily,
        source: 'website',
        extractedAt: now.toISOString(),
        lastExtractAttemptAt: now.toISOString(),
    };
}
