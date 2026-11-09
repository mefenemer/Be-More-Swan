// src/utils/site-builders/weebly.ts — Website import adapter for Weebly (classic) and Square Online,
// which grew out of it and still serves from editmysite.com.
// Findings, what is covered and what is not: docs/site-import-platforms/weebly.md
// Tests: tests/site-platform-weebly.test.ts (fixtures in tests/fixtures/site-platforms/weebly/).
//
// Classic Weebly is server-rendered (`wsite-*` classes), but its menu sits outside <nav>, its
// sub-pages exist only in a script, its columns are a table and a paragraph is one <div> split by
// <br><br>. Square Online sends an empty #app and the page as JSON (window.__BOOTSTRAP_STATE__):
// prepare() turns that JSON into ordinary elements, so no headless browser is needed.
// Everything here only re-shapes the owner's own markup or data — it never adds words of its own.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The JSON value (object or array) starting at `start` in `text`, string-aware; null if unbalanced. */
export function balancedJson(text: string, start: number): string | null {
    const open = text[start];
    if (open !== '{' && open !== '[') return null;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (c === '\\') i++;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

function parseAt(text: string, from: number, opener: '{' | '['): unknown {
    const at = text.indexOf(opener, from);
    if (at < 0) return null;
    const raw = balancedJson(text, at);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function scriptText($: cheerio.CheerioAPI, marker: string): string | null {
    let found: string | null = null;
    $('script').each((_, el) => {
        if (found) return;
        const t = $(el).html() ?? '';
        if (t.includes(marker)) found = t;
    });
    return found;
}

// ── Classic Weebly ─────────────────────────────────────────────────────────────────────────────

interface FlyoutItem { title?: string; title_html?: string; url?: string; nav_menu?: boolean; nonclickable?: boolean; children?: FlyoutItem[] }

/** The whole menu, sub-pages included, from initPublishedFlyoutMenus([...]) — the HTML has only the top level. */
function flyoutMenu($: cheerio.CheerioAPI): string | null {
    const text = scriptText($, 'initPublishedFlyoutMenus(');
    if (!text) return null;
    const items = parseAt(text, text.indexOf('initPublishedFlyoutMenus('), '[');
    if (!Array.isArray(items) || !items.length) return null;
    const href = (u: string) => (/^(https?:)?\/\//i.test(u) ? u : u === 'index.html' || u === '' ? '/' : `/${u.replace(/^\/+/, '')}`);
    const list = (xs: FlyoutItem[], depth: number): string => `<ul>${(xs.filter((x) => isObj(x)) as FlyoutItem[]).map((x) => {
        const title = (x.title ?? x.title_html ?? '').replace(/<[^>]*>/g, '').trim();
        if (!title) return '';
        const kids = Array.isArray(x.children) && x.children.length && depth < 3 ? list(x.children, depth + 1) : '';
        const head = x.nav_menu || x.nonclickable || !x.url ? `<span>${esc(title)}</span>` : `<a href="${esc(href(x.url))}">${esc(title)}</a>`;
        return `<li>${head}${kids}</li>`;
    }).join('')}</ul>`;
    return `<nav class="weebly-menu">${list(items as FlyoutItem[], 0)}</nav>`;
}

/** Rename an element in place (td → div, div → footer) without touching what is inside it. */
function retag(el: unknown, name: string): void {
    const e = el as { type?: string; name?: string };
    if (e && e.type === 'tag') e.name = name;
}

const INLINE_BREAKERS = new Set(['ul', 'ol', 'blockquote', 'div', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'hr', 'img', 'iframe', 'figure']);

/** One div.paragraph ("text<br><br>text<ul>…</ul>text") → separate <p>s, lists kept as they are. */
function splitParagraph($: cheerio.CheerioAPI, el: unknown): void {
    const $el = $(el as never);
    const kids = $el.contents().toArray();
    const out: string[] = [];
    let cur = '';
    let brRun = 0;
    const flush = () => { if (cur.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;|\s/g, '')) out.push(`<p>${cur.replace(/^(\s|<br\s*\/?>)+|(\s|<br\s*\/?>)+$/gi, '')}</p>`); cur = ''; };
    for (const k of kids) {
        const n = k as { type: string; name?: string; data?: string };
        if (n.type === 'tag' && n.name === 'br') {
            brRun++;
            if (brRun >= 2) { flush(); brRun = 0; } else cur += '<br>';
            continue;
        }
        if (n.type === 'text' && !/\S/.test(n.data ?? '')) { cur += n.data ?? ''; continue; }
        brRun = 0;
        if (n.type === 'tag' && INLINE_BREAKERS.has(n.name ?? '')) { flush(); out.push($.html(k as never)); continue; }
        if (n.type === 'text' || n.type === 'tag') cur += $.html(k as never);
    }
    flush();
    $el.replaceWith(`<div class="weebly-paragraph">${out.join('')}</div>`);
}

/** Cloudflare's email protection ("[email protected]"): the address is XOR-coded in the page itself. */
export function decodeCfEmail(hex: string): string | null {
    if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let s = '';
    for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return /^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i.test(s) ? s : null;
}

function prepareClassic($: cheerio.CheerioAPI): void {
    // The menu. The script's copy has the sub-pages; the HTML's copies (desktop, phone, "dummy") don't.
    const menu = flyoutMenu($);
    if (menu) {
        $('ul.wsite-menu-default').remove();
        $('body').prepend(menu);
    } else {
        $('.wsite-menu-wrap').each((_, el) => { $(el).replaceWith($(el).html() ?? ''); });
        $('ul.wsite-menu-default').filter((_, el) => $(el).closest('nav, header').length === 0).wrap('<nav class="weebly-menu"></nav>');
    }
    // The logo (picture or title words) is the site's header, not page content.
    // Its link home is not a menu entry: it would take the menu's "Home" place under the site's name.
    $('.wsite-logo').filter((_, el) => $(el).closest('header').length === 0).wrap('<header class="weebly-logo"></header>');
    $('.wsite-logo a').removeAttr('href');

    // Weebly's own furniture.
    $([
        '#weebly-footer-signup-container-v3', '#weeblyFooter', '.weebly-footer-signup-container', '.wsite-view-link-mobile',
        '.wsite-search', '#wsite-header-search-form', '.wsite-custom-membership-wrapper', '#member-login', '.login-link',
        '.wsite-nav-cart', '#wsite-nav-cart-a', '#wsite-mini-cart', '.mini-cart-screen', '#customer-accounts-app',
        '.hamburger', '.mobile-nav-toggle', '.wsite-spacer',
        '.blog-sidebar', '.blog-social', '.blog-comments-top', '.blog-comments-bottom', '.blog-comments', '#commentArea', '.blog-date', '.blog-feed-link',
    ].join(', ')).remove();

    // The footer: Weebly themes draw it as divs, so it would be read as page content. Topmost only.
    const feet = $('#footer, #footer-wrap, .footer-wrap, .wsite-footer, .footer').toArray();
    for (const el of feet) if (!feet.some((o) => o !== el && $(el).parents().toArray().includes(o as never))) retag(el, 'footer');

    // Columns are a table; a table cell is read as one text block (heading, caption and text run together).
    $('table.wsite-multicol-table, .wsite-multicol-tbody, .wsite-multicol-tr, .wsite-multicol-col').each((_, el) => retag(el, 'div'));

    // Paragraphs: one div per text box, split by <br><br>, sometimes with a list inside.
    $('div.paragraph').toArray().reverse().forEach((el) => splitParagraph($, el));

    // Pictures. "Picture" is Weebly's default description, not the owner's.
    $('img[alt]').filter((_, el) => /^(picture|image)$/i.test(($(el).attr('alt') ?? '').trim())).removeAttr('alt');
    // A gallery thumbnail links to its full-size original (photo_orig.jpg) — read that instead.
    $('a[href] > img').each((_, img) => {
        const href = ($(img).parent().attr('href') ?? '').trim();
        if (/\/uploads\/.+\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(href)) { $(img).attr('src', href).removeAttr('srcset').removeAttr('data-src'); }
    });
    // Slideshows are drawn by wSlideshow.render({…, images:[…]}) — the pictures exist only in the script.
    $('script').each((_, el) => {
        const t = $(el).html() ?? '';
        if (!t.includes('wSlideshow.render(')) return;
        const id = t.match(/elementID\s*:\s*["']?(\d+)/)?.[1];
        const images = parseAt(t, t.indexOf('images'), '[');
        if (!Array.isArray(images)) return;
        const imgs = images.filter(isObj).map((im) => {
            const url = typeof im.url === 'string' ? im.url : '';
            if (!/^[\w./%-]+\.(jpe?g|png|gif|webp)$/i.test(url)) return '';
            const alt = typeof im.caption === 'string' ? im.caption.trim() : '';
            return `<img src="/uploads/${esc(url.replace(/^\/+|^uploads\//g, ''))}"${alt ? ` alt="${esc(alt)}"` : ''}>`;
        }).join('');
        const slot = id ? $(`#${id}-slideshow`) : $();
        if (slot.length) slot.first().append(imgs); else $(el).after(`<div>${imgs}</div>`);
    });
    // Weebly's map box frames weebly.com; the place it shows is in the address. A Google map frame
    // is what the import already turns into a map link.
    $('iframe[src*="generateMap.php"]').each((_, el) => {
        const src = $(el).attr('src') ?? '';
        const lat = src.match(/[?&]lat=(-?\d{1,3}(?:\.\d+)?)/)?.[1];
        const lng = src.match(/[?&]long=(-?\d{1,3}(?:\.\d+)?)/)?.[1];
        if (lat && lng) $(el).attr('src', `https://www.google.com/maps/embed?q=${lat},${lng}`);
        else $(el).remove();
    });
}

// ── Square Online ──────────────────────────────────────────────────────────────────────────────

interface SqCtx { routes: Map<string, string>; home: string | null }

function sqLink(l: unknown, ctx: SqCtx): string | null {
    if (!isObj(l)) return null;
    const inner = isObj(l.link) ? l.link : l;
    const page = isObj(inner.page) ? inner.page : null;
    if (page && typeof page.pageID === 'string') {
        if (page.pageID === ctx.home) return '/';
        const r = ctx.routes.get(page.pageID);
        return r !== undefined ? `/${r}` : null;
    }
    if (typeof inner.external === 'string' && /^(https?:\/\/|mailto:|tel:)/i.test(inner.external.trim())) return inner.external.trim();
    if (typeof inner.email === 'string' && inner.email.includes('@')) return `mailto:${inner.email.trim()}`;
    if (typeof inner.phone === 'string' && /\d{6,}/.test(inner.phone.replace(/\D/g, ''))) return `tel:${inner.phone.replace(/[^\d+]/g, '')}`;
    return null;
}

/** Quill ops → paragraphs, list items and headings, links kept inside the words. */
function quillHtml(q: unknown, ctx: SqCtx, headingTag: string | null): string {
    const ops = isObj(q) && Array.isArray(q.ops) ? q.ops : [];
    const lines: { html: string; attrs: Json }[] = [];
    let cur = '';
    for (const op of ops) {
        if (!isObj(op) || typeof op.insert !== 'string') continue;
        const attrs = isObj(op.attributes) ? op.attributes : {};
        const parts = op.insert.split('\n');
        parts.forEach((part, i) => {
            if (part) {
                const href = attrs.wLink ? sqLink(attrs.wLink, ctx) : attrs.link && typeof attrs.link === 'string' ? attrs.link : null;
                cur += href ? `<a href="${esc(href)}">${esc(part)}</a>` : esc(part);
            }
            if (i < parts.length - 1) { lines.push({ html: cur, attrs }); cur = ''; }
        });
    }
    if (cur) lines.push({ html: cur, attrs: {} });
    if (headingTag) {
        const t = lines.map((l) => l.html).filter((h) => h.trim()).join(' ');
        return t.trim() ? `<${headingTag}>${t}</${headingTag}>` : '';
    }
    let out = '';
    let inList = false;
    for (const l of lines) {
        if (!l.html.trim()) { if (inList) { out += '</ul>'; inList = false; } continue; }
        if (l.attrs.list) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${l.html}</li>`; continue; }
        if (inList) { out += '</ul>'; inList = false; }
        const h = Number(l.attrs.header);
        out += h >= 1 && h <= 6 ? `<h${h}>${l.html}</h${h}>` : l.attrs.blockquote ? `<blockquote>${l.html}</blockquote>` : `<p>${l.html}</p>`;
    }
    return inList ? `${out}</ul>` : out;
}

const SQ_SKIP_KEYS = new Set(['settings', 'styles', 'style', 'link', 'colorProfile', 'layoutSettings', 'animation', 'spacing']);
/** Store blocks: products, categories, ordering — their prices belong in Business Information. */
const SQ_SKIP_BLOCKS = /^(featured-products|product|products|category|categories|order-online|store-locator|cart|instagram|gift-card|subscribe|social-feed)/;
const TITLE_KEYS = new Set(['title', 'heading', 'headline', 'subtitle', 'callout']);
const BUTTON_KEYS = new Set(['button', 'secondaryButton', 'primaryButton', 'cta']);

function sqImage(o: Json): string {
    const src = typeof o.original === 'string' ? o.original : typeof o.source === 'string' ? o.source : '';
    if (!src || !/^(https?:\/\/|\/)/.test(src)) return '';
    const alt = typeof o.altText === 'string' ? o.altText.trim() : '';
    return `<img src="${esc(src)}"${alt ? ` alt="${esc(alt)}"` : ''}>`;
}

function sqButton(o: Json, ctx: SqCtx): string {
    if (o.hidden === true || typeof o.label !== 'string' || !o.label.trim()) return '';
    const href = sqLink(o.link, ctx);
    return href ? `<a class="button" href="${esc(href)}">${esc(o.label.trim())}</a>` : '';
}

function sqNode(v: unknown, ctx: SqCtx, heading: string | null, depth: number): string {
    if (depth > 30) return '';
    if (Array.isArray(v)) return v.map((x) => sqNode(x, ctx, heading, depth + 1)).join('');
    if (!isObj(v) || v.hidden === true) return '';
    if (isObj(v.quill)) return quillHtml(v.quill, ctx, heading);
    if (typeof v.purpose === 'string') {
        const kind = v.purpose.split('@')[0];
        if (SQ_SKIP_BLOCKS.test(kind)) return '';
        const p = isObj(v.properties) ? v.properties : {};
        if (p.hidden === true) return '';
        if (/^(title|heading|subtitle)/.test(kind)) return sqNode(p.title ?? p.content, ctx, typeof p.tag === 'string' && /^h[1-6]$/.test(p.tag) ? p.tag : 'h2', depth + 1);
        if (/^button/.test(kind)) return sqButton(p, ctx);
        if (/^image/.test(kind)) return isObj(p.image) ? sqNode({ image: p.image }, ctx, null, depth + 1) : '';
    }
    let out = '';
    for (const [k, val] of Object.entries(v)) {
        if (SQ_SKIP_KEYS.has(k) || val === null || typeof val !== 'object') {
            // A plain string is a heading only where the block says so ({callout: {content: "…"}}).
            if (heading && (k === 'content' || k === 'text') && typeof val === 'string' && val.trim()) out += `<${heading}>${esc(val.trim())}</${heading}>`;
            continue;
        }
        if (isObj(val) && val.hidden === true) continue;
        if (BUTTON_KEYS.has(k) && isObj(val)) { out += sqButton(val, ctx); continue; }
        if ((k === 'image' || k === 'figure' || k === 'bannerImage' || k === 'backgroundImage') && isObj(val) && (typeof val.original === 'string' || typeof val.source === 'string')) { out += sqImage(val); continue; }
        if (TITLE_KEYS.has(k) && isObj(val)) {
            const tag = typeof val.tag === 'string' && /^h[1-6]$/.test(val.tag) ? val.tag : k === 'callout' || k === 'subtitle' ? 'h3' : 'h2';
            out += sqNode(val, ctx, tag, depth + 1);
            continue;
        }
        out += sqNode(val, ctx, heading, depth + 1);
    }
    return out;
}

function prepareSquareOnline($: cheerio.CheerioAPI): boolean {
    const text = scriptText($, '__BOOTSTRAP_STATE__');
    if (!text) return false;
    const state = parseAt(text, text.indexOf('__BOOTSTRAP_STATE__'), '{');
    if (!isObj(state) || !isObj(state.siteData)) return false;
    const site = state.siteData;
    const snap = isObj(site.snapshot) && isObj(site.snapshot.properties) ? site.snapshot.properties : {};
    const meta = Array.isArray(site.pagesMeta) ? site.pagesMeta.filter(isObj) : [];
    const ctx: SqCtx = { routes: new Map(), home: typeof snap.homePage === 'string' ? snap.homePage : null };
    const names = new Map<string, string>();
    const hidden = new Set<string>();
    for (const m of meta) {
        if (typeof m.id !== 'string') continue;
        if (typeof m.route === 'string') ctx.routes.set(m.id, m.route);
        if (typeof m.name === 'string') names.set(m.id, m.name);
        if (m.hidden === true) hidden.add(m.id);
    }

    // The menu (autoNavLinks): pages by id, outside links by their title; store categories are left out.
    const navList = (xs: unknown, depth: number): string => {
        if (!Array.isArray(xs) || depth > 3) return '';
        const lis = xs.filter(isObj).map((x) => {
            const inner = isObj(x.link) ? x.link : {};
            const pid = isObj(inner.page) && typeof inner.page.pageID === 'string' ? inner.page.pageID : null;
            if (x.type === 'category' || (pid && hidden.has(pid))) return '';
            const title = typeof x.title === 'string' && x.title.trim() ? x.title.trim() : pid ? names.get(pid) ?? '' : '';
            const href = sqLink(x, ctx);
            if (!title) return '';
            const kids = navList(x.children, depth + 1);
            return `<li>${href ? `<a href="${esc(href)}">${esc(title)}</a>` : `<span>${esc(title)}</span>`}${kids}</li>`;
        }).join('');
        return lis ? `<ul>${lis}</ul>` : '';
    };
    const nav = navList(state.autoNavLinks, 0);
    const title = typeof snap.title === 'string' ? snap.title.trim() : '';
    const logo = typeof snap.logo === 'string' && /^(https?:\/\/|\/)/.test(snap.logo) ? `<img class="logo" src="${esc(snap.logo)}" alt="${esc(title)}">` : '';

    const page = isObj(site.page) && isObj(site.page.properties) ? site.page.properties : null;
    const areas = page && isObj(page.contentAreas) ? page.contentAreas : {};
    const order = ['banner', 'userContent', ...Object.keys(areas).filter((k) => !['banner', 'userContent', 'sticky', 'header', 'footer'].includes(k))];
    const body = order.map((k) => sqNode(areas[k], ctx, null, 0)).join('');
    if (!body && !nav) return false;

    const html = `${logo || nav ? `<header>${logo}${nav ? `<nav>${nav}</nav>` : ''}</header>` : ''}<main>${body}</main>`;
    $('.loading-view').remove();
    const app = $('#app');
    if (app.length && !(app.text() ?? '').trim()) app.first().html(html); else $('body').append(html);
    return true;
}

export const adapter: BuilderAdapter = {
    key: 'weebly',
    label: 'Weebly / Square Online',
    detect: (html, gen) => gen.includes('weebly') || gen.includes('square online') || /editmysite\.com|weebly\.com\/|class="[^"]*\bwsite-[a-z]/i.test(html),
    prepare($) {
        if (prepareSquareOnline($)) return;
        prepareClassic($);
        // Cloudflare-protected addresses (Weebly sites sit behind Cloudflare): decoded, so the
        // import sees the owner's email instead of "[email protected]".
        $('[data-cfemail]').each((_, el) => {
            const e = decodeCfEmail($(el).attr('data-cfemail') ?? '');
            if (e) $(el).replaceWith(esc(e));
        });
        $('a[href*="/cdn-cgi/l/email-protection"]').each((_, el) => {
            const e = decodeCfEmail(($(el).attr('href') ?? '').split('#')[1] ?? '');
            if (e) $(el).attr('href', `mailto:${e}`); else $(el).removeAttr('href');
        });
    },
    noise: /^(\d+ comments?|rss feed|get started|create your own unique website.*|powered by weebly|archives|categories|mobile site|picture|\[email(\s|&nbsp;| )protected\])$/i,
    fullSizeImage(src) {
        let u: URL;
        try { u = new URL(src); } catch { return null; }
        // Square Online: one original, sized on request (?width=640&optimize=high&dpr=2).
        if (/\/uploads\/b\//.test(u.pathname) || /(^|\.)editmysite\.com$/.test(u.hostname)) {
            for (const k of ['width', 'height', 'optimize', 'dpr', 'crop', 'fit', 'quality']) u.searchParams.delete(k);
            return u.toString();
        }
        // Classic Weebly: /uploads/1/2/3/4/123456/…?1700000000 — the query is only a cache-buster.
        if (/^\/uploads\/\d\/\d\/\d\/\d\/\d+\//.test(u.pathname) && /^\?\d*$/.test(u.search)) { u.search = ''; return u.toString(); }
        return null;
    },
    rendersWithJs: false,
};
