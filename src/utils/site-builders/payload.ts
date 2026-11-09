// src/utils/site-builders/payload.ts — Website import adapter for Payload CMS.
// Findings, what is covered and what is not: docs/site-import-platforms/payload.md
// Tests: tests/site-platform-payload.test.ts (fixtures in tests/fixtures/site-platforms/payload/).
//
// Payload 3 runs inside Next.js: pages are server-rendered (words are in the HTML), pictures go
// through next/image (/_next/image?url=/api/media/file/…), Lexical rich text is drawn inside
// div.payload-richtext, and blocks arrive in the RSC payload as {"blockType":…,"blockName":…}.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Payload's own upload address: /api/<collection>/file/<name>.<picture> — raw, or URL-encoded inside next/image. */
const MEDIA_FILE = /\/api\/[a-z0-9-]+\/file\/[^"'\s?&<>]+\.(?:avif|webp|jpe?g|png|gif)|%2Fapi%2F[a-z0-9-]+%2Ffile%2F[^"'\s&<>]+?\.(?:avif|webp|jpe?g|png|gif)/i;
/** Lexical rich text drawn by @payloadcms/richtext-lexical/react (its default container class). */
const RICHTEXT = /class="[^"]*\bpayload-richtext\b/;
/** A Payload blocks field in the RSC payload: every block carries blockType and blockName. */
const BLOCKS = /\\?"blockType\\?":\\?"[A-Za-z0-9_-]+\\?"[^]{0,4000}?\\?"blockName\\?":|\\?"blockName\\?":[^]{0,4000}?\\?"blockType\\?":\\?"/;

/** The website template's default logo (Payload's own) — never the business's. */
const PAYLOAD_LOGO = /payloadcms\/payload\/.*payload-logo|payload-logo-(?:light|dark)\.svg/i;
/** next/image's cache tag from the website template's getMediaUrl: ?2026-05-01T10:00:00.000Z */
const CACHE_TAG = /^\?\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

export const adapter: BuilderAdapter = {
    key: 'payload',
    label: 'Payload CMS',
    detect: (html) => RICHTEXT.test(html) || MEDIA_FILE.test(html) || BLOCKS.test(html),
    prepare: ($, url) => {
        spliceStreamedBoundaries($);
        // Their logo, not Payload's: the template ships with Payload's logo until the owner swaps it.
        $('img').filter((_, el) => PAYLOAD_LOGO.test($(el).attr('src') ?? '')).remove();
        // The admin panel and the search page are Payload's, not pages of the business.
        $('a[href]').filter((_, el) => isPayloadOwnLink($(el).attr('href') ?? '', url)).remove();
        // The website template draws hero / call-to-action links as a list of links (ul.flex > li > a):
        // they are buttons, not list items. Lexical's own lists (ul.list-bullet…) are left alone.
        $('ul, ol').filter((_, el) => {
            const $l = $(el);
            if (/(?:^|\s)list-/.test($l.attr('class') ?? '')) return false;
            const items = $l.children('li');
            return items.length > 0 && items.toArray().every((li) => {
                const $li = $(li);
                return $li.children().length === 1 && $li.children('a[href]').length === 1 && $li.text().trim() === $li.children('a').text().trim();
            });
        }).each((_, el) => {
            const $l = $(el);
            $l.replaceWith(`<div>${$l.children('li').toArray().map((li) => $.html($(li).children('a'))).join('')}</div>`);
        });
        // The form builder plugin's "* (required)" marker is not part of the question.
        $('form label .required').remove();
        // A Payload site on CSS Modules has no <header>: its Header_header__x1Y2z box is the site's header.
        if (!$('header').length) {
            const h = $('body [class*="Header_header__"], body [class^="Header_"]').first();
            if (h.length && !h.closest('main, article').length) (h.get(0) as { name: string }).name = 'header';
        }
    },
    // Lines the website template adds: the archive's count and the search page's empty state.
    noise: /^(showing \d+( - \d+)? of \d+ [a-z]+|search produced no results\.?)$/i,
    fullSizeImage: (src) => {
        let u: URL;
        try { u = new URL(src); } catch { return null; }
        // next/image's resized copy → the picture Payload holds (one address however many widths the page asked for).
        if (u.pathname.endsWith('/_next/image')) {
            const inner = u.searchParams.get('url');
            if (!inner) return null;
            try { u = new URL(inner, u.origin); } catch { return null; }
        }
        // The template's cache tag (?<updatedAt>) changes on every edit: the same picture, one address.
        if (CACHE_TAG.test(decodeURIComponent(u.search))) u.search = '';
        return u.toString();
    },
    rendersWithJs: false,
};

function isPayloadOwnLink(href: string, base: URL | null): boolean {
    let u: URL;
    try { u = new URL(href, base ?? 'https://x.invalid/'); } catch { return false; }
    if (base && u.host !== base.host) return false;
    return /^\/admin(\/|$)/.test(u.pathname) || /^\/search\/?$/.test(u.pathname);
}

/**
 * React streams slow parts of a Next.js page after the rest: the boundary's place holds a
 * <template id="B:0"> and a fallback ("Loading…"), and the content arrives at the end of <body> in
 * <div hidden id="S:0">, moved by $RC("B:0","S:0"). Put the content back where it belongs, in place of
 * the fallback, so the words come out in the page's order.
 */
function spliceStreamedBoundaries($: cheerio.CheerioAPI): void {
    const pairs: Array<[string, string]> = [];
    $('script').each((_, s) => {
        for (const m of $(s).text().matchAll(/\$RC\(\s*"(B:\d+)"\s*,\s*"(S:\d+)"\s*\)/g)) pairs.push([m[1], m[2]]);
    });
    for (const [b, s] of pairs) {
        const tpl = $(`template[id="${b}"]`).first();
        const content = $(`div[hidden][id="${s}"]`).first();
        if (!tpl.length || !content.length) continue;
        // The fallback: from the template to the boundary's closing <!--/$--> comment.
        const tplNode = tpl.get(0)!;
        let n = tplNode.next;
        while (n && !(n.type === 'comment' && (n as unknown as { data: string }).data === '/$')) {
            const next = n.next;
            $(n).remove();
            n = next;
        }
        tpl.replaceWith(content.html() ?? '');
        content.remove();
    }
}
