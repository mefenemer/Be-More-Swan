// src/utils/site-builders/duda.ts — Website import adapter for Duda (and the agencies and hosts that
// resell it under their own name).
// Findings, what is covered and what is not: docs/site-import-platforms/duda.md
// Tests: tests/site-platform-duda.test.ts (fixtures in tests/fixtures/site-platforms/duda/).
//
// Duda pages are drawn on the server: the words are in the HTML. What the import trips on is Duda's
// furniture — a phone menu drawer and header/footer drawn as plain <div>s, content in a div with
// role="main" (not <main>), resized pictures (…/opt/name-806h.jpg) with the original beside them,
// background pictures in data-background-image or in the page's <style> by box id, template
// placeholder captions, form messages outside the <form>, and boxes drawn twice (phone copies).
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Duda's picture hosts: irp/lirp.cdn-website.com today, *.multiscreensite.com on older sites. */
const DUDA_IMG_HOST = /(^|\.)(cdn-website\.com|multiscreensite\.com)$/i;
/** …/dms3rep/multi/[opt/]name[-806h|-1920w].ext */
const DUDA_IMG_PATH = /^(.*\/dms3rep\/multi)\/(?:opt\/)?(.+?)(?:-\d{2,4}[wh])?\.(jpe?g|png|webp)$/i;

/** A resized Duda picture → the 1920-wide copy (lirp resizes on request and never upscales). */
export function dudaFullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    if (!DUDA_IMG_HOST.test(u.hostname)) return null;
    const m = decodeURI(u.pathname).match(DUDA_IMG_PATH);
    if (!m) return `${u.origin}${u.pathname}`;   // a GIF or a file we don't know: as it is, without ?jxl
    const [, dir, name, ext] = m;
    const host = /cdn-website\.com$/i.test(u.hostname) ? 'lirp.cdn-website.com' : u.hostname;
    return encodeURI(`https://${host}${dir}/opt/${name}-1920w.${ext}`);
}

/** Words Duda's templates ship with that owners leave in place (gallery captions, slider buttons). */
const TEMPLATE_WORDS = /^(photo by:? john doe|image title|image description|button|share by:?|website (powered|designed|built) by\b.*)$/i;

/** The id inside a CSS id selector: `#\39 e9729a1` → `9e9729a1`, `#group_6mo` → `group_6mo`. */
function cssId(sel: string): string {
    return sel.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
}

function prepare($: cheerio.CheerioAPI): void {
    const rename = (sel: string, tag: string) => $(sel).each((_, el) => { if (el.type === 'tag') el.name = tag; });
    // Header, phone drawer and footer are plain divs: make them what they are, so the menu, logo and
    // social links are read from them and they are never read as content.
    rename('.dmHeaderContainer, #hamburger-header-container, #hamburger-drawer', 'header');
    rename('.dmFooterContainer', 'footer');
    // Duda's own furniture: share pop-up, "powered by" badge, form messages kept outside the <form>
    // until sent, invisible slider buttons, captions the owner switched off, the slider's see-through
    // placeholder picture.
    $('#dmPopup, #dmPopupMask, [dmle_extension="powered_by"], .dmform-success, .dmform-error, .slide-button-invisible, .layout-drawer-hamburger').remove();
    $('.caption-container').filter((_, el) => /display\s*:\s*none/i.test($(el).attr('style') ?? '')).remove();
    $('.caption-title, .caption-text').filter((_, el) => TEMPLATE_WORDS.test($(el).text().trim())).remove();
    $('img[src*="transparent_background"], img[data-src*="transparent_background"]').remove();
    // Boxes hidden on computers are the phone copy of something the computer layout already shows.
    $('[data-hidden-on-desktop]').filter((_, el) => $(el).attr('data-hidden-on-desktop') !== 'false').remove();
    // FAQ accordions and testimonial sliders are lists: read each entry as its heading/quote and text,
    // not as one run-on list item.
    rename('li.accordion-item, .dmImageSlider .slides > li', 'div');
    rename('.dmImageSlider .slide-title', 'blockquote');
    // Pictures: the original is beside the resized one.
    $('img[data-dm-image-path]').each((_, el) => {
        const full = dudaFullSize($(el).attr('data-dm-image-path') ?? '');
        if (full) $(el).attr('src', full).removeAttr('srcset').removeAttr('data-src');
    });
    // Background pictures: data-background-image (classic rows), or #id{background-image:url(…)} in
    // the page's own <style> (flex layout). Both become data-bg, which the reader treats as a picture.
    $('[data-background-image]').each((_, el) => {
        const v = ($(el).attr('data-background-image') ?? '').trim();
        if (/^https?:\/\//i.test(v) && !$(el).attr('data-bg')) $(el).attr('data-bg', v);
    });
    const css = $('style').map((_, el) => $(el).text()).get().join('\n');
    for (const m of css.matchAll(/(?:^|[}\s])#((?:\\[0-9a-f]{1,6}\s?|\\.|[\w-])+)\s*\{[^}]*?background-image\s*:\s*url\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/gi)) {
        const el = $(`[id="${cssId(m[1]).replace(/"/g, '')}"]`).first();
        if (el.length && !el.attr('data-bg')) el.attr('data-bg', m[2]);
    }
    // A Duda map (drawn by script) becomes a Google map embed, which the reader turns into a button.
    $('.inlineMap[data-address], [data-element-type="mapextension"][data-address]').each((_, el) => {
        const addr = ($(el).attr('data-address') ?? '').trim();
        if (!addr) return;
        $(el).replaceWith(`<iframe src="https://www.google.com/maps/embed?q=${encodeURIComponent(addr)}" title="Map"></iframe>`);
        // …and their address, when the page states it nowhere the reader looks (outside the content).
        if (!$('address').length && $('#dm_content').length) $('body').append($('<address hidden></address>').text(addr));
    });
}

export const adapter: BuilderAdapter = {
    key: 'duda',
    label: 'Duda',
    detect: (html) => /dudamobile|multiscreensite\.com|(?:l?irp|static)\.cdn-website\.com|<body[^>]*\bid=["']dmRoot["']|\bdmRespRow\b/i.test(html),
    prepare,
    contentRoot: '#dm_content',
    noise: TEMPLATE_WORDS,
    fullSizeImage: dudaFullSize,
    rendersWithJs: false,
};
