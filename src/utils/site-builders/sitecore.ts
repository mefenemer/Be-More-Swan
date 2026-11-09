// src/utils/site-builders/sitecore.ts — Website import adapter for Sitecore.
// Findings, what is covered and what is not: docs/site-import-platforms/sitecore.md
// Tests: tests/site-platform-sitecore.test.ts (fixtures in tests/fixtures/site-platforms/sitecore/).
//
// Two shapes of Sitecore site:
//  • XP / XM with MVC renderings (usually SXA): server-rendered HTML, components as
//    div.component.<name> > div.component-content, pictures from the media library at
//    /-/media/… (older: /~/media/….ashx) resized by ?h=&w=&mw=&mh=…&hash=.
//  • Headless — JSS (React/Angular/Vue) and XM Cloud (Next.js): the Layout Service's JSON
//    (sitecore.route.placeholders → renderings → fields) rides in __NEXT_DATA__ (pageProps.layoutData)
//    or __JSS_STATE__; pictures from /-/jssmedia/… or edge.sitecorecloud.io/<tenant>/media/…, often
//    wrapped in Next.js's /_next/image?url=….
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** The media library's own address on the site: /-/media/, /~/media/, /-/jssmedia/. */
const MEDIA_PATH = /^\/[-~]\/(?:jss)?media\//i;
/** XM Cloud's Experience Edge (and its preview hosts). */
const EDGE_HOST = /(^|\.)sitecorecloud\.io$/i;
/** The media handler's resizing and cropping parameters (and the hash that signs them). */
const RESIZE_PARAMS = ['h', 'w', 'mh', 'mw', 'sc', 'as', 'bc', 'hash', 'iar', 'thn', 'dmc', 'crop', 'cx', 'cy', 'cw', 'ch', 'gray'];
/** Same thinness bar as the import (site-import.ts IMPORT_THIN_WORDS) — not imported, to keep the adapter free of cycles. */
const THIN_WORDS = 40;

/** Sitecore's own furniture, never the owner's words. */
const FURNITURE = [
    '.privacy-warning',                       // SXA cookie warning (class names avoid the word "cookie")
    '.component.breadcrumb', '.component.social-media-share', '.component.search-box', '.component.search-results',
    '.component.language-selector', '.component.back-to-top', '.component.archive', '.component.site-selector',
    'code[type="text/sitecore"]', '.scChromeData', '.scLooseFrameZone', '.scEmptyPlaceholder',   // Experience Editor leftovers
].join(', ');

function fullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    // Next.js's optimiser wraps the real picture: /_next/image?url=<encoded>&w=1920&q=75.
    if (/\/_next\/image\/?$/.test(u.pathname) && u.searchParams.get('url')) {
        try {
            const inner = new URL(u.searchParams.get('url')!, u);
            return fullSize(inner.toString()) ?? inner.toString();
        } catch { return null; }
    }
    const media = MEDIA_PATH.test(u.pathname) || (EDGE_HOST.test(u.hostname) && /\/media\//i.test(u.pathname));
    if (!media) return null;
    for (const p of RESIZE_PARAMS) u.searchParams.delete(p);
    // Ask for a sensible size, not the camera's: without a valid hash Sitecore ignores this and
    // serves the original, so it can only help.
    u.searchParams.set('mw', '1600');
    return u.toString();
}

function words(text: string): number { return text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length; }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The Layout Service's sitecore object from __NEXT_DATA__ (Next.js) or __JSS_STATE__ (JSS apps). */
function layoutOf($: cheerio.CheerioAPI): Record<string, Json> | null {
    const read = (sel: string) => { try { return JSON.parse($(sel).first().text() || 'null') as Json; } catch { return null; } };
    const next = read('script#__NEXT_DATA__');
    const fromNext = isObj(next) && isObj(next.props) && isObj(next.props.pageProps) && isObj(next.props.pageProps.layoutData) ? next.props.pageProps.layoutData.sitecore : null;
    if (isObj(fromNext) && isObj(fromNext.route)) return fromNext;
    const jss = read('script#__JSS_STATE__');
    const fromJss = isObj(jss) ? jss.sitecore : null;
    return isObj(fromJss) && isObj(fromJss.route) ? fromJss : null;
}

/** Keys that hold settings, ids or metadata — never words a visitor reads. */
const SKIP_KEY = /^(id|uid|itemid|name|displayname|templatename|templateid|url|path|params|styles|cssclass|gridparameters|rendering|experiences|navigationfilter|sxatags|querystring|anchor|target|linktype|(meta|opengraph|og|twitter|robots|canonical|seo|page ?design).*|.*(class|style|colou?r|theme|variant|keywords)s?)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/** Turns the Layout Service JSON into ordinary elements, in the editor's order. Adds no words of its own. */
class LayoutWriter {
    private h1 = false;
    private depth = 0;

    field(key: string, value: Json, zone: string): string {
        if (typeof value === 'string') {
            const v = value.trim();
            if (!v || ISO_DATE.test(v)) return '';
            if (/<[a-z][\s\S]*>/i.test(v)) return `<div>${v}</div>`;   // rich text: their own HTML (scripts go before reading)
            if (/quote|testimonial/i.test(key)) return `<blockquote>${esc(v)}</blockquote>`;
            if (/(heading|title|headline)$/i.test(key)) {
                const level = !this.h1 && zone === 'main' ? 1 : 2;
                if (level === 1) this.h1 = true;
                return `<h${level}>${esc(v)}</h${level}>`;
            }
            return `<p>${esc(v)}</p>`;
        }
        if (isObj(value)) {
            if (typeof value.src === 'string' && value.src) {
                const dim = ['width', 'height'].map((d) => (value[d] ? ` ${d}="${esc(String(value[d]))}"` : '')).join('');
                return `<img src="${esc(value.src)}" alt="${esc(typeof value.alt === 'string' ? value.alt : '')}"${dim}>`;
            }
            const href = typeof value.href === 'string' ? value.href.trim() : '';
            const text = typeof value.text === 'string' ? value.text.trim() : '';
            if (href && text && !/^javascript:/i.test(href)) return `<a href="${esc(href)}">${esc(text)}</a>`;
        }
        return '';
    }

    fields(obj: Json, zone: string): string {
        if (this.depth > 12) return '';
        this.depth++;
        try {
            if (Array.isArray(obj)) return obj.map((it) => (isObj(it) ? `<div>${this.fields(isObj(it.fields) || Array.isArray(it.fields) ? it.fields : it, zone)}</div>` : '')).join('');
            if (!isObj(obj)) return '';
            let out = '';
            for (const [k, v] of Object.entries(obj)) {
                if (SKIP_KEY.test(k)) continue;
                if (isObj(v) && ('value' in v || 'jsonValue' in v)) {
                    const f = isObj(v.jsonValue) ? v.jsonValue : v;
                    out += this.field(k, f.value, zone);
                } else if (isObj(v) || Array.isArray(v)) {
                    out += this.fields(v, zone);   // data → datasource → children → results, multilists, items
                }
            }
            return out;
        } finally { this.depth--; }
    }

    nav(items: Json[]): string {
        const li = (it: Json): string => {
            if (!isObj(it)) return '';
            const href = [it.Href, it.Url, it.href, it.url].find((x) => typeof x === 'string' && x) as string | undefined;
            const title = [it.NavigationTitle, it.Title].map((f) => (isObj(f) && typeof f.value === 'string' ? f.value.trim() : '')).find(Boolean)
                || (typeof it.DisplayName === 'string' ? it.DisplayName.trim() : '');
            const kids = (Array.isArray(it.Children) ? it.Children : Array.isArray(it.children) ? it.children : []) as Json[];
            if (!href || !title) return '';
            return `<li><a href="${esc(href)}">${esc(title)}</a>${kids.length ? `<ul>${kids.map(li).join('')}</ul>` : ''}</li>`;
        };
        return `<nav><ul>${items.map(li).join('')}</ul></nav>`;
    }

    rendering(r: Json, zone: string): string {
        if (!isObj(r)) return '';
        const name = typeof r.componentName === 'string' ? r.componentName : '';
        const f = r.fields;
        const navItems = /navigation/i.test(name) ? (Array.isArray(f) ? f : isObj(f) && Array.isArray(f.items) ? f.items : null) : null;
        let out = navItems ? this.nav(navItems) : this.fields(f, zone);
        if (isObj(r.placeholders)) out += this.placeholders(r.placeholders, zone);
        return out ? `<div data-sc-component="${esc(name)}">${out}</div>` : '';
    }

    /** Placeholders inside a rendering (a column splitter's columns): one run of elements. */
    placeholders(ph: Record<string, Json>, zone: string): string {
        return Object.values(ph).map((list) => (Array.isArray(list) ? list.map((r) => this.rendering(r, zone)).join('') : '')).join('');
    }

    /** The route's top placeholders, sorted into the page's header, main content and footer by name. */
    zones(ph: Record<string, Json>): { header: string; main: string; footer: string } {
        const out = { header: '', main: '', footer: '' };
        for (const [key, list] of Object.entries(ph)) {
            const z = /header|top|nav/i.test(key) ? 'header' : /footer|bottom/i.test(key) ? 'footer' : 'main';
            if (Array.isArray(list)) out[z] += list.map((r) => this.rendering(r, z)).join('');
        }
        return out;
    }
}

/** A page whose HTML is a shell (components drawn in the browser): its words from the layout JSON. */
function expandLayout($: cheerio.CheerioAPI): void {
    const body = $('body').length ? $('body').first() : null;
    if (!body) return;
    const visible = body.clone();
    visible.find('script, style, noscript, template').remove();
    if (words(visible.text()) >= THIN_WORDS) return;   // server-rendered: the HTML already has the words
    const layout = layoutOf($);
    const route = layout && isObj(layout.route) ? layout.route : null;
    if (!route || !isObj(route.placeholders)) return;
    const z = new LayoutWriter().zones(route.placeholders);
    if (!z.main && !z.header) return;
    $('main').filter((_, m) => !words($(m).text())).remove();
    body.append(`<header data-sc-layout="">${z.header}</header><main data-sc-layout="">${z.main}</main><footer data-sc-layout="">${z.footer}</footer>`);
}

export const adapter: BuilderAdapter = {
    key: 'sitecore',
    label: 'Sitecore',
    detect: (html, gen) =>
        gen.includes('sitecore')
        // Headless: the Layout Service's JSON in the page.
        || html.includes('"layoutData":{"sitecore"') || /id=["']__JSS_STATE__["']/.test(html) || /"sitecore":\{"context":\{/.test(html)
        // The media library, addressed on the site itself (a mention in text or a link to another site doesn't count).
        || /(?:=\s*["']|url\(\s*["']?|,\s*)\/[-~]\/(?:jss)?media\//i.test(html)
        || /\/\/edge\.sitecorecloud\.io\/[^"'\s]+\/media\/|\.sitecorecontenthub\.cloud\/api\//i.test(html)
        // Sitecore Forms, analytics, Experience Editor, Layout Service endpoints.
        || /\bdata-sc-fxb\b|\/layouts\/system\/VisitorIdentification|SC_ANALYTICS_GLOBAL_COOKIE|\bscWebEditInput\b|\/sitecore\/api\/(?:layout|graph|jss|ssc)\b/i.test(html)
        // SXA's component markup: div.component.<name> > div.component-content, with field-<name> classes.
        || (/class=["'][^"']*\bcomponent-content\b/.test(html) && /class=["'](?:[^"']*\s)?component\s/.test(html) && /class=["'][^"']*\bfield-[a-z]+/.test(html)),
    prepare($, url) {
        expandLayout($);
        $(FURNITURE).remove();
        // SXA navigation: the menu even where it isn't in <nav> or <header>; and "submenu" marks the
        // item that HAS a drop-down, not the drop-down — left on, it filed "Services" under "Home".
        $('.component.navigation').attr('role', 'navigation');
        $('.component.navigation li.submenu').removeClass('submenu');
        // Pictures at full size, logo included (the import reads the logo's src without asking the adapter).
        $('img').each((_, el) => {
            const $el = $(el);
            const cands = [$el.attr('srcset'), $el.attr('data-srcset')].flatMap((s) => (s ? s.split(',').map((p) => p.trim().split(/\s+/)[0]) : []));
            const raw = cands[cands.length - 1] ?? $el.attr('data-src') ?? $el.attr('src') ?? '';
            if (!raw) return;
            let abs: string;
            try { abs = new URL(raw, url ?? 'https://same.invalid/').toString(); } catch { return; }
            const big = fullSize(abs);
            if (!big) return;
            $el.attr('src', big.startsWith('https://same.invalid/') ? big.slice('https://same.invalid'.length) : big).removeAttr('srcset').removeAttr('data-srcset').removeAttr('data-src');
        });
    },
    // Our expanded layout when there is one; otherwise the import's own choice (<main>, then <body>).
    contentRoot: 'main[data-sc-layout]',
    noise: /^(skip to (main )?(content|navigation)|toggle navigation|got it,? thanks)$/i,
    fullSizeImage: fullSize,
    rendersWithJs: false,
};
