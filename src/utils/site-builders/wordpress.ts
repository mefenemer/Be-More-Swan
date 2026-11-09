// src/utils/site-builders/wordpress.ts — Website import adapter for WordPress.
// Findings, what is covered and what is not: docs/site-import-platforms/wordpress.md
// Tests: tests/site-platform-wordpress.test.ts (fixtures in tests/fixtures/site-platforms/wordpress/).
//
// WordPress draws every page on the server, so the plain read sees all the words. What gets in the
// way is WordPress's own furniture: post dates and "Edit" links, comment boxes, Jetpack's sharing
// row, sidebar widgets (Archives, Meta, search), screen-reader-only labels, lazy-load plugins that
// leave a blank placeholder in `src`, and resized copies of every picture (photo-300x200.jpg).
// Elementor and WooCommerce sites are WordPress too but have adapters of their own, listed first;
// they can reuse `prepareWordPress` and `wordpressFullSizeImage` from here.
import type * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { BuilderAdapter } from './types';

/**
 * Signals only WordPress prints. The generator tag says so outright, but many sites remove it
 * (security plugins), so two of the others will do. A picture hot-linked from someone else's
 * /wp-content/uploads/ is not one: headless WordPress and other builders show those too.
 */
const WP_SIGNALS: RegExp[] = [
    /\/wp-includes\//,
    /\/wp-content\/(?:themes|plugins)\//,
    /rel=["']https:\/\/api\.w\.org\/["']/,
    /\bid=["']wp-(?:block-library|emoji-styles|img-auto-sizes)[\w-]*-css["']/,
    /\bid=["']global-styles-inline-css["']/,
    /\bclass=["'][^"']*\bwp-(?:block-[a-z]|site-blocks|embed-responsive|custom-logo|image-\d)/,
    /<body\b[^>]*class=["'][^"']*\b(?:page-id-\d+|postid-\d+|page-template(?:-default)?)\b/,
];

export function looksLikeWordPress(html: string, gen: string): boolean {
    if (gen.includes('wordpress')) return true;
    let n = 0;
    for (const re of WP_SIGNALS) if (re.test(html) && ++n >= 2) return true;
    return false;
}

/** A picture in WordPress's uploads folder (self-hosted, Jetpack's CDN, or WordPress.com's file host). */
const UPLOADS = /\/wp-content\/uploads\/|(^|\.)files\.wordpress\.com$/;
/** The size WordPress adds to a resized copy: photo-300x200.jpg (the original is photo.jpg). */
const SIZE_SUFFIX = /-(\d{2,4})x(\d{2,4})(\.(?:jpe?g|png|gif|webp|avif))$/i;
/**
 * A resized copy at least this big is kept as it is. WordPress keeps the camera's original too,
 * which can be far over the picture copy's size cap (site-import-store.ts PICTURE_MAX_BYTES), so
 * only small copies are pointed back at it.
 */
const KEEP_RESIZED_AT = 1024;
/** Jetpack's image CDN (i0.wp.com) and WordPress.com resize by query string; without it, the original. */
const RESIZE_PARAMS = ['resize', 'fit', 'w', 'h', 'crop', 'zoom', 'quality', 'strip', 'lb'];

/** A resized WordPress picture → the original (null = not a WordPress picture, keep it). */
export function wordpressFullSizeImage(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    const photon = /^i[0-3]\.wp\.com$/.test(u.hostname);
    if (!photon && !UPLOADS.test(u.pathname) && !UPLOADS.test(u.hostname)) return null;
    if (photon || /(^|\.)files\.wordpress\.com$/.test(u.hostname) || /(^|\.)wordpress\.com$/.test(u.hostname)) {
        for (const p of RESIZE_PARAMS) u.searchParams.delete(p);
    }
    const m = u.pathname.match(SIZE_SUFFIX);
    if (m && Math.max(Number(m[1]), Number(m[2])) < KEEP_RESIZED_AT) u.pathname = u.pathname.replace(SIZE_SUFFIX, '$3');
    return u.toString();
}

/** WordPress's own parts of a page, never the owner's words. */
const FURNITURE = [
    // Screen-reader-only labels ("Read more<span> about Post title</span>", social icons' names).
    '.screen-reader-text', '.skip-link',
    // Post furniture: dates, authors, categories, edit links, comments, post-to-post links.
    '.entry-meta', '.entry-footer', '.entry-utility', '.post-meta', '.posted-on', '.byline', '.cat-links', '.tags-links',
    '.edit-link', '.post-edit-link', '.comments-link', '#comments', '.comments-area', '.comment-respond',
    '.wp-block-post-date', '.wp-block-post-author', '.wp-block-post-author-name', '.wp-block-post-terms',
    '.wp-block-comments', '.wp-block-post-comments-form', '.wp-block-post-navigation-link', '.wp-block-comments-query-loop',
    '.post-navigation', '.posts-navigation', '.navigation.pagination', '.wp-block-query-pagination', '.page-links', '.nav-links',
    // Jetpack: sharing buttons, likes, related posts, ads.
    '.sharedaddy', '.sd-sharing', '.sd-like', '.jp-relatedposts', '#jp-post-flair', '.wpcnt', '.wordads-ad-wrapper',
    // Sidebar widgets WordPress fills by itself (text widgets stay: those are the owner's).
    '.widget_search', '.widget_recent_entries', '.widget_recent_comments', '.widget_archive', '.widget_categories',
    '.widget_meta', '.widget_calendar', '.widget_tag_cloud', '.widget_rss',
    '.wp-block-search', '.wp-block-archives', '.wp-block-categories', '.wp-block-calendar', '.wp-block-tag-cloud',
    '.wp-block-latest-comments', '.wp-block-loginout', '.wp-block-rss',
    // A search box is not their enquiry form (and makes every page look like it had one).
    'form[role="search"]', 'form.search-form', 'form.searchform', '#searchform',
    // The admin bar (a cached page saved while logged in), Gravatar pictures.
    '#wpadminbar', 'img.avatar',
].join(', ');

/** Classic themes' site header and footer are often <div>s; made real ones, the import's rules apply. */
const SITE_HEADER = '#masthead, .site-header, #header, #site-header';
const SITE_FOOTER = '#colophon, .site-footer, #footer, #site-footer';
/** The site's name as the theme prints it, when there is no og:site_name. */
const SITE_TITLE = '.wp-block-site-title, .site-title, #site-title';

/**
 * Tidy a WordPress page before it is read (BuilderAdapter.prepare). Exported for the Elementor and
 * WooCommerce adapters, whose sites are WordPress underneath. Never fetches; never adds words.
 */
export function prepareWordPress($: cheerio.CheerioAPI): void {
    const outsideContent = (el: AnyNode) => $(el).closest('main, article, [role="main"], .entry-content').length === 0;

    // The site's name (for picture descriptions and the logo), before the header goes.
    if (!$('meta[property="og:site_name"]').length) {
        const title = $(SITE_TITLE).first().text().replace(/\s+/g, ' ').trim();
        if (title && title.length <= 80) $('head').append($('<meta property="og:site_name">').attr('content', title));
    }
    // Header and footer <div>s → <header>/<footer>, so the logo is found and neither is read as content.
    $(SITE_HEADER).filter((_, el) => el.type === 'tag' && el.name === 'div' && outsideContent(el) && $(el).parents(SITE_HEADER).length === 0)
        .each((_, el) => { (el as unknown as { name: string }).name = 'header'; });
    $(SITE_FOOTER).filter((_, el) => el.type === 'tag' && el.name === 'div' && outsideContent(el) && $(el).parents(SITE_FOOTER).length === 0)
        .each((_, el) => { (el as unknown as { name: string }).name = 'footer'; });
    // The site title's link is the home page again, under the business's name: not a menu entry.
    $(SITE_TITLE).filter((_, el) => outsideContent(el)).find('a').removeAttr('href');

    $(FURNITURE).remove();

    // The block editor's menu names the drop-down's own <li> like a sub-menu, so the link that opens
    // it read as sitting under the entry before it ("Garden rooms" under "Home"). Its real sub-menu
    // is the <ul> inside, which keeps the name.
    $('li.wp-block-navigation-submenu').removeClass('wp-block-navigation-submenu');

    // Emoji WordPress drew as pictures: back to the character.
    $('img.emoji, img.wp-smiley').each((_, el) => { $(el).replaceWith($(el).attr('alt') ?? ''); });

    $('img').each((_, el) => {
        const $img = $(el);
        // Lazy-load plugins (WP Rocket, a3, LiteSpeed…) leave a blank placeholder in src.
        for (const [from, to] of [['data-lazy-src', 'src'], ['data-lazy-srcset', 'srcset'], ['data-ll-src', 'src'], ['data-ll-srcset', 'srcset']] as const) {
            const v = $img.attr(from);
            if (v) $img.attr(to, v);
        }
        const src = $img.attr('src') ?? '';
        if (src.startsWith('data:') && $img.attr('data-src')) $img.attr('src', $img.attr('data-src')!);
        // The original WordPress knows about: Jetpack's data-orig-file, or the picture linked to its
        // own file ("Link to: Media File" in the classic editor).
        const linked = $img.parent('a').attr('href') ?? '';
        const original = $img.attr('data-orig-file')
            || (UPLOADS.test(linked) && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(linked) ? linked : '');
        if (original && /^https?:|^\//.test(original)) {
            $img.attr('src', original);
            $img.removeAttr('srcset').removeAttr('data-srcset').removeAttr('data-src').removeAttr('sizes');
        }
        // WordPress used to fill the description with the file's name ("bakery-front"): that's no description.
        const alt = ($img.attr('alt') ?? '').trim().toLowerCase();
        const stem = (($img.attr('src') ?? '').split('?')[0].split('/').pop() ?? '').replace(SIZE_SUFFIX, '').replace(/\.[a-z0-9]+$/i, '').replace(/-scaled$/, '').toLowerCase();
        if (alt && stem && (alt === stem || alt.replace(/\s+/g, '-') === stem)) $img.attr('alt', '');
    });

    // Lazy-loaded videos: WP Rocket's "lite" YouTube player is an empty <div> naming the video.
    $('.rll-youtube-player[data-src], .rll-youtube-player[data-id]').each((_, el) => {
        const $d = $(el);
        const id = $d.attr('data-id');
        const src = $d.attr('data-src') || (id ? `https://www.youtube.com/embed/${id}` : '');
        if (src) $d.replaceWith($('<iframe></iframe>').attr('src', src).attr('title', $d.attr('data-alt') ?? ''));
    });
    $('iframe[data-lazy-src]').each((_, el) => { $(el).attr('src', $(el).attr('data-lazy-src')!); });
    // The classic editor wraps an embedded map or video in a paragraph, where the import reads only
    // the paragraph's words: stand the frame on its own.
    $('p > iframe').each((_, el) => {
        const $p = $(el).parent();
        $p.after(el);
        if (!$p.text().trim() && !$p.find('img').length) $p.remove();
    });
}

/** Lines WordPress and its themes add ("Proudly powered by WordPress", "Theme: X by Y", "Leave a comment"). */
const NOISE = /^(proudly powered by wordpress\.?|powered by wordpress\.?|designed with wordpress\.?|theme: .{1,60} by .{1,60}|wordpress theme by .{1,60}|leave a (comment|reply)|comments are closed\.?|\d+ (comments?|responses?)|no comments( yet)?|posted (on|in|by) .{1,80}|uncategori[sz]ed|continue reading.*|search for:|nothing found|older (posts|entries)|newer (posts|entries)|« older entries|newer entries »)$/i;

export const adapter: BuilderAdapter = {
    key: 'wordpress',
    // The theme's own colours and fonts (theme.json presets), over the shared reading (main session, 2026-11-09).
    look: ({ html, css }) => { const l = readWordPressLook(html, css); return { primaryColor: l.primaryColor, secondaryColor: l.secondaryColor, textColor: l.textColor, backgroundColor: l.backgroundColor, headingFont: l.headingFont }; },
    label: 'WordPress',
    detect: (html, gen) => looksLikeWordPress(html, gen),
    prepare: ($) => prepareWordPress($),
    // Classic themes from before <main> mark the content area with role="main" (Twenty Ten–Twelve);
    // without it the page's whole body was read, sidebar and site title included.
    contentRoot: 'main, [role="main"], .site-main',
    noise: NOISE,
    fullSizeImage: wordpressFullSizeImage,
    rendersWithJs: false,
};

// ── The look ────────────────────────────────────────────────────────────────────────────────────
// Not wired in yet: readImportedLook (site-import-theme.ts, shared) reads the raw page, and an
// adapter has no say in it. docs/site-import-platforms/wordpress.md "Can be done" gives the hook.

/**
 * WordPress core prints this palette on every site, whatever the theme (the block editor's default
 * swatches). Counted as the site's colours, they made "black" the text colour and "white" the page.
 */
const CORE_PALETTE = new Set(['black', 'cyan-bluish-gray', 'white', 'pale-pink', 'vivid-red', 'luminous-vivid-orange', 'luminous-vivid-amber', 'light-green-cyan', 'vivid-green-cyan', 'pale-cyan-blue', 'vivid-cyan-blue', 'vivid-purple']);

export interface WordPressLook {
    primaryColor: string | null;
    secondaryColor: string | null;
    textColor: string | null;
    backgroundColor: string | null;
    headingFont: string | null;
    bodyFont: string | null;
}

/** The theme's own colours and fonts from theme.json's presets (--wp--preset--*) and global styles. */
export function readWordPressLook(html: string, css = ''): WordPressLook {
    const all = `${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')}\n${css}`;
    const colours = new Map<string, string>();
    for (const m of all.matchAll(/--wp--preset--color--([\w-]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi)) {
        const name = m[1].toLowerCase();
        if (!CORE_PALETTE.has(name) && !colours.has(name)) colours.set(name, m[2].toLowerCase());
    }
    const fonts = new Map<string, string>();
    for (const m of all.matchAll(/--wp--preset--font-family--([\w-]+)\s*:\s*([^;}]+)/gi)) {
        const f = m[2].split(',')[0].trim().replace(/^['"]|['"]$/g, '').trim();
        if (f && !fonts.has(m[1].toLowerCase())) fonts.set(m[1].toLowerCase(), f);
    }
    /** A rule's property, with var(--wp--preset--…) resolved against the presets. */
    const rule = (sel: RegExp, prop: string): string | null => {
        const m = all.match(new RegExp(`(?:^|[},\\s])${sel.source}[^{}]*\\{(?:[^}]*?[;\\s])?${prop}\\s*:\\s*([^;}]+)`, 'i'));
        const v = m?.[1].trim() ?? null;
        if (!v) return null;
        const ref = v.match(/var\(\s*--wp--preset--(color|font-family)--([\w-]+)/i);
        if (ref) return (ref[1].toLowerCase() === 'color' ? colours : fonts).get(ref[2].toLowerCase()) ?? null;
        return /^#[0-9a-f]{3,8}$/i.test(v) ? v.toLowerCase() : v.split(',')[0].trim().replace(/^['"]|['"]$/g, '') || null;
    };
    const pick = (...names: string[]) => { for (const n of names) if (colours.get(n)) return colours.get(n)!; return null; };
    const hex = (v: string | null) => (v && /^#[0-9a-f]{3,8}$/i.test(v) ? v : null);
    const font = (v: string | null) => (v && !/^#|^var\(|^inherit$/i.test(v) ? v : null);
    const primary = hex(rule(/(?:\.wp-element-button|\.wp-block-button__link)/, 'background(?:-color)?')) ?? pick('primary', 'accent', 'accent-1', 'brand');
    const secondary = pick('secondary', 'accent-2', 'tertiary');
    return {
        primaryColor: primary,
        secondaryColor: secondary && secondary !== primary ? secondary : null,
        textColor: hex(rule(/body/, 'color')) ?? pick('contrast', 'foreground', 'text', 'dark'),
        backgroundColor: hex(rule(/body/, 'background(?:-color)?')) ?? pick('base', 'background', 'light'),
        headingFont: font(rule(/h1/, 'font-family')) ?? fonts.get('heading') ?? null,
        bodyFont: font(rule(/body/, 'font-family')) ?? fonts.get('body') ?? null,
    };
}
