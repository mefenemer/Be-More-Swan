// src/utils/site-builders/wix-studio.ts — Website import adapter for Wix Studio (Wix's agency editor,
// and the old Editor X, whose sites Wix moved onto Studio).
// Findings, what is covered and what is not: docs/site-import-platforms/wix-studio.md
// Tests: tests/site-platform-wix-studio.test.ts (fixtures in tests/fixtures/site-platforms/wix-studio/).
//
// Studio pages are Wix pages: the same Thunderbolt renderer, generator tag, picture host and theme
// variables as classic Wix. So this adapter runs the classic Wix adapter's tidying first (./wix) and
// adds only what Studio does differently: responsive pictures drawn as tiny blurred placeholders,
// accordions, text marquees and slideshow counters.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';
import { adapter as wix } from './wix';

/**
 * Studio, from the site model Wix ships in every page: `"editorName":"Studio"` (classic pages say
 * "Unknown"). Also the same value in a features URL (`editorName=Studio`). Never the bare string
 * "wix-studio": Wix's shared logging script carries it on EVERY Wix page, classic ones included.
 */
const STUDIO_EDITOR = /["']?editorName\\?["']?\s*[:=]\s*\\?["']?(?:Studio|EditorX)\b/;
const ANY_EDITOR = /["']?editorName\\?["']?\s*[:=]\s*\\?["']?[A-Za-z]/;
const IS_WIX = /static\.wixstatic\.com|wix-thunderbolt|parastorage\.com/;

/** Studio's own controls and footer line, never the owner's words. */
const OWN_NOISE = /^(?:(?:play|pause) marquee|powered and secured by wix)$/i;

/** Wix's picture host: one original, any size or crop asked for in the path. */
const WIX_MEDIA = /^\/media\/([^/]+)(?:\/v1\/(.+))?$/;
const FULL = 'fit/w_1600,h_1600,q_85';

/**
 * A Wix picture address at a sensible full size, keeping the owner's crop. Wix chains steps
 * (`/v1/crop/x_62,y_108,w_2030,h_644/fill/w_49,h_16,blur_2/name.png`); the shared rule assumed one
 * step and turned the second into part of the file name.
 */
function wixFullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    if (!/(^|\.)wixstatic\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(WIX_MEDIA);
    if (!m) return null;
    const id = m[1];
    if (!m[2]) return `${u.origin}/media/${id}/v1/${FULL}/${id}`;
    const parts = m[2].split('/');
    const name = parts.pop() || id;
    let crop = '';
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] === 'crop' && /^x_\d+,y_\d+,w_\d+,h_\d+$/.test(parts[i + 1])) crop = `crop/${parts[i + 1]}/`;
    return `${u.origin}/media/${id}/v1/${crop}${FULL}/${name}`;
}

interface ImageInfo { imageData?: { uri?: string; width?: number; height?: number; alt?: string; name?: string } }

/** A file name or "image" is not a description (as site-extract.ts realAlt). */
const fileNameAlt = (a: string) => !a.trim() || /\.(jpe?g|png|webp|gif|svg|heic|avif)$/i.test(a) || /^[\w~-]{16,}$/.test(a.trim());

/**
 * Responsive pictures: Studio's server sends a 49–147 px blurred placeholder with that size in
 * width/height, which the import took for an icon and dropped. The <wow-image> around it says what
 * the picture really is (data-image-info: original file, size, description).
 */
function realPictures($: cheerio.CheerioAPI): void {
    $('wow-image[data-image-info]').each((_, el) => {
        let info: ImageInfo;
        try { info = JSON.parse($(el).attr('data-image-info') ?? '') as ImageInfo; } catch { return; }
        const d = info.imageData;
        if (!d?.uri) return;
        $(el).find('source').remove();
        $(el).find('img').each((__, img) => {
            const $img = $(img);
            const src = $img.attr('src') ?? '';
            if (!/wixstatic\.com\/media\//.test(src)) $img.attr('src', `https://static.wixstatic.com/media/${d.uri}`);
            $img.removeAttr('srcset');
            if (d.width && d.height) { $img.attr('width', String(d.width)); $img.attr('height', String(d.height)); }
            else { $img.removeAttr('width'); $img.removeAttr('height'); }
            if (fileNameAlt($img.attr('alt') ?? '') && d.alt && !fileNameAlt(d.alt)) $img.attr('alt', d.alt);
        });
    });
}

/**
 * Accordions (FAQ): each item's question is a <button> and its answer a hidden region, inside an <li>,
 * so the import read the question as a button with no link, or question and answer as one list item.
 * Becomes the question as a heading and the answer as it was.
 */
function openAccordions($: cheerio.CheerioAPI): void {
    $('li.wixui-accordion__item, li[class*="wixui-accordion__item"]').each((_, li) => {
        const $li = $(li);
        const title = $li.find('.wixui-accordion__title').first().text().trim();
        const body = $li.find('.wixui-accordion__container').first();
        if (!title) return;
        const item = $('<div class="wix-studio-faq"></div>');
        item.append($('<h3></h3>').text(title));
        if (body.length) item.append(body.contents());
        $li.replaceWith(item);
    });
    // The list that held the items is now a list of questions, not a list.
    $('.wixui-accordion ul, ul:has(> .wix-studio-faq)').each((_, ul) => {
        const $ul = $(ul);
        if ($ul.children().length && $ul.children().toArray().every((c) => $(c).is('.wix-studio-faq'))) $ul.replaceWith($('<div></div>').append($ul.contents()));
    });
}

/** "1/3" beside a slideshow (multi-state box) is its counter. "24/7" or "3/4" are left alone. */
function slideCounters($: cheerio.CheerioAPI): void {
    if (!$('.wixui-multi-state-box, .wixui-slideshow, [class*="wixui-slideshow"]').length) return;
    $('span, p, div').each((_, el) => {
        const $el = $(el);
        if ($el.children().length) return;
        const m = $el.text().trim().match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
        // The page is sent showing its first slide, so the counter reads 1/n.
        if (m && m[1] === '1' && Number(m[2]) >= 2 && Number(m[2]) <= 30) $el.remove();
    });
}

export const adapter: BuilderAdapter = {
    key: 'wix-studio',
    label: 'Wix Studio',
    detect: (html, gen, $) => {
        if (!gen.includes('wix') && !IS_WIX.test(html)) return false;
        if (STUDIO_EDITOR.test(html)) return true;
        // No site model at all (a page saved without its scripts): Studio's page body is
        // main#PAGE_SECTIONS<page id>[data-main-content-parent]; classic Wix's is main#PAGES_CONTAINER.
        return !ANY_EDITOR.test(html) && $('main[data-main-content-parent][id^="PAGE_SECTIONS"]').length > 0;
    },
    prepare($, url) {
        try { wix.prepare?.($, url); } catch { /* classic Wix's tidying is a bonus, never a blocker */ }
        $('button').filter((_, b) => /^(play|pause) marquee$/i.test(($(b).attr('aria-label') ?? '').trim()) && !$(b).text().trim()).remove();
        realPictures($);
        openAccordions($);
        slideCounters($);
    },
    contentRoot: 'main[data-main-content-parent]',
    noise: wix.noise ? new RegExp(`(?:${OWN_NOISE.source})|(?:${wix.noise.source})`, 'i') : OWN_NOISE,
    fullSizeImage: (src) => wixFullSize(src) ?? wix.fullSizeImage?.(src) ?? null,
    rendersWithJs: false,
};
