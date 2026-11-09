// src/utils/site-builders/aem.ts — Website import adapter for Adobe Experience Manager.
// Findings, what is covered and what is not: docs/site-import-platforms/aem.md
// Tests: tests/site-platform-aem.test.ts (fixtures in tests/fixtures/site-platforms/aem/).
//
// Two very different kinds of AEM site:
//  · AEM Sites (6.x / as a Cloud Service): server-rendered Core Components — cmp-* classes, header
//    and footer as Experience Fragments, pictures from /content/dam/ or the Adaptive Image servlet
//    (….coreimg.82.640.jpeg/…), styles in /etc.clientlibs/.
//  · Edge Delivery Services ("Franklin", aem.live): plain sections and blocks as nested divs, pictures
//    as ./media_<hash>.jpeg?width=750, and an EMPTY <header>/<footer> that JavaScript fills from
//    /nav.plain.html and /footer.plain.html.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** AEM Sites (Core Components / older foundation components). */
const CLASSIC = /\/etc\.clientlibs\/|\/etc\/designs\/|["'(=,\s]\/content\/dam\/|\.coreimg[.{]|data-cmp-is=|\baem-Grid\b|\/_jcr_content\/|\/jcr:content\//;
/** Edge Delivery Services. */
const EDS = /\/scripts\/(?:aem|lib-franklin|lib-helix)\.js|\b[\w-]+--[\w-]+--[\w-]+\.(?:aem|hlx)\.(?:live|page)\b|["'(\s,]\.?\/media_[0-9a-f]{20,}\.[a-z]{3,4}\b/;

/** Furniture Core Components add around the owner's words. */
const FURNITURE = [
    '.cmp-languagenavigation',            // country / language picker: same-host links that would fill the menu
    '.cmp-breadcrumb',                    // "Home > About us": a <nav>, so it would join the menu
    '.cmp-carousel__actions',             // Previous / Next / Pause / Play
    '.cmp-carousel__indicators',          // one line per slide repeating each slide's title
    '.cmp-sharing', '.cmp-socialmedia',   // "Share on Facebook"
    '.cmp-download__properties',          // Filename / Size / Format
    '.cmp-page__skiptomaincontent',
    '.cmp-search',
    '.cmp-progressbar',
].join(', ');

const XF_PART = /(?:^|[\s_-])(header|footer|nav|navigation)(?:$|[\s_-])/i;

function isEdgeDelivery($: cheerio.CheerioAPI): boolean {
    return $('script[src*="/scripts/aem.js"], script[src*="lib-franklin"], script[src*="lib-helix"]').length > 0
        || $('main img[src*="media_"], main source[srcset*="media_"]').length > 0;
}

/** Core Components: header/footer fragments, the navigation's root page, lazy pictures, tabs. */
function prepareClassic($: cheerio.CheerioAPI): void {
    $(FURNITURE).remove();

    // Header and footer Experience Fragments are often plain <div>s, so the menu, logo and footer
    // links read as page content. Make the outermost of each a real <header>/<footer>, at the page's
    // edge (outside <main>), so the shared reader treats them as the site's own.
    const xfs = $('[class*="experiencefragment"]').toArray().filter((el) => XF_PART.test(`${$(el).attr('class') ?? ''} ${$(el).attr('id') ?? ''}`));
    for (const el of xfs) {
        if ($(el).parents().toArray().some((p) => xfs.includes(p))) continue;
        if ($(el).closest('header, footer').length) continue;
        const part = XF_PART.exec(`${$(el).attr('class') ?? ''} ${$(el).attr('id') ?? ''}`)![1].toLowerCase();
        if (el.type === 'tag') el.name = part === 'footer' ? 'footer' : 'header';
        if ($(el).closest('main, article').length) {
            if (part === 'footer') $('body').append($(el)); else $('body').prepend($(el));
        }
    }

    // The navigation component usually starts at the site's root page, so every menu entry sits in
    // a sub-list under "Home" and would read as Home's drop-down. Lift the root's children up.
    $('.cmp-navigation > ul, nav.cmp-navigation > ul').each((_, ul) => {
        const items = $(ul).children('li');
        if (items.length !== 1) return;
        const sub = items.first().children('ul').first();
        if (!sub.length) return;
        items.first().after(sub.children('li'));
        sub.remove();
    });

    // Lazy pictures (Core Image v2): the <img> is inside <noscript>, which the reader removes.
    $('.cmp-image noscript, [data-cmp-is="image"] noscript').each((_, el) => {
        const $n = $(el);
        if ($n.children().length) $n.replaceWith($n.contents());
        else $n.replaceWith($n.text());
    });
    // An adaptive picture with no <img> at all: build it from the component's own data.
    $('[data-cmp-src]').each((_, el) => {
        const $c = $(el);
        if ($c.find('img').length) return;
        const tmpl = $c.attr('data-cmp-src') ?? '';
        const widths = ($c.attr('data-cmp-widths') ?? '').split(',').map(Number).filter((n) => n > 0);
        const src = tmpl.replace('{.width}', widths.length ? `.${Math.max(...widths)}` : '');
        if (!src) return;
        const img = $('<img>').attr('src', src);
        const alt = $c.attr('data-alt') ?? $c.attr('data-title');
        if (alt) img.attr('alt', alt);
        $c.prepend(img);
    });

    // Tabs: the labels sit in one list, apart from their panels. Each label becomes its panel's heading.
    $('.cmp-tabs').each((_, tabs) => {
        const $t = $(tabs);
        $t.find('.cmp-tabs__tab, [role="tab"]').each((__, tab) => {
            const label = $(tab).text().replace(/\s+/g, ' ').trim();
            const id = $(tab).attr('aria-controls');
            const panel = id ? $t.find(`[id="${id.replace(/"/g, '')}"]`) : $();
            if (label && panel.length) panel.first().prepend($('<h3></h3>').text(label));
        });
        $t.find('.cmp-tabs__tablist, [role="tablist"]').remove();
    });
}

/** Video links an Edge Delivery embed/video block carries as a bare link. */
function embedSrc(href: string): string | null {
    const yt = href.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/i)?.[1];
    if (yt) return `https://www.youtube.com/embed/${yt}`;
    const vimeo = href.match(/vimeo\.com\/(?:video\/)?(\d{4,12})/i)?.[1];
    if (vimeo) return `https://player.vimeo.com/video/${vimeo}`;
    return null;
}

/** Edge Delivery: settings tables, buttons wrapped in <strong>, video links, fragments. */
function prepareEdgeDelivery($: cheerio.CheerioAPI): void {
    // Settings the site reads, written as tables in the document: never the owner's words.
    $('main .metadata, main .section-metadata').remove();
    // A fragment block only names another document that JavaScript pulls in; we can't read it here.
    $('main .fragment').remove();
    // Video blocks are a bare link; turn them into the embed the shared reader already understands
    // (a thumbnail and a "Watch the video" button — hosted pages frame nothing).
    $('main .embed, main .video').each((_, block) => {
        const href = $(block).find('a[href]').first().attr('href') ?? '';
        const src = embedSrc(href);
        if (src) $(block).replaceWith($('<iframe></iframe>').attr('src', src));
    });
    // Buttons are authored as <p><strong><a>…</a></strong></p> (primary) or <em> (secondary); the
    // site's JavaScript makes them buttons. Unwrap so the link stands alone and reads as a button.
    $('main p > strong > a[href], main p > em > a[href]').each((_, a) => {
        const wrap = $(a).parent();
        const p = wrap.parent();
        if (wrap.contents().length === 1 && p.contents().filter((__, c) => c.type === 'tag' || /\S/.test($(c).text())).length === 1) wrap.replaceWith($(a));
    });
}

/** A resized AEM / Edge Delivery / Dynamic Media picture address → a large one; null = keep it. */
export function aemFullSizeImage(src: string): string | null {
    // An unfilled Core Image template (….coreimg.60{.width}.jpeg) → the servlet's default size.
    const template = /\{\.width\}|%7B\.width%7D/i.test(src);
    let u: URL;
    try { u = new URL(src.replace(/\{\.width\}|%7B\.width%7D/gi, '')); } catch { return null; }
    const path = u.pathname;

    // Edge Delivery: ./media_<hash>.png?width=750&format=png&optimize=medium — any width can be asked for.
    const media = path.match(/\/media_[0-9a-f]{20,}\.([a-z0-9]{3,4})$/i);
    if (media) {
        const ext = media[1].toLowerCase();
        const fmt = (u.searchParams.get('format') ?? '').toLowerCase();
        u.searchParams.set('width', '2000');
        if (!fmt || fmt.startsWith('webp')) u.searchParams.set('format', ext === 'png' ? 'png' : ext === 'gif' ? 'gif' : 'jpeg');
        u.searchParams.set('optimize', 'medium');
        return u.toString();
    }

    // Adaptive Image servlet: image.coreimg[.quality][.width].jpeg/<timestamp>/name.jpeg. A small width
    // becomes the servlet's own default size (the address the component uses as its plain src).
    const core = path.match(/^(.*\.coreimg)((?:\.\d+){0,2})\.(jpe?g|png|webp|gif)(\/.*)?$/i);
    if (core) {
        const nums = core[2].split('.').filter(Boolean).map(Number);
        const width = nums.length ? nums[nums.length - 1] : 0;
        if (width >= 1000 && !template) return null;
        u.pathname = `${core[1]}.${core[3]}${core[4] ?? ''}`;
        return u.toString();
    }

    // DAM thumbnails (cq5dam.thumbnail.319.319.png, x.jpg.thumb.319.319.png) → the standard web rendition.
    const thumb = path.match(/^(\/content\/dam\/.+?\.(?:jpe?g|png|gif|tiff?|webp))(?:\/(_jcr_content|jcr:content|jcr%3acontent)\/renditions\/cq5dam\.thumbnail\.\d+\.\d+\.png|\.thumb\.\d+\.\d+\.png)$/i);
    if (thumb) {
        u.pathname = `${thumb[1]}/${thumb[2] ?? '_jcr_content'}/renditions/cq5dam.web.1280.1280.jpeg`;
        return u.toString();
    }

    // Dynamic Media (Scene7): …/is/image/Company/name?wid=400&hei=300 — ask for a wide one, uncropped.
    if (/(^|\.)scene7\.com$/i.test(u.hostname) && path.startsWith('/is/image/')) {
        for (const k of ['wid', 'hei', 'fit', 'crop', 'size', 'scl', 'resMode']) u.searchParams.delete(k);
        u.searchParams.set('wid', '1600');
        return u.toString();
    }
    // Dynamic Media with OpenAPI (AEM as a Cloud Service): /adobe/dynamicmedia/deliver/…?width=…
    if (path.includes('/adobe/dynamicmedia/deliver/') && u.searchParams.has('width')) {
        u.searchParams.set('width', '1600');
        u.searchParams.delete('height');
        return u.toString();
    }
    return null;
}

export const adapter: BuilderAdapter = {
    key: 'aem',
    label: 'Adobe Experience Manager',
    detect: (html) => CLASSIC.test(html) || EDS.test(html),
    prepare($) {
        if (isEdgeDelivery($)) prepareEdgeDelivery($);
        prepareClassic($);
    },
    noise: /^(slide \d+( of \d+)?|choose a slide to display|opens in a new tab|(play|pause)( carousel)?|(file ?name|size|format)|\d+(\.\d+)?\s?(kb|mb|gb))$/i,
    fullSizeImage: aemFullSizeImage,
};
