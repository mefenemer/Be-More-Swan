// src/utils/site-builders/framer.ts — Website import adapter for Framer.
// Findings, what is covered and what is not: docs/site-import-platforms/framer.md
// Tests: tests/site-platform-framer.test.ts (fixtures in tests/fixtures/site-platforms/framer/).
//
// Framer publishes pre-rendered HTML (React, hydrated later), so the words are in the page — but:
//  · each breakpoint (desktop / tablet / phone) is drawn separately, side by side, as
//    `.ssr-variant.hidden-<hash>` boxes that CSS hides by media query. Without help the import keeps
//    whichever copy comes first (sometimes the phone's: an h4 where the desktop has an h2) and reads
//    each picture twice at two sizes. We keep the desktop copy and drop the rest.
//  · the menu is usually plain <div>s and <a>s in the page's first component, with no <nav> or
//    <header>, so the import found no menu (and read no other page) and read the menu as content.
//  · a button is `<a><div><h6>Book now</h6></div></a>`, so it read as a heading, not a button.
//  · pictures are framerusercontent.com/images/<id>.jpg?scale-down-to=512&width=…&height=….
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** The width we read the page at: a laptop, so the desktop copy of each breakpoint set is kept. */
const READ_AT_WIDTH = 1280;

/**
 * Whether a breakpoint media query holds at `width`. Framer writes only min-width / max-width in px,
 * joined by "and"; anything else is "don't know" (null), and a box we can't judge is left alone.
 */
export function mediaHoldsAt(query: string, width: number): boolean | null {
    const parts = query.split(/\band\b/i).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    for (const p of parts) {
        const m = p.match(/^\(?\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)?$/i);
        if (!m) return null;
        const px = Number(m[2]);
        if (m[1].toLowerCase() === 'min' ? width < px : width > px) return false;
    }
    return true;
}

/** Each `hidden-<hash>` class → its media query: from #main's hydration data, else the page's <style>. */
function breakpointQueries($: cheerio.CheerioAPI): Map<string, string> {
    const out = new Map<string, string>();
    try {
        const raw = $('#main').attr('data-framer-hydrate-v2');
        const data = raw ? JSON.parse(raw) as { breakpoints?: Array<{ hash?: unknown; mediaQuery?: unknown }> } : null;
        for (const b of data?.breakpoints ?? []) {
            if (typeof b.hash === 'string' && typeof b.mediaQuery === 'string') out.set(b.hash, b.mediaQuery);
        }
    } catch { /* unreadable hydration data: fall back to the CSS */ }
    const css = $('style').map((_, el) => $(el).text()).get().join('\n');
    for (const m of css.matchAll(/@media\s*([^{]+?)\s*\{\s*\.hidden-([a-z0-9]+)\s*\{\s*display\s*:\s*none/gi)) {
        if (!out.has(m[2])) out.set(m[2], m[1]);
    }
    return out;
}

/** Drop every breakpoint copy a desktop visitor wouldn't see. */
function keepDesktopCopies($: cheerio.CheerioAPI): void {
    const queries = breakpointQueries($);
    const hiddenHere = new Set([...queries].filter(([, q]) => mediaHoldsAt(q, READ_AT_WIDTH) === true).map(([h]) => h));
    if (hiddenHere.size) {
        $('[class*="hidden-"]').filter((_, el) => ($(el).attr('class') ?? '').split(/\s+/).some((c) => c.startsWith('hidden-') && hiddenHere.has(c.slice(7)))).remove();
        return;
    }
    // No breakpoint list at all: of each run of side-by-side copies, keep the first.
    $('.ssr-variant').each((_, el) => {
        const prev = $(el).prev();
        if (prev.length && prev.hasClass('ssr-variant') && /\bhidden-/.test(prev.attr('class') ?? '') && /\bhidden-/.test($(el).attr('class') ?? '')) $(el).remove();
    });
}

const SAME_PAGE_LINK = (href: string | undefined) => !!href && !/^(mailto:|tel:|javascript:|#)/i.test(href.trim());

/**
 * The menu, when Framer drew it without <nav>/<header>: the page frame's first component, if it
 * holds links and no big heading. Wrapped in a <header>, so the import reads it as the menu (and its
 * picture as the logo) and leaves it out of the content. The component named "Footer" likewise.
 */
function markMenuAndFooter($: cheerio.CheerioAPI): void {
    const already = $('nav a[href], header a[href], [role="navigation"] a[href]').length > 0;
    if (!already) {
        // Framer puts <style> tags among the page's boxes (first in #main, beside components).
        const boxes = (el: cheerio.Cheerio<never> | ReturnType<cheerio.CheerioAPI>) => el.children().not('style, script, link, noscript, template');
        let frame = boxes($('#main')).first();
        for (let i = 0; i < 4 && boxes(frame).length === 1; i++) frame = boxes(frame).first();
        const kids = boxes(frame).toArray();
        const first = kids[0];
        if (first && kids.length > 1) {
            const $f = $(first);
            const links = $f.find('a[href]').filter((_, a) => SAME_PAGE_LINK($(a).attr('href'))).length;
            // One link is enough beside a logo: Framer's drop-down menus open with JavaScript, so a
            // menu of three drop-downs and "About" has a single link in the page.
            const logo = $f.find('[data-framer-name*="logo" i], img').length > 0;
            if ((links >= 2 || (links >= 1 && logo)) && !$f.find('h1, h2').length && $f.text().replace(/\s+/g, ' ').trim().length < 500) $f.wrap('<header data-framer-menu="true"></header>');
        }
    }
    $('[data-framer-name]').filter((_, el) => /^(site )?footer$/i.test($(el).attr('data-framer-name') ?? '') && !$(el).parents('footer').length)
        .each((_, el) => { $(el).wrap('<footer data-framer-footer="true"></footer>'); });
}

/**
 * A button: a short link (or <button>) whose words sit in one heading or paragraph of their own
 * (`<a><div><h6>Book now</h6></div></a>`). The link keeps only its words, so it stands alone and
 * reads as a button. Card links (a picture, a title and a line) are left as they are.
 */
function flattenButtons($: cheerio.CheerioAPI): void {
    $('a[href], button').each((_, el) => {
        const $el = $(el);
        if ($el.find('img, picture, video').length) return;
        const inner = $el.find('h1, h2, h3, h4, h5, h6, p');
        if (inner.length !== 1) return;
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40) return;
        // The words straight inside the link: the import calls a link a button only when nothing
        // block-like (Framer's wrapping <div>) sits directly in it.
        $el.text(text);
    });
}

/** A framerusercontent picture at the size the import should copy, or null when it is not one to change. */
function framerFullSize(src: string): string | null {
    try {
        const u = new URL(src);
        if (!/(^|\.)framerusercontent\.com$/.test(u.hostname) || !u.pathname.startsWith('/images/')) return null;
        if (!u.searchParams.has('scale-down-to')) return null;
        // The original, unless Framer says it is very large: then its own 2048 step (a camera's 6000px
        // original is not what a web page needs).
        const w = Number(u.searchParams.get('width'));
        u.searchParams.delete('scale-down-to');
        if (w > 2048) u.searchParams.set('scale-down-to', '2048');
        return u.toString();
    } catch { return null; }
}

/**
 * Pictures: one address each, the largest. Done on the page so the logo (which the shared reader
 * resizes without asking the adapter) gets it too.
 */
function fullSizePictures($: cheerio.CheerioAPI): void {
    $('img').each((_, el) => {
        const $el = $(el);
        let best: { url: string; w: number } | null = null;
        for (const part of ($el.attr('srcset') ?? '').split(',')) {
            const [url, size] = part.trim().split(/\s+/);
            if (!url) continue;
            const w = size ? parseFloat(size) : 0;
            if (!best || w > best.w) best = { url, w };
        }
        const src = best?.url ?? $el.attr('src') ?? '';
        if (!/framerusercontent\.com\/images\//.test(src)) return;
        $el.attr('src', framerFullSize(src) ?? src);
        $el.removeAttr('srcset');
    });
}

/**
 * Framer's Maps component frames maps.google.com/maps?q=…&output=embed; the import turns only
 * google.com/maps/embed frames into a "See us on the map" button, so say it that way.
 */
function mapsToEmbed($: cheerio.CheerioAPI): void {
    $('iframe[src]').each((_, el) => {
        try {
            const u = new URL($(el).attr('src') ?? '');
            if (!/^(maps|www)\.google\.[a-z.]+$/.test(u.hostname) || !/^\/maps\/?$/.test(u.pathname) || u.searchParams.get('output') !== 'embed') return;
            u.searchParams.delete('output');
            $(el).attr('src', `https://www.google.com/maps/embed?${u.searchParams.toString()}`);
        } catch { /* not a map */ }
    });
}

export const adapter: BuilderAdapter = {
    key: 'framer',
    label: 'Framer',
    detect: (html, gen) => gen.includes('framer') || /framerusercontent\.com|data-framer-/.test(html),
    prepare($) {
        keepDesktopCopies($);
        // Framer's own furniture: the "Made in Framer" badge and the cookie banner component.
        $('#__framer-badge-container, .__framer-badge, [data-framer-name*="cookie" i]').remove();
        // A <select>'s choices are read into its label ("Which class?Select…Beginners…"): the
        // question is the label's own words.
        $('form option').remove();
        markMenuAndFooter($);
        flattenButtons($);
        fullSizePictures($);
        mapsToEmbed($);
    },
    contentRoot: '#main',
    noise: /^(made (in|with) framer|built (in|with) framer|create a free website with framer\b.*|this site was (made|built) with framer\b.*)$/i,
    fullSizeImage: (src) => framerFullSize(src),
    rendersWithJs: false,
};
