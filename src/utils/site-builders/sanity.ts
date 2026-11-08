// src/utils/site-builders/sanity.ts — Website import adapter for Sanity (headless CMS; the front end is
// the owner's own Next.js, Astro, Remix, SvelteKit or Gatsby site).
// Findings, what is covered and what is not: docs/site-import-platforms/sanity.md
// Tests: tests/site-platform-sanity.test.ts (fixtures in tests/fixtures/site-platforms/sanity/).
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Sanity's picture CDN, its API hosts, an image asset id, live-preview markup, Portable Text in page data. */
const DETECT = /cdn\.sanity\.io|\.api(?:cdn)?\.sanity\.io|image-[0-9a-f]{40}-\d+x\d+-[a-z]{3,4}\b|\sdata-sanity(?:-edit-target)?=|<sanity-visual-editing\b/i;
const PT_DATA = /\\?"markDefs\\?"\s*:/;

/**
 * Sanity's "stega" live-preview encoding: runs of invisible characters hidden inside every string. When a
 * site leaves it on, a heading carries dozens of them — never the owner's words. Single joiners (emoji,
 * Persian) are left alone: stega runs are long.
 */
const STEGA = /[​‌‍⁠-⁤﻿]{4,}/g;

/** Image hosts that wrap another address: Next.js, Vercel, Netlify, Astro, Nuxt (IPX), Cloudflare. */
function unwrapImage(src: string): string {
    try {
        const u = new URL(src);
        const inner = u.searchParams.get('url') ?? u.searchParams.get('href');
        // A relative inner address is the site's own picture: resolved against the site, never the CDN.
        if (inner && /^\/(?:_next\/image|_vercel\/image|\.netlify\/images|_image)\/?$/.test(u.pathname)) return new URL(inner, u).toString();
        const m = u.pathname.match(/^\/(?:cdn-cgi\/image|_ipx)\/[^/]+\/(https?:\/\/?.+)$/);
        if (m) return decodeURIComponent(m[1]).replace(/^(https?:)\/(?!\/)/, '$1//');
    } catch { /* not an address */ }
    return src;
}

/** Kept from a Sanity picture address: the editor's crop and turn. The rest only resizes it. */
const KEEP_PARAMS = ['rect', 'or', 'flip'];
const MAX_WIDTH = 1600;

function sanityFullSize(src: string): string | null {
    const raw = unwrapImage(src);
    let u: URL;
    try { u = new URL(raw, 'https://cdn.sanity.io'); } catch { return null; }
    if (u.hostname !== 'cdn.sanity.io') return raw === src ? null : raw;
    if (!u.pathname.startsWith('/images/')) return u.toString();
    const kept = new URLSearchParams();
    for (const k of KEEP_PARAMS) { const v = u.searchParams.get(k); if (v) kept.set(k, v); }
    // The original's width is in its name (…-4000x2667.jpg); a cropped one is the crop's width.
    const named = Number(u.pathname.match(/-(\d+)x\d+\.[a-z]+(?:\/|$)/i)?.[1] ?? 0);
    const rectW = Number((kept.get('rect') ?? '').split(',')[2] ?? 0);
    const width = rectW || named;
    if (!width || width > MAX_WIDTH) { kept.set('w', String(MAX_WIDTH)); kept.set('fit', 'max'); }
    const q = kept.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ''}`;
}

// ── Portable Text kept in the page's data (a page the browser draws) ─────────────────────────────

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: Json | undefined): string => (typeof v === 'string' ? v.replace(STEGA, '').trim() : '');

/** Site furniture and search settings, not the page's own words. */
const SKIP_KEYS = /^(seo|meta|metadata|openGraph|og|settings|siteSettings|navigation|nav|menu|menuItems|header|footer|social|socials|draftMode|preview|sourceMap|query|params|buildId|runtimeConfig|slug)$/i;
const SKIP_TYPES = /^(seo|slug|reference|sanity\.imageAsset|sanity\.fileAsset|settings|siteSettings|navigation|menu|footer|header)$/i;
const HEADING_KEYS = ['heading', 'headline', 'title'];
const TEXT_KEYS = ['subheading', 'subtitle', 'tagline', 'kicker', 'intro', 'summary', 'excerpt', 'description', 'text', 'caption'];
const LABEL_KEYS = ['label', 'text', 'title'];
const HREF_KEYS = ['href', 'url', 'link'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHref = (h: string) => (/^(https?:|mailto:|tel:|\/|#)/i.test(h) ? h : '');

interface Ctx { project: string | null; dataset: string | null; out: string[]; seen: Set<string> }

function imageSrc(o: Obj, ctx: Ctx): string {
    const asset = isObj(o.asset) ? o.asset : null;
    if (!asset) return '';
    const url = str(asset.url);
    if (/^https:\/\/cdn\.sanity\.io\//.test(url)) return url;
    const m = str(asset._ref || asset._id).match(/^image-([0-9a-f]+)-(\d+x\d+)-([a-z0-9]+)$/i);
    if (!m || !ctx.project || !ctx.dataset) return '';
    return `https://cdn.sanity.io/images/${ctx.project}/${ctx.dataset}/${m[1]}-${m[2]}.${m[3]}`;
}
const isImage = (o: Obj) => (o._type === 'image' || /image$/i.test(str(o._type))) && isObj(o.asset);
const isBlock = (v: Json): v is Obj => isObj(v) && v._type === 'block' && Array.isArray(v.children);
const isPortableText = (v: Json[]): boolean => v.some(isBlock);

function spans(b: Obj): string {
    const defs = new Map<string, string>();
    for (const d of Array.isArray(b.markDefs) ? b.markDefs : []) {
        if (isObj(d) && typeof d._key === 'string') { const h = safeHref(str(d.href)); if (h) defs.set(d._key, h); }
    }
    return (b.children as Json[]).map((c) => {
        if (!isObj(c)) return '';
        const text = esc(typeof c.text === 'string' ? c.text.replace(STEGA, '') : '');
        const link = (Array.isArray(c.marks) ? c.marks : []).map((m) => defs.get(String(m))).find(Boolean);
        return link && text.trim() ? `<a href="${esc(link)}">${text}</a>` : text;
    }).join('');
}

function renderPortableText(arr: Json[], ctx: Ctx): void {
    const sig = arr.map((b) => (isObj(b) ? str(b._key) : '')).join('|');
    if (sig && ctx.seen.has(sig)) return;   // the same field, sent twice (page data + RSC)
    if (sig) ctx.seen.add(sig);
    let list: string | null = null;
    const close = () => { if (list) { ctx.out.push(`</${list}>`); list = null; } };
    for (const b of arr) {
        if (isBlock(b)) {
            const inner = spans(b);
            if (!inner.replace(/<[^>]+>/g, '').trim()) continue;
            if (typeof b.listItem === 'string') {
                const tag = b.listItem === 'number' ? 'ol' : 'ul';
                if (list !== tag) { close(); ctx.out.push(`<${tag}>`); list = tag; }
                ctx.out.push(`<li>${inner}</li>`);
                continue;
            }
            close();
            const style = str(b.style);
            const tag = /^h[1-6]$/.test(style) ? style : style === 'blockquote' ? 'blockquote' : 'p';
            ctx.out.push(`<${tag}>${inner}</${tag}>`);
        } else if (isObj(b)) {
            close();
            walkData(b, ctx, 0);
        }
    }
    close();
}

function walkData(v: Json | undefined, ctx: Ctx, depth: number): void {
    if (depth > 24 || ctx.out.length > 400 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
        if (isPortableText(v)) { renderPortableText(v, ctx); return; }
        for (const x of v) walkData(x, ctx, depth + 1);
        return;
    }
    const type = str(v._type);
    if (type && SKIP_TYPES.test(type)) return;
    if (isImage(v)) {
        const src = imageSrc(v, ctx);
        if (src && !ctx.seen.has(src)) { ctx.seen.add(src); ctx.out.push(`<img src="${esc(src)}" alt="${esc(str(v.alt))}">`); }
        return;
    }
    // A link or button object: its label, standing alone.
    const href = HREF_KEYS.map((k) => str(v[k])).map(safeHref).find(Boolean);
    const label = LABEL_KEYS.map((k) => str(v[k])).find(Boolean);
    if (type && href && label && /link|button|cta/i.test(type)) { ctx.out.push(`<a href="${esc(href)}">${esc(label)}</a>`); return; }
    // A content section (an object Sanity typed): its heading and plain-text fields, then the rest in order.
    if (type) {
        const heading = HEADING_KEYS.map((k) => str(v[k])).find(Boolean);
        // A page document's title is its menu name ("Home"), not a heading on it; a post's title is its headline.
        if (heading && type !== 'page') ctx.out.push(/post|article/i.test(type) ? `<h1>${esc(heading)}</h1>` : `<h2>${esc(heading)}</h2>`);
        for (const k of TEXT_KEYS) { const t = str(v[k]); if (t && /\s/.test(t)) ctx.out.push(`<p>${esc(t)}</p>`); }
    }
    for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('_') || SKIP_KEYS.test(k) || (type && (HEADING_KEYS.includes(k) || TEXT_KEYS.includes(k)))) continue;
        walkData(x, ctx, depth + 1);
    }
}

/** Every JSON blob a Sanity front end leaves in the page: Next.js (both routers) and Remix. */
function pageData($: cheerio.CheerioAPI): Json[] {
    const found: Json[] = [];
    const parse = (s: string) => { try { found.push(JSON.parse(s) as Json); } catch { /* not JSON */ } };
    const nd = $('script#__NEXT_DATA__').first().text();
    if (nd) {
        try { const d = JSON.parse(nd) as Obj; found.push(isObj(d.props) && isObj(d.props.pageProps) ? d.props.pageProps : null); } catch { /* broken */ }
    }
    let flight = '';
    $('script:not([src])').each((_, el) => {
        const s = $(el).text();
        for (const m of s.matchAll(/self\.__next_f\.push\((\[1,\s*"(?:[^"\\]|\\.)*"\])\)/g)) {
            try { flight += (JSON.parse(m[1]) as [number, string])[1]; } catch { /* broken */ }
        }
        const remix = s.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\});\s*(?:__remixContext|$)/);
        if (remix) { try { const r = JSON.parse(remix[1]) as Obj; found.push(isObj(r.state) ? r.state.loaderData ?? null : null); } catch { /* broken */ } }
    });
    // RSC rows: "5:[…]" or "5:{…}" (text rows "5:T…" and module rows "1:I[…]" are not data).
    for (const line of flight.split('\n')) { const m = line.match(/^[0-9a-f]+:([[{].*)$/); if (m) parse(m[1]); }
    return found;
}

/** Words on the page a visitor sees without JavaScript. */
function visibleWords($: cheerio.CheerioAPI): number {
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg').remove();
    return body.text().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

function expandPageData($: cheerio.CheerioAPI, html: string): void {
    if (!PT_DATA.test(html) || visibleWords($) >= 40) return;   // a page the server drew already has its words
    const asset = html.replace(/%2F/gi, '/').match(/cdn\.sanity\.io\/images\/([a-z0-9]+)\/([\w-]+)\//i);
    const ctx: Ctx = {
        project: asset?.[1] ?? html.match(/\\?"projectId\\?"\s*:\s*\\?"([a-z0-9]{4,})\\?"/i)?.[1] ?? null,
        dataset: asset?.[2] ?? html.match(/\\?"dataset\\?"\s*:\s*\\?"([\w-]{1,64})\\?"/)?.[1] ?? null,
        out: [], seen: new Set(),
    };
    for (const d of pageData($)) walkData(d, ctx, 0);
    if (!ctx.out.length) return;
    const box = `<div data-sanity-page-data>${ctx.out.join('')}</div>`;
    const main = $('main').first();
    if (main.length) { main.find('p').filter((_, p) => /^loading\W*$/i.test($(p).text().trim())).remove(); main.append(box); }
    else $('body').append(`<main>${box}</main>`);
}

export const adapter: BuilderAdapter = {
    key: 'sanity',
    label: 'Sanity',
    detect: (html) => DETECT.test(html) || (PT_DATA.test(html) && /\\?"_type\\?"\s*:\s*\\?"block\\?"/.test(html)),
    prepare($) {
        const html = $.html();
        // Live-preview furniture, and Portable Text's "Unknown block type …" warnings (hidden, but text).
        $('sanity-visual-editing, [data-sanity-overlay]').remove();
        $('div[style*="display:none" i], div[style*="display: none" i]').filter((_, el) => /^Unknown (block|mark|list|list item|block style) /.test($(el).text().trim())).remove();
        // Stega characters hidden in the words and descriptions.
        $('body *').contents().each((_, n) => {
            if (n.type === 'text' && STEGA.test(n.data)) n.data = n.data.replace(STEGA, '');
            STEGA.lastIndex = 0;
        });
        $('[alt], [title], [aria-label]').each((_, el) => {
            for (const a of ['alt', 'title', 'aria-label']) { const v = $(el).attr(a); if (v && v.replace(STEGA, '') !== v) $(el).attr(a, v.replace(STEGA, '')); }
        });
        expandPageData($, html);
    },
    noise: /^(unknown (block|mark|list|list item|block style) (type|style)? ?".*" ?, specify a component for it.*|loading…?|loading\.\.\.|(exit|disable|leave) (draft|preview) mode|preview mode|draft mode( is)? (on|enabled)|you are viewing (a )?draft.*|open in studio|edit in (sanity )?studio)$/i,
    fullSizeImage: sanityFullSize,
    rendersWithJs: false,
};

/** For the tests. */
export const __test = { unwrapImage, sanityFullSize, STEGA };
