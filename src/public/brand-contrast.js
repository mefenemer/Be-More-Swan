/**
 * src/public/brand-contrast.js
 *
 * The colour maths behind every branded surface: is this readable on that, and if not, what is the
 * nearest shade of the same brand colour that is.
 *
 * WHY THIS FILE IS PLAIN .js AND UMD-ISH
 * --------------------------------------
 * Same reason as src/public/newsletter-findings.js. These functions run in two places:
 *   · server — src/utils/brand-kit.ts re-exports them (brand cards, and src/utils/brand-theme.ts,
 *              which resolves an organisation's newsletter theme when a design is created)
 *   · browser — src/components/newsletter-designer.js needs the identical answer when the author
 *               adds a button or changes the accent in the Style panel
 * A hand-written second copy in the browser drifts, and the drift here is invisible until it is in
 * somebody's inbox: a button created in the canvas would carry a different label colour from an
 * identical button created by the server from a template, in the same email.
 *
 * ⚠️ NOTHING HERE IS A PREFERENCE. Every threshold below is WCAG 2.1, which is a published
 * standard about human eyes — not a house style, and not something to relax because a particular
 * brand looks better slightly under it.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BrandContrast = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** A colour the renderer can actually paint with: #rgb / #rrggbb, normalized to lowercase #rrggbb. */
    function normalizeHex(raw) {
        if (typeof raw !== 'string') return null;
        var v = raw.trim().toLowerCase();
        var short = /^#([0-9a-f]{3})$/.exec(v);
        if (short) return '#' + short[1].split('').map(function (c) { return c + c; }).join('');
        return /^#[0-9a-f]{6}$/.test(v) ? v : null;
    }

    function channels(hex) {
        var h = normalizeHex(hex) || '#000000';
        return [0, 1, 2].map(function (i) { return parseInt(h.slice(1 + i * 2, 3 + i * 2), 16); });
    }

    /** WCAG 2.1 relative luminance (0 = black, 1 = white). */
    function relativeLuminance(hex) {
        var c = channels(hex).map(function (v) {
            var s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    /** HSL saturation, 0…1. Used to tell a brand accent apart from a grey/canvas/ink colour. */
    function saturation(hex) {
        var c = channels(hex).map(function (v) { return v / 255; });
        var max = Math.max(c[0], c[1], c[2]);
        var min = Math.min(c[0], c[1], c[2]);
        if (max === min) return 0;
        var l = (max + min) / 2;
        return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
    }

    /** WCAG contrast ratio between two colours, 1:1 … 21:1. */
    function contrastRatio(a, b) {
        var l1 = relativeLuminance(a);
        var l2 = relativeLuminance(b);
        var hi = l1 >= l2 ? l1 : l2;
        var lo = l1 >= l2 ? l2 : l1;
        return (hi + 0.05) / (lo + 0.05);
    }

    /** Large display type only needs 3:1 under WCAG; below that a colour is unusable as a headline. */
    var MIN_DISPLAY_CONTRAST = 3;

    /** WCAG AA for body text. A link is body text, whatever colour it is. */
    var MIN_BODY_CONTRAST = 4.5;

    /**
     * The foreground to write on `background`: white when it is legible there, otherwise the dark ink.
     *
     * Deliberately NOT "whichever contrasts most". Be More Swan's own accent is a case in point —
     * dark ink scores 4.4:1 on the neon pink versus white's 3.8:1, so a pure max-contrast rule would
     * set every bold card in near-black and quietly contradict the brand (and the brief, which asks
     * for a coloured field with white type). White is the design intent, so white wins whenever it
     * clears the display floor; a pale accent, where white would genuinely be unreadable, is what
     * falls back.
     *
     * If NEITHER clears the floor — an accent close to mid-grey — the better of the two is returned:
     * a slightly-under-threshold headline beats refusing to draw one.
     */
    function readableInkOn(background, ink) {
        var dark = ink || '#1f1e1b';
        var whiteRatio = contrastRatio('#ffffff', background);
        if (whiteRatio >= MIN_DISPLAY_CONTRAST) return '#ffffff';
        var darkRatio = contrastRatio(dark, background);
        return darkRatio >= MIN_DISPLAY_CONTRAST || darkRatio >= whiteRatio ? dark : '#ffffff';
    }

    /**
     * Blend two hex colours. `t` is how much of `b` to mix in (0 = all `a`, 1 = all `b`).
     */
    function mixHex(a, b, t) {
        var ca = channels(a);
        var cb = channels(b);
        var amount = Math.min(1, Math.max(0, Number(t) || 0));
        var out = [0, 1, 2].map(function (i) {
            var v = Math.round(ca[i] + (cb[i] - ca[i]) * amount);
            return ('0' + v.toString(16)).slice(-2);
        });
        return '#' + out.join('');
    }

    /** How far a correction is allowed to walk before it gives up and takes the best it found. */
    var CORRECTION_STEPS = 24;

    /**
     * `colour`, darkened or lightened just enough to be readable on `against`.
     *
     * Walks toward black on a light background and toward white on a dark one, in small steps, and
     * stops at the first shade that clears `min`. The brand hue survives — this is the same colour a
     * few shades deeper, not a different one — and a colour that already passes is returned unchanged.
     *
     * ⚠️ It stops at the FIRST shade that passes rather than going all the way. A "corrected" accent
     * that has walked to pure black stops reading as a brand colour at all, and at that point the
     * customer would rather see their own slightly-low-contrast pink.
     */
    function ensureContrast(colour, against, min) {
        var floor = typeof min === 'number' ? min : MIN_BODY_CONTRAST;
        var start = normalizeHex(colour);
        var bg = normalizeHex(against);
        if (!start || !bg) return start;
        if (contrastRatio(start, bg) >= floor) return start;

        // Toward whichever pole the background is not.
        var target = relativeLuminance(bg) > 0.5 ? '#000000' : '#ffffff';
        var best = start;
        var bestRatio = contrastRatio(start, bg);
        for (var step = 1; step <= CORRECTION_STEPS; step += 1) {
            var candidate = mixHex(start, target, step / CORRECTION_STEPS);
            var ratio = contrastRatio(candidate, bg);
            if (ratio > bestRatio) { best = candidate; bestRatio = ratio; }
            if (ratio >= floor) return candidate;
        }
        return best;
    }

    return {
        normalizeHex: normalizeHex,
        relativeLuminance: relativeLuminance,
        saturation: saturation,
        contrastRatio: contrastRatio,
        readableInkOn: readableInkOn,
        mixHex: mixHex,
        ensureContrast: ensureContrast,
        MIN_DISPLAY_CONTRAST: MIN_DISPLAY_CONTRAST,
        MIN_BODY_CONTRAST: MIN_BODY_CONTRAST,
    };
}));
