// src/utils/site-builders/godaddy.ts — Website import adapter for GoDaddy Website Builder (Websites + Marketing).
// Findings, what is covered and what is not: docs/site-import-platforms/godaddy.md
// Tests: tests/site-platform-godaddy.test.ts (fixtures in tests/fixtures/site-platforms/godaddy/).
//
// GoDaddy pages are server-rendered React ("UX" widgets): every element carries data-ux (what it is)
// and often data-aid (which field it shows). The words are in the HTML; what goes wrong is the
// furniture around them — lazy pictures behind a placeholder, picture addresses with commas in them
// (rs=w:200,h:200,cg:true), the hero drawn twice (desktop and phone), hidden copies of other cards'
// headings used to even out card heights, and account/cart/search menus.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';
import { fontKeyFor, type ImportedLook } from '../site-import-theme';

/** GoDaddy's picture service: img1.wsimg.com/isteam/ip/<site>/<file>/:/<operations>. */
const WSIMG = /^(?:https?:)?\/\/img\d*\.wsimg\.com\/isteam\//i;
/** Pictures from GoDaddy's own stock library — licensed for use on GoDaddy sites, not the owner's to move. */
const STOCK = /\/\/img\d*\.wsimg\.com\/isteam\/(?:stock|getty)\//i;
const PLACEHOLDER = /\/isteam\/ip\/static\/|^data:/i;

/**
 * A srcset whose addresses contain commas. GoDaddy's do ("…/rs=w:400,h:400,cg:true,m 2x"), so
 * splitting on every comma breaks them: split only on a comma followed by space and a new address.
 */
export function goDaddySrcset(srcset: string | undefined): string | null {
    if (!srcset) return null;
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(/,\s+(?=(?:https?:)?\/\/)/)) {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) continue;
        const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 1;
        if (!best || w > best.w) best = { url, w };
    }
    return best?.url ?? null;
}

/**
 * A resized GoDaddy picture → a large version of the same picture. The operations after "/:/" are
 * crop (cr=), resize (rs=), quality (qt=) and lazy (ll=). The owner's own crop is kept when it is in
 * percentages and comes before the resize (it then means the same at any size); pixel crops after a
 * resize only make sense at that size, so they go. 1600 wide, like the Wix rule (not the camera's original).
 */
export function goDaddyFullSize(src: string): string | null {
    if (!WSIMG.test(src)) return null;
    const at = src.indexOf('/:/');
    const abs = src.startsWith('//') ? `https:${src}` : src;
    if (at < 0) return abs;
    const base = abs.slice(0, abs.indexOf('/:/'));
    const ops = src.slice(at + 3).split('/');
    const rsAt = ops.findIndex((o) => o.startsWith('rs='));
    const crop = ops.find((o, i) => o.startsWith('cr=') && /%25|%/.test(o) && (rsAt < 0 || i < rsAt));
    return `${base}/:/${crop ? `${crop}/` : ''}rs=w:1600,m`;
}

/** The glamor stylesheets' one-class rules: ".x .c1-6n{background-image:url(…)}" → c1-6n → declarations. */
function glamorRules(css: string): Map<string, string> {
    const rules = new Map<string, string>();
    for (const m of css.matchAll(/\.x \.(c\d+-[\w-]+)(:[\w-]+)?\s*\{([^}]*)\}/g)) {
        if (m[2]) continue;   // :hover and friends are not the resting look
        rules.set(m[1], `${rules.get(m[1]) ?? ''};${m[3]}`);
    }
    return rules;
}

function prepare($: cheerio.CheerioAPI): void {
    const text = (el: cheerio.Cheerio<any>) => el.text().replace(/\s+/g, ' ').trim();
    const rules = glamorRules($('style[data-glamor]').map((_, s) => $(s).text()).get().join('\n'));

    // Platform furniture: account, cart and search menus, the phone menu button, cookie banner,
    // chat bubble, gallery arrows and "1/6" counter, "Powered by GoDaddy".
    $([
        '[data-ux="UtilitiesMenu"]', '[data-ux="Membership"]', '[id*="membership" i]', '[data-aid^="MEMBERSHIP"]',
        '[data-aid^="SEARCH_"]', '[data-aid="CART_ICON_RENDER"]', '[data-aid="HAMBURGER_MENU_LINK"]',
        '[data-aid*="COOKIE"]', '[data-aid="MESSAGING_FAB"]', '[data-aid="GALLERY_SLIDE_POSITION"]',
        '[data-aid^="GALLERY_SCROLL"]', '[data-aid="FOOTER_POWERED_BY_RENDERED"]', '[data-aid^="CONTACT_HOURS_COLLAPSED"]',
    ].join(', ')).remove();
    // Copies drawn only to size text ("scaler"), never seen.
    $('[data-ux="scaler"]').remove();

    // The menu's "More" box repeats the menu for when it overflows. Its links that are not in the
    // menu already become ordinary menu entries (never a drop-down called "More"); the box goes.
    $('[data-aid="NAV_MORE"]').each((_, el) => {
        const item = $(el).closest('li');
        const list = item.parent('ul');
        if (!item.length || !list.length) return;
        const have = new Set(list.children('li').not(item).find('a[href]').map((_, a) => $(a).attr('href')).get());
        item.find('ul a[href]').each((_, a) => {
            const href = $(a).attr('href');
            if (!href || href === '#' || have.has(href)) return;
            have.add(href);
            item.before($('<li></li>').append($('<a></a>').attr('href', href).text(text($(a)))));
        });
        item.remove();
    });
    // The logo links home: it is the logo, not a menu entry named after the business.
    $('[data-aid="HEADER_LOGO_RENDERED"] a[href]').removeAttr('href');
    // Links that only work with GoDaddy's scripts ("#", often with "#" as their words).
    $('a[href="#"]').filter((_, a) => /^#?$/.test(text($(a)))).remove();

    // The hero is drawn twice (desktop and phone): keep the first of each field.
    const seen = new Set<string>();
    $('[data-aid="HEADER_WIDGET"] [data-aid]').each((_, el) => {
        const $el = $(el);
        const aid = $el.attr('data-aid') ?? '';
        if (/^HEADER_(SECTION|WIDGET)$/.test(aid) || !$el.closest('html').length) return;
        const key = `${aid}|${text($el)}|${$el.attr('href') ?? ''}`;
        if (seen.has(key)) $el.remove(); else seen.add(key);
    });
    // A card carries hidden copies of the other cards' headings to even out heights; its own has a data-aid.
    $('[data-ux="ContentCard"]').each((_, card) => {
        const heads = $(card).find('[data-ux="ContentCardHeading"]');
        if (heads.filter('[data-aid]').length) heads.not('[data-aid]').remove();
    });
    // Opening hours: a day and its hours are one line (else every "10:00 am – 04:00 pm" after the first reads as a repeat).
    $('tr[data-aid^="CONTACT_HOURS_DAY_REND"]').each((_, tr) => {
        const cells = $(tr).children('td').map((_, td) => text($(td))).get().filter(Boolean);
        $(tr).replaceWith($('<p></p>').text(cells.join(' ')));
    });

    // Pictures: the real address waits in data-srclazy / data-srcsetlazy behind a placeholder, and
    // srcsets have commas inside their addresses — so each picture gets one plain src.
    $('img').each((_, el) => {
        const $el = $(el);
        const candidates = [goDaddySrcset($el.attr('data-srcsetlazy')), $el.attr('data-srclazy'), goDaddySrcset($el.attr('srcset')), $el.attr('src')];
        const real = candidates.find((s) => s && !PLACEHOLDER.test(s)) ?? null;
        if (real && STOCK.test(real)) { $el.remove(); return; }
        if (!real || !WSIMG.test(real)) return;
        $el.removeAttr('srcset').removeAttr('data-srcset').removeAttr('data-src').removeAttr('data-srcsetlazy').removeAttr('data-srclazy').attr('src', real);
    });
    // Background pictures live in the stylesheet, one class per screen size: put the first on the element.
    $('[data-lazybg], [data-ux="Background"], [data-ux^="Background"], [data-ux="HeaderMediaFillBackground"]').each((_, el) => {
        const $el = $(el);
        if (/background-image/i.test($el.attr('style') ?? '')) return;
        for (const c of ($el.attr('class') ?? '').split(/\s+/)) {
            const url = (rules.get(c) ?? '').match(/background-image\s*:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i)?.[1];
            if (!url) continue;
            if (!STOCK.test(url)) $el.attr('style', `${$el.attr('style') ? `${$el.attr('style')};` : ''}background-image:url("${url}")`);
            break;
        }
    });
}

/**
 * Their look as GoDaddy draws it: the main button's colour and the heading and body lettering live in
 * per-class rules (".x .c1-f{background-color:rgb(…)}"), which the general reader can't tie to an
 * element. Not wired in yet (site-import-theme.ts is shared) — see the report's "Can be done".
 */
export function readGoDaddyLook(html: string, $: cheerio.CheerioAPI): Partial<ImportedLook> {
    const rules = glamorRules($('style[data-glamor]').map((_, s) => $(s).text()).get().join('\n'));
    const decl = (sel: string, prop: string): string | null => {
        for (const el of $(sel).toArray()) {
            for (const c of ($(el).attr('class') ?? '').split(/\s+/)) {
                const v = (rules.get(c) ?? '').match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim();
                if (v) return v;
            }
        }
        return null;
    };
    const hex = (v: string | null): string | null => {
        const m = v?.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
        if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
        const [r, g, b] = [m[1], m[2], m[3]].map(Number);
        // A white, black or grey button is the template's, not a brand colour.
        if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return null;
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    };
    const family = (v: string | null) => v?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || null;
    const primaryColor = hex(decl('[data-ux$="ButtonPrimary"]:not([data-aid*="COOKIE"])', 'background-color'));
    const headingFont = family(decl('[data-ux="Tagline"], [data-typography^="Heading"]', 'font-family'));
    const bodyFont = family(decl('[data-typography^="Body"], [data-ux="ContentText"]', 'font-family'));
    void html;
    return { primaryColor, headingFont, font: fontKeyFor(headingFont, bodyFont) };
}

export const adapter: BuilderAdapter = {
    key: 'godaddy',
    // The main button's colour and the lettering from GoDaddy's per-class rules (main session, 2026-11-09).
    look: ({ html, $ }) => readGoDaddyLook(html, $),
    label: 'GoDaddy Website Builder',
    // The generator tag survives custom domains ("Starfield Technologies; Go Daddy Website Builder 8.0.0000").
    // Without it: GoDaddy's widget markup AND its picture/script host together — the word "GoDaddy" or a
    // wsimg.com picture alone is any site that bought a domain there or links to it.
    detect: (html, gen) =>
        /starfield technologies|go ?daddy website builder/.test(gen) ||
        (/data-ux="(?:Page|Widget|Header|Section)"/.test(html) && /data-aid="[A-Z_0-9]+_RENDERED/.test(html) && /\/\/img\d*\.wsimg\.com\/(?:isteam|blobby\/go)\//i.test(html)),
    prepare,
    contentRoot: '[data-ux="Page"]',
    noise: /^(powered by( godaddy)?|this website uses cookies\.?|signed in as:?|message us|shopping cart icon|\d+\s*\/\s*\d+)$/i,
    fullSizeImage: goDaddyFullSize,
    rendersWithJs: false,
};
