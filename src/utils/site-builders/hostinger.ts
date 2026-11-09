// src/utils/site-builders/hostinger.ts — Website import adapter for Hostinger Website Builder
// (formerly Zyro; its AI Builder makes the same pages).
// Findings, what is covered and what is not: docs/site-import-platforms/hostinger.md
// Tests: tests/site-platform-hostinger.test.ts (fixtures in tests/fixtures/site-platforms/hostinger/).
//
// The pages are drawn on the server (Astro, with Vue islands), so the words are in the HTML. What
// trips a plain read: the site header and footer sit INSIDE <main>; every picture's srcset holds
// Cloudflare resize addresses with commas in them (".../format=auto,w=375,h=273,fit=crop/..."), which
// a comma-split srcset reader cuts into broken addresses; each picture is drawn twice (desktop and
// phone copies); and "Embed code" boxes are empty <div>s filled by JavaScript from the island's props.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Astro serialises island props as [type, value] pairs: 0 = plain value / object, 1 = array. */
function decodeProp(v: unknown, depth = 0): unknown {
    if (depth > 60) return null;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
        if (v[0] === 1 && Array.isArray(v[1])) return v[1].map((x) => decodeProp(x, depth + 1));
        if (v[0] === 0) return decodeObject(v[1], depth + 1);
        return null;   // dates, maps, regexps…: nothing we read
    }
    return decodeObject(v, depth + 1);
}
function decodeObject(v: unknown, depth: number): unknown {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, decodeProp(x, depth)]));
}

interface PageData { blocks?: Record<string, { slot?: unknown }>; elements?: Record<string, { type?: unknown; content?: unknown }>; }

/** The page's own data (blocks and elements) from the Astro island that draws the page, or null. */
function readPageData($: cheerio.CheerioAPI): PageData | null {
    for (const el of $('astro-island[props]').toArray()) {
        const raw = $(el).attr('props') ?? '';
        if (!raw.includes('pageData')) continue;
        try {
            const props = decodeProp(JSON.parse(raw)) as { pageData?: PageData } | null;
            if (props?.pageData && typeof props.pageData === 'object') return props.pageData;
        } catch { /* a page we can't decode is read as it is */ }
    }
    return null;
}

/** Each entry of a srcset, read whole: Hostinger's addresses contain commas, so never split on ",". */
function largestOf(srcset: string): string | null {
    let best: { url: string; w: number } | null = null;
    for (const m of srcset.matchAll(/(\S+?)\s+(\d+(?:\.\d+)?)([wx])\s*(?:,|$)/g)) {
        const w = parseFloat(m[2]) * (m[3] === 'x' ? 1000 : 1);
        if (!best || w > best.w) best = { url: m[1].replace(/^,/, ''), w };
    }
    return best?.url ?? null;
}

const MAX_EMBED = 200_000;

export const adapter: BuilderAdapter = {
    key: 'hostinger',
    // Hostinger's own interface palette (--color-meteorite, --color-primary-dark …) is not the owner's:
    // its purple came out as every site's brand colour. Taken out before the look is read (main session, 2026-11-09).
    lookCss: ({ html, css }) => {
        const builder = /[^{}]*\{[^{}]*--color-(?:meteorite|primary-dark|primary-light)[^{}]*\}/gi;
        return { html: html.replace(builder, ''), css: css.replace(builder, '') };
    },
    label: 'Hostinger Website Builder',
    // "Hostinger Website Builder" / "Hostinger AI Builder" (older: "Zyro") in the generator tag; else
    // pictures on Hostinger's own picture host together with the builder's grid markup. The bare word
    // "zyro" is not enough: a blog post reviewing site builders says it too.
    detect: (html, gen) =>
        /\bhostinger\b.*\bbuilder\b|^zyro\b/.test(gen)
        || (/\b(?:assets|cdn|userapp)\.zyrosite\.com\//.test(html) && /\b(?:block-header|layout-element__component--Grid)/.test(html))
        || (/\blayout-element__component--Grid(?:TextBox|Image|Button)\b/.test(html) && /\bclass="page__blocks"/.test(html)),
    prepare: ($) => {
        const data = readPageData($);
        const main = $('main').first();

        // "Embed code" boxes: their HTML lives only in the island's props. Put it where the box is,
        // without its <head>-ish parts; scripts and styles go with the rest of the page's (site-extract).
        const elements = data?.elements ?? {};
        $('.grid-embed[id], .layout-element__component--GridEmbed[id]').each((_, el) => {
            const $el = $(el);
            if ($el.text().trim()) return;
            const e = elements[$el.attr('id') ?? ''];
            if (!e || e.type !== 'GridEmbed' || typeof e.content !== 'string' || e.content.length > MAX_EMBED) return;
            $el.html(e.content);
            $el.find('meta, title, link, base, style, script, noscript').remove();
        });

        // The site header sits inside <main>: move it out, so the menu and logo are read from it and
        // it is not read as content. The cart button and burger are the builder's, not the owner's.
        $('.block-header-cart-wrapper, .block-header-cart, .cart-drawer, .block-header__hamburger-menu').remove();
        if (main.length) $('header.block-header, .block-header').filter((_, el) => $(el).closest('main').length > 0 && $(el).parents('.block-header').length === 0).each((_, el) => { main.before(el); });
        // Drop-down boxes: named like one, so the menu keeps its group ("Flowers" › Weddings, Workshops).
        $('.block-header-item__dropdown-area').addClass('sub-menu');

        // The footer is a block like any other, inside <main>: make it a <footer> outside it (its
        // email, phone and social links are still read from the whole page, site-extract).
        const footerIds = new Set(Object.entries(data?.blocks ?? {}).filter(([, b]) => b && b.slot === 'footer').map(([id]) => id));
        const footers = $('section.block').filter((_, el) => footerIds.has($(el).attr('id') ?? '') || $(el).hasClass('block--footer') || $(el).attr('data-pagefind-ignore') === 'all');
        footers.each((_, el) => {
            (el as unknown as { name: string; tagName: string }).name = 'footer';
            (el as unknown as { name: string; tagName: string }).tagName = 'footer';
            if (main.length && $(el).closest('main').length) main.after(el);
        });

        // Hidden on both computers and phones: not on their site at all.
        $('.layout-element--desktop-element-hidden.layout-element--mobile-element-hidden').remove();
        // Every picture is drawn twice; the phone copy goes when its desktop copy is there.
        $('.image-wrapper--mobile').filter((_, el) => $(el).siblings('.image-wrapper--desktop').length > 0).remove();

        // Srcsets with commas inside their addresses: read whole here, keep the largest as the src.
        $('img[srcset], img[data-srcset], source[srcset]').each((_, el) => {
            const $el = $(el);
            const set = $el.attr('srcset') ?? $el.attr('data-srcset') ?? '';
            if (!/\/cdn-cgi\/image\/[^/\s]*,/.test(set)) return;
            const best = largestOf(set);
            if (best && el.type === 'tag' && el.name === 'img') $el.attr('src', best);
            $el.removeAttr('srcset').removeAttr('data-srcset');
        });
    },
    contentRoot: '.page__blocks',
    noise: /^(shopping bag|your (shopping )?bag is empty|add to (bag|cart)|sold out|out of stock|(website )?(made|built|created) with hostinger.*|powered by (hostinger|zyro).*)$/i,
    // Cloudflare resizes on Hostinger's picture host (custom domains have no /cdn-cgi/image/ — checked
    // 2026-11-08): ask for one 1600-wide copy instead of the 375- or 768-wide one the page asked for
    // (PNG stays PNG; WebP comes back as JPEG to a plain fetcher). Unsplash pictures
    // chosen in the builder come cropped to each layout: one 1600-wide copy, uncropped.
    fullSizeImage: (src) => {
        try {
            const u = new URL(src);
            const m = u.pathname.match(/^\/cdn-cgi\/image\/([^/]+)\/(.+)$/);
            if (m && /(^|\.)zyrosite\.com$/.test(u.hostname) && /(^|,)(w|width|h|height|fit)=/.test(m[1])) {
                if (/^https?:\/\//.test(m[2])) return null;   // another host behind Cloudflare: kept as it is
                return `${u.origin}/cdn-cgi/image/w=1600,fit=scale-down/${m[2]}`;
            }
            if (u.hostname === 'images.unsplash.com' && (u.searchParams.has('w') || u.searchParams.has('h'))) {
                u.searchParams.delete('h');
                u.searchParams.set('w', '1600');
                u.searchParams.set('fit', 'max');
                return u.toString();
            }
            return null;
        } catch { return null; }
    },
    rendersWithJs: false,
};
