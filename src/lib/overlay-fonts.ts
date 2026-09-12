// src/lib/overlay-fonts.ts
//
// The typefaces a text overlay can be set in — and, more to the point, the guarantee that the
// reviewer's preview and the published video are set in the SAME one.
//
// ── The bug this exists to close ────────────────────────────────────────────────────────────────
// The editor offered OS fonts (Arial, Impact, Georgia…) and passed the bare family name through to
// the renderer. A Mac has those fonts. Lambda's Amazon Linux does not, and Chrome substitutes
// SILENTLY — no warning, no error, a perfectly good-looking video that is simply not the one the
// reviewer approved. Proven 2026-09-10 by rendering one frame on Lambda and the same frame locally:
// different letterforms, and a visibly narrower box, because the box is sized by the rendered text.
// So the geometry moved, not just the shapes.
//
// ── The fix, and why it is a webfont rather than a metric clone ─────────────────────────────────
// The instinct is "ship metric-compatible clones so the fallback is harmless". That is worth having,
// but it is the safety net, not the mechanism. What actually removes the divergence is both
// environments loading the SAME file: the editor and the Remotion bundle each fetch these families
// from Google Fonts, so neither is relying on a font that happens to be installed locally.
//
// Metric compatibility then covers the failure case. Four of these are true metric clones of the OS
// face they replace (Arimo→Arial/Helvetica, Tinos→Times New Roman, Cousine→Courier New,
// Gelasio→Georgia): if the download fails and the Mac falls back to the real font, the box is still
// the same size. The other five have no metric clone in existence — they are deliberate visual
// substitutions, and they are still an improvement, because today those render as whatever Lambda
// picks, previewed as something else entirely.
//
// ── Stored values never change ──────────────────────────────────────────────────────────────────
// `id` is what lives in scheduled_posts.image_overlays on rows that are already scheduled. It stays
// exactly as it was: this module changes what a name RESOLVES to, not what is written down. No
// migration, and a post drafted before this shipped renders correctly after it.

export interface OverlayFont {
    /** The stored `fontFamily` value. Never change one — live overlay rows carry it. */
    id: string;
    /** What the picker shows. */
    label: string;
    /** The Google Fonts family loaded in BOTH the editor and the render. */
    google: string;
    /** Webfont first, then the OS face it stands in for, then a generic that always resolves. */
    stack: string;
    /**
     * True where `google` is metric-compatible with `id` — same advance widths, so a fallback keeps
     * the box the same size. False where the substitution is visual only; those are listed so the
     * difference is a decision on the record rather than a surprise.
     */
    metricClone: boolean;
}

export const OVERLAY_FONTS: readonly OverlayFont[] = [
    { id: 'Arial',           label: 'Arial',           google: 'Arimo',      stack: `'Arimo', Arial, Helvetica, sans-serif`,                  metricClone: true },
    { id: 'Helvetica',       label: 'Helvetica',       google: 'Arimo',      stack: `'Arimo', Helvetica, Arial, sans-serif`,                  metricClone: true },
    { id: 'Georgia',         label: 'Georgia',         google: 'Gelasio',    stack: `'Gelasio', Georgia, serif`,                              metricClone: true },
    { id: 'Times New Roman', label: 'Times New Roman', google: 'Tinos',      stack: `'Tinos', 'Times New Roman', Times, serif`,               metricClone: true },
    { id: 'Courier New',     label: 'Courier New',     google: 'Cousine',    stack: `'Cousine', 'Courier New', Courier, monospace`,           metricClone: true },
    // No metric clone of these exists anywhere, so the substitution is a visual judgement:
    //   Verdana      → Open Sans   (humanist, large x-height; the nearest common face)
    //   Trebuchet MS → Cabin       (humanist sans, the usual stand-in)
    //   Impact       → Anton       (the standard condensed-heavy substitute; matters because Impact
    //                               is what people reach for on social)
    //   Comic Sans   → Comic Neue  (a deliberate redraw of Comic Sans)
    { id: 'Verdana',         label: 'Verdana',         google: 'Open Sans',  stack: `'Open Sans', Verdana, Geneva, sans-serif`,               metricClone: false },
    { id: 'Trebuchet MS',    label: 'Trebuchet MS',    google: 'Cabin',      stack: `'Cabin', 'Trebuchet MS', sans-serif`,                    metricClone: false },
    { id: 'Impact',          label: 'Impact',          google: 'Anton',      stack: `'Anton', Impact, 'Arial Narrow Bold', sans-serif`,       metricClone: false },
    { id: 'Comic Sans MS',   label: 'Comic Sans',      google: 'Comic Neue', stack: `'Comic Neue', 'Comic Sans MS', cursive`,                 metricClone: false },
];

const BY_ID = new Map(OVERLAY_FONTS.map(f => [f.id.toLowerCase(), f]));

/** The default, and the fallback for anything unrecognised. */
export const DEFAULT_OVERLAY_FONT = OVERLAY_FONTS[0];

export function overlayFont(id: string | null | undefined): OverlayFont {
    return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? DEFAULT_OVERLAY_FONT;
}

/**
 * The CSS font stack for a stored family name.
 *
 * Everything that draws an overlay goes through here — the editor preview, the browser bake and the
 * Remotion composition — so there is one answer to "what does 'Impact' mean" rather than three.
 */
export function overlayFontStack(id: string | null | undefined): string {
    return overlayFont(id).stack;
}

/** The Google families a set of overlays actually needs, de-duplicated. */
export function googleFamiliesFor(ids: Array<string | null | undefined>): string[] {
    const out: string[] = [];
    for (const id of ids) {
        const family = overlayFont(id).google;
        if (!out.includes(family)) out.push(family);
    }
    return out;
}

/**
 * A Google Fonts stylesheet URL for exactly these families, or null for none.
 *
 * Weight 400 only, deliberately: an overlay has no bold control, so asking for 700 would download a
 * face nothing can select. It also keeps the URL valid — Anton publishes a single weight, and a
 * `wght@400;700` on it is a 400 from Google, which would fail the whole stylesheet and silently put
 * every font back to a fallback.
 */
export function googleFontsHref(families: string[]): string | null {
    if (!families.length) return null;
    const params = families.map(f => `family=${encodeURIComponent(f).replace(/%20/g, '+')}`).join('&');
    return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

/** Every family this feature can ask for — for the editor, which offers all of them at once. */
export const ALL_OVERLAY_GOOGLE_FAMILIES: string[] = googleFamiliesFor(OVERLAY_FONTS.map(f => f.id));
