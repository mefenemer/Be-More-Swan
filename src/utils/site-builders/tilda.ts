// src/utils/site-builders/tilda.ts — Website import adapter for Tilda.
// Findings, what is covered and what is not: docs/site-import-platforms/tilda.md
// Tests: tests/site-platform-tilda.test.ts (fixtures in tests/fixtures/site-platforms/tilda/).
//
// Tilda pages are server-rendered: every record ("block", div.t-rec) is in the HTML, inside
// div#allrecords; newer sites put the menu and footer in <header id="t-header">/<footer id="t-footer">.
// What the plain read got wrong, and what prepare() puts right:
//   · pictures are lazy — src is an empty or 20px thumbnail on thb/optim.tildacdn.*, the real one is
//     in data-original (on <img> and on background boxes, .t-bgimg);
//   · titles are often <div class="t-title"> and card titles <div class="t-name">, so they read as text;
//   · card grids are ul > li, so each card read as one run-on list item;
//   · Zero Block (t396) places every element absolutely — the source order is the order they were
//     added in the editor, not the order a visitor reads them;
//   · older sites keep the menu, its drop-downs (t794) and footer as ordinary records in #allrecords;
//   · "Made on Tilda" sits outside #allrecords, and pop-up forms (t-popup) are hidden furniture.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

type Tag = { type: string; name: string; parent: Tag | null };
const rename = (el: unknown, name: string) => { (el as Tag).name = name; };

/** Tilda's picture hosts (static = originals; thb/optim = resized copies), on its regional domains. */
const TILDA_CDN = /^(?:static|thb|optim)\.tildacdn\.[a-z]+$/i;

/**
 * A Tilda resized picture → the original. thb/optim keep the original's folder and name around an
 * Uploadcare-style operation chain: /tild3862-…/-/resize/20x/-/format/webp/bowls.jpg.webp →
 * static.tildacdn.com/tild3862-…/bowls.jpg. Null = not a Tilda copy (keep it).
 */
export function tildaFullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    if (!TILDA_CDN.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !/^tild[\w-]+$/i.test(parts[0])) return null;
    if (!parts.includes('-') && /^static\./i.test(u.hostname)) return null;   // already the original
    // optim/thb add ".webp" after the original's own extension when they convert it.
    const name = parts[parts.length - 1].replace(/\.(jpe?g|png|gif|heic)\.webp$/i, '.$1');
    return `https://static.tildacdn.${u.hostname.split('.').pop()}/${parts[0]}/${name}`;
}

/** "120", "120px", "var(--x,28px)" → the last number; "calc(50% - 600px + 20px)" → 20 (offset in the grid). */
function px(v: string | undefined | null): number | null {
    if (!v) return null;
    const s = String(v);
    const grid = s.match(/calc\(.*([+-])\s*(\d+(?:\.\d+)?)px\s*\)\s*$/);
    if (grid) return (grid[1] === '-' ? -1 : 1) * Number(grid[2]);
    const nums = [...s.matchAll(/-?\d+(?:\.\d+)?/g)];
    return nums.length ? Number(nums[nums.length - 1][0]) : null;
}

interface ZeroRule { top?: number; left?: number; height?: number; fontSize?: number }

/** A record's CSS for its Zero Block elements — desktop rules only (@media blocks are for phones). */
function zeroCss(css: string): Map<string, ZeroRule> {
    let desktop = '';
    for (let i = 0; i < css.length;) {
        const at = css.indexOf('@media', i);
        if (at < 0) { desktop += css.slice(i); break; }
        desktop += css.slice(i, at);
        const open = css.indexOf('{', at);
        if (open < 0) break;
        let depth = 1, j = open + 1;
        for (; j < css.length && depth; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; }
        i = j;
    }
    const prop = (body: string, name: string) => body.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`, 'i'))?.[1] ?? null;
    const out = new Map<string, ZeroRule>();
    for (const m of desktop.matchAll(/\.tn-elem\[data-elem-id=["']?(\d+)["']?\]\s*(\.tn-atom)?\s*\{([^}]*)\}/g)) {
        const [, id, atom, body] = m;
        const o = out.get(id) ?? {};
        const first = (key: keyof ZeroRule, cssName: string) => { if (o[key] === undefined) { const n = px(prop(body, cssName)); if (n !== null) o[key] = n; } };
        if (atom) first('fontSize', 'font-size');
        else { first('top', 'top'); first('left', 'left'); first('height', 'height'); }
        out.set(id, o);
    }
    return out;
}

/**
 * Zero Block: the elements in reading order (top to bottom; one row — tops within 16px — left to
 * right), out of their groups, and big short lines named as headings by their font size.
 */
function orderZeroBlocks($: cheerio.CheerioAPI): void {
    $('.t396__artboard').each((_, board) => {
        const $board = $(board);
        const rec = $board.closest('.t-rec');
        const rules = zeroCss((rec.length ? rec : $board).find('style').map((__, s) => $(s).text()).get().join('\n'));
        const boardH = px($board.attr('data-artboard-height')) ?? 0;
        let lastTop = 0;
        const placed = $board.find('.t396__elem').toArray().map((el, i) => {
            const $e = $(el);
            const r = rules.get($e.attr('data-elem-id') ?? '') ?? {};
            let top = px($e.attr('data-field-top-value')) ?? r.top ?? null;
            const left = px($e.attr('data-field-left-value')) ?? r.left ?? 0;
            const h = px($e.attr('data-field-height-value')) ?? r.height ?? 0;
            const axis = ($e.attr('data-field-axisy-value') ?? 'top').toLowerCase();
            if (top !== null && boardH) top += axis === 'center' ? (boardH - h) / 2 : axis === 'bottom' ? boardH - h : 0;
            if (top === null) top = lastTop;   // no position: stays beside the element before it
            lastTop = top;
            return { el, top, left, i, fontSize: r.fontSize ?? null };
        });
        placed.sort((a, b) => a.top - b.top || a.left - b.left || a.i - b.i);
        const rows: (typeof placed)[] = [];
        for (const p of placed) {
            const row = rows[rows.length - 1];
            if (row && p.top - row[0].top <= 16) row.push(p); else rows.push([p]);
        }
        for (const p of rows.flatMap((row) => row.sort((a, b) => a.left - b.left || a.i - b.i))) {
            $board.append(p.el);
            // Tilda lets the owner pick h1–h6 for a text element, but most leave it a <div>.
            const $e = $(p.el);
            if ($e.attr('data-elem-type') !== 'text') continue;
            const atom = $e.children('.tn-atom').get(0) as unknown as Tag | undefined;
            if (!atom || atom.type !== 'tag' || /^h[1-6]$/.test(atom.name)) continue;
            const len = $e.text().replace(/\s+/g, ' ').trim().length;
            const f = p.fontSize;
            const level = f !== null && f >= 36 && len <= 120 ? 2 : f !== null && f >= 24 && len <= 80 ? 3 : 0;
            if (level) rename(atom, `h${level}`);
        }
        $board.find('.t396__group, .tn-group').filter((__, g) => $(g).find('.t396__elem').length === 0).remove();
    });
}

function prepare($: cheerio.CheerioAPI): void {
    // Lazy pictures: the real address is in data-original.
    $('img[data-original]').each((_, el) => {
        const real = ($(el).attr('data-original') ?? '').trim();
        if (real) $(el).attr('src', real).removeAttr('srcset').removeAttr('data-src').removeAttr('data-srcset');
    });
    // Background pictures (.t-bgimg): an empty box becomes an <img> described by its own aria-label;
    // a box with content inside keeps it, and the picture goes just before it.
    $('div[data-original]').filter((_, el) => $(el).is('.t-bgimg, [bgimgfield], [data-content-cover-bg]')).each((_, el) => {
        const $el = $(el);
        const real = ($el.attr('data-original') ?? '').trim();
        if (!/^(https?:)?\/\//.test(real)) return;
        const img = $('<img>').attr('src', real).attr('alt', ($el.attr('aria-label') ?? '').trim());
        if ($el.children().length === 0 && !$el.text().trim()) $el.replaceWith(img);
        else { $el.removeAttr('style').removeAttr('data-original'); $el.before(img); }
    });

    // Older sites: the menu is a record inside #allrecords. Its record becomes the <header> — where
    // the import finds the menu and the logo, and which it leaves out of the page's words.
    $('#allrecords [data-menu="yes"]').each((_, el) => {
        if ($(el).closest('header, nav').length) return;
        const rec = $(el).closest('.t-rec');
        rename((rec.length ? rec : $(el)).get(0), 'header');
    });
    // Old drop-downs (t794): a record hooked to the menu's "#submenu:name" link → a list under that
    // menu entry (li > label + ul), which the import reads as a drop-down.
    $('[data-tooltip-hook^="#submenu:"]').each((_, el) => {
        const hook = $(el).attr('data-tooltip-hook') ?? '';
        const parent = $('a.t-menu__link-item').filter((__, a) => ($(a).attr('href') ?? '').trim() === hook).first();
        if (!parent.length) return;
        const ul = $('<ul class="submenu"></ul>');
        $(el).find('a[href]').each((__, a) => { ul.append($('<li></li>').append($(a).clone())); });
        const li = parent.closest('li');
        (li.length ? li : parent.parent()).append(ul);
        const rec = $(el).closest('.t-rec');
        (rec.length ? rec : $(el)).remove();
    });
    // New drop-downs (t-menusub): name the box so the import sees a sub-menu.
    $('.t-menusub').addClass('submenu');
    // A menu entry that only opens a drop-down (href "", "#" or "#submenu:…") is a label, not a page.
    $('a.t-menu__link-item').each((_, a) => {
        const href = ($(a).attr('href') ?? '').trim();
        if (href === '' || href === '#' || href.startsWith('#submenu:')) { rename(a, 'span'); $(a).removeAttr('href'); }
    });
    // The logo's link would name "Home" after the business (it comes first); the picture is what counts.
    $('header a[href]').filter((_, a) => !$(a).closest('ul, .t-menu__list').length && $(a).find('img, .t-title').length > 0).each((_, a) => {
        rename(a, 'span');
        $(a).removeAttr('href');
    });

    // Pop-up forms: the form goes anyway (our contact form has its own questions), so its title goes too.
    $('.t-popup').filter((_, p) => $(p).find('form').length > 0).remove();
    $('.t-popup__close, .t-tildalabel, #tildacopy').remove();

    // A Zero Block button that opens a pop-up or the cart has nowhere to go on the new site: a button with no link.
    $('[data-elem-type="button"] a.tn-atom').each((_, a) => {
        const href = ($(a).attr('href') ?? '').trim();
        if (!href || href.startsWith('#')) { rename(a, 'button'); $(a).removeAttr('href'); }
    });

    orderZeroBlocks($);

    // Titles drawn as <div>s: block titles → h2, card titles → h3.
    $('#allrecords div.t-title[field]').filter((_, el) => !$(el).closest('header, nav').length).each((_, el) => rename(el, 'h2'));
    $('#allrecords div.t-name[field*="title"], #allrecords div.t-heading[field*="title"]')
        .filter((_, el) => !$(el).closest('header, nav, .submenu').length).each((_, el) => rename(el, 'h3'));
    // Card grids are ul > li: a "list item" holding a title is a card, read title, words and picture one by one.
    $('#allrecords li').filter((_, li) => $(li).find('h2, h3').length > 0 && !$(li).closest('header, nav').length).each((_, li) => {
        rename(li, 'div');
        const ul = (li as unknown as Tag).parent;
        if (ul && ul.type === 'tag' && (ul.name === 'ul' || ul.name === 'ol')) rename(ul, 'div');
    });
}

export const adapter: BuilderAdapter = {
    key: 'tilda',
    label: 'Tilda',
    // Tilda's own page skeleton, not its CDN: any site can hot-link a picture from tildacdn.com.
    detect: (html, gen) => gen.includes('tilda') || /id=["']allrecords["']|data-tilda-page-id=|data-tilda-project-id=/.test(html),
    prepare,
    // Newer sites keep the menu and footer outside it; "Made on Tilda" always is.
    contentRoot: '#allrecords',
    noise: /^(made on( tilda)?|tilda|thank you! your data has been submitted\.?|please fill out all required fields\.?)$/i,
    fullSizeImage: (src) => tildaFullSize(src),
    rendersWithJs: false,
};
