// src/utils/site-builders/hubspot.ts — Website import adapter for HubSpot Content Hub (CMS Hub, formerly COS).
// Findings, what is covered and what is not: docs/site-import-platforms/hubspot.md
// Tests: tests/site-platform-hubspot.test.ts (fixtures in tests/fixtures/site-platforms/hubspot/).
//
// HubSpot pages are server-rendered from HubL templates, so the words are in the HTML. What gets in the
// way: older templates draw the header, menu and footer in plain <div>s; forms, chat, the cookie bar
// and "image CTAs" are drawn by HubSpot's scripts; drag-and-drop sections keep their background
// picture in a <style> block; links carry ?hsLang= and tracking parameters; pictures are resized.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** HubSpot's own furniture: cookie bar, chat, search, language switcher, share buttons, blog extras. */
const FURNITURE = [
    '#hs-banner-parent', '#hs-eu-cookie-confirmation', '#hubspot-messages-iframe-container', '.hs-messages-widget-open-button',
    '#hs-web-interactives-top-push-anchor', '#hs-web-interactives-top-anchor', '#hs-web-interactives-floating-container',
    '.header__skip', '.lang_switcher_class', '.hs_cos_wrapper_type_language_switcher', '.header__language-switcher',
    '.hs-search-field', '.hs_cos_wrapper_type_social_sharing', '.hs-social-share-link',
    '.blog-comments', '.hs_cos_wrapper_type_blog_comments', '#comments-listing',
    '.blog-related-posts', '.hs_cos_wrapper_type_related_blog_posts', '.hs_cos_wrapper_type_blog_subscribe',
    '.hs_cos_wrapper_type_post_listing', '.hs_cos_wrapper_type_rss_listing', '.hs_cos_wrapper_type_post_filter',
    '.blog-post__meta', '.blog-post__tags', '.blog-post__author', '.blog-pagination',
].join(', ');

/** Query parameters HubSpot adds to links that are not part of where the link goes. */
const LINK_PARAMS = ['hsLang', '__hstc', '__hssc', '__hsfp', '_hsenc', '_hsmi', 'hsCtaTracking', 'hsutk'];

/** Picture paths HubSpot serves: its file manager (/hubfs/, legacy /hub/{portal}/) and its resizer (/hs-fs/). */
const HUBSPOT_FILE = /^\/(?:hs-fs\/)?(?:hubfs\/|hub\/\d+\/)/;
const HUBSPOT_HOST = /(^|\.)(hubspotusercontent[\w-]*\.net|hubspot\.net|hubspot\.com)$/;
/** HubSpot's resizer never enlarges a picture, so this is "the original, but no bigger than this". */
const MAX_WIDTH = '1600';

function fullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    if (!HUBSPOT_FILE.test(u.pathname) || /\/hub_generated\//.test(u.pathname) || /\.(svg|gif)$/i.test(u.pathname)) return null;
    // HubSpot's file CDN serves the original and ignores sizes; the site's own host resizes through /hs-fs/.
    if (HUBSPOT_HOST.test(u.hostname)) {
        for (const p of ['width', 'height', 'name']) u.searchParams.delete(p);
        return u.toString();
    }
    if (!u.pathname.startsWith('/hs-fs/')) u.pathname = `/hs-fs${u.pathname}`;
    const t = u.searchParams.get('t');
    u.search = '';
    u.searchParams.set('width', MAX_WIDTH);
    if (t) u.searchParams.set('t', t);
    return u.toString();
}

function largest(srcset: string | undefined): string | null {
    let best: { url: string; w: number } | null = null;
    for (const part of (srcset ?? '').split(',')) {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) continue;
        const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
        if (!best || w > best.w) best = { url, w };
    }
    return best?.url ?? null;
}

const absolute = (href: string, base: URL | null): string | null => {
    try { return new URL(href.replace(/^\/\//, 'https://'), base ?? undefined).toString(); } catch { return null; }
};

/**
 * Drag-and-drop sections keep their background picture in the page's <style> block, keyed by a class
 * (.dnd_area-row-0-background-layers { background-image: url(…) }), and custom modules by their wrapper id.
 * Copied onto the element as an inline style, where the import reads backgrounds.
 */
function inlineStyleBackgrounds($: cheerio.CheerioAPI): void {
    const css = $('style').map((_, s) => $(s).text()).get().join('\n');
    const rule = /([^{}@]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    let applied = 0;
    while ((m = rule.exec(css)) && applied < 20) {
        const selector = m[1].trim();
        const url = m[2].match(/background(?:-image)?\s*:[^;]*?url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i)?.[1];
        // One class, one id, or an id then a class: what HubSpot itself writes. Nothing with states or pseudo-elements.
        if (!url || !/^(?:#[\w-]+|\.[\w-]+|#[\w-]+\s+\.[\w-]+)$/.test(selector)) continue;
        let els: ReturnType<cheerio.CheerioAPI>;
        try { els = $(selector); } catch { continue; }
        els.slice(0, 3).each((_, el) => {
            const style = $(el).attr('style') ?? '';
            if (/url\(/i.test(style)) return;
            $(el).attr('style', `${style}${style && !style.trim().endsWith(';') ? ';' : ''}background-image:url('${url.replace(/'/g, '%27')}')`);
            applied++;
        });
    }
}

export const adapter: BuilderAdapter = {
    key: 'hubspot',
    label: 'HubSpot Content Hub',
    // CMS pages say so in their generator tag and their markup. HubSpot's tracking code (hs-scripts.com) and
    // files linked from its CDN appear on sites built with anything, so they are not signs on their own.
    detect: (html, gen) => gen.includes('hubspot') || /hs_cos_wrapper|\/hs\/hsstatic\/|\/_hcms\/|\/hub_generated\/|\/hs-fs\/hub/.test(html),
    contentRoot: '.body-container-wrapper',
    noise: /^(show submenu for .*|chat with us|subscribe( by email| to (our|the) blog)?|written by .*|posted by .*|\d+ min(ute)? read)$/i,
    fullSizeImage: fullSize,
    prepare($, url) {
        $(FURNITURE).remove();

        // Older (COS) templates draw the site's header and footer in plain <div>s: name them, so the
        // menu and logo are read as such and the header and footer are not read as page content.
        $('.header-container-wrapper').not('header').each((_, el) => { if (el.type === 'tag' && !$(el).closest('header').length) el.name = 'header'; });
        $('.footer-container-wrapper').not('footer').each((_, el) => { if (el.type === 'tag' && !$(el).closest('footer').length) el.name = 'footer'; });
        $('.hs-menu-wrapper, .hs_cos_wrapper_type_menu, .hs_cos_wrapper_type_simple_menu').each((_, el) => {
            if (!$(el).closest('nav, [role="navigation"]').length) $(el).attr('role', 'navigation');
        });

        // Links without ?hsLang= and HubSpot's tracking: one page is one address.
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href') ?? '';
            if (!/[?&](hsLang|__hs|_hs|hsCta|hsutk)/.test(href)) return;
            const abs = absolute(href, url);
            if (!abs) return;
            const u = new URL(abs);
            for (const p of LINK_PARAMS) u.searchParams.delete(p);
            $(a).attr('href', u.toString());
        });

        // Older "image CTAs" are a picture of a button (its words in the alt text), drawn by script.
        // They become the button they are; one with no words is not a picture of their business either.
        $('.hs-cta-wrapper').each((_, el) => {
            const a = $(el).find('a[href]').first();
            const alt = ($(el).find('img.hs-cta-img, img').first().attr('alt') ?? '').trim();
            if (!a.length || !alt) { $(el).remove(); return; }
            $(el).replaceWith($('<a class="button"></a>').attr('href', a.attr('href') ?? '').text(alt));
        });

        // HubSpot forms are drawn by script into an empty box: mark that the page has a form (its
        // questions are only known to HubSpot). The form's title, if any, stays as their words.
        $('.hbspt-form, .hs-form-frame, [id^="hs_form_target_"]').each((_, el) => {
            if (!$(el).find('form').length) $(el).replaceWith('<form data-hubspot-form=""></form>');
        });

        // Pictures at their full size, also for the logo (read before the per-picture hook runs).
        $('img').each((_, img) => {
            const raw = largest($(img).attr('srcset') ?? $(img).attr('data-srcset')) ?? $(img).attr('data-src') ?? $(img).attr('src') ?? '';
            const abs = raw ? absolute(raw, url) : null;
            const big = abs ? fullSize(abs) : null;
            if (!big) return;
            $(img).attr('src', big).removeAttr('srcset').removeAttr('data-srcset').removeAttr('data-src');
        });

        inlineStyleBackgrounds($);
    },
};
