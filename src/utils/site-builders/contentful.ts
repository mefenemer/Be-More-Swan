// src/utils/site-builders/contentful.ts — Website import adapter for Contentful.
// Findings, what is covered and what is not: docs/site-import-platforms/contentful.md
// Tests: tests/site-platform-contentful.test.ts (fixtures in tests/fixtures/site-platforms/contentful/).
//
// Contentful is a headless CMS: the front end is the owner's (usually Next.js, Gatsby or Nuxt), so there
// is no Contentful markup as such. What gives it away is where the pictures and data come from:
// images.ctfassets.net picture addresses (often wrapped in Next's /_next/image), Contentful's API
// hosts, and its JSON shapes — {"sys":{"type":"Entry"…}} and rich text {"nodeType":"document"…} —
// inside __NEXT_DATA__ or the App Router's self.__next_f payload.
//
// Most such sites are server-rendered, so the page reads as it is. The adapter adds two things:
//   • fullSizeImage: unwraps /_next/image (and Vercel/Netlify/Nuxt IPX wrappers) and asks the Contentful
//     Images API for a sensible size of the original instead of a thumbnail or a webp sliver;
//   • prepare: when the page shows almost no words (a client-only page whose body is drawn in the
//     browser), it lays out the owner's own Contentful entries that the page already carries in its
//     data script — rich text, headlines, their pictures — as ordinary elements, so the import needs no
//     headless browser. Only words from the page's own data; nothing fetched, nothing written.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** images.ctfassets.net, and its data-residency twins (images.eu.ctfassets.net). */
const IMAGES_HOST = /^images(?:\.[a-z]{2})?\.ctfassets\.net$/i;
const CTF_HOST = /(?:^|\.)ctfassets\.net$/i;
/** Contentful API shapes as they appear in page data, raw or JSON-escaped inside the RSC payload. */
const Q = '\\\\?"';
const CTF_JSON = new RegExp(`${Q}linkType${Q}\\s*:\\s*${Q}(?:Space|ContentType|Environment)${Q}`);
const CTF_HOSTS = /ctfassets\.net|(?:cdn|preview|graphql)\.(?:eu\.)?contentful\.com/;

/** Pictures the Images API can resize as they are; anything else (HEIC, TIFF, AVIF) is asked for as JPEG. */
const RESIZABLE = /\.(jpe?g|png|webp)$/i;
/** The long side asked for: big enough for a full-width hero, small enough for the 8 MB picture cap. */
const WIDTH = 1600;

function ctfImage(u: URL): string {
    const out = new URL(u.pathname, `https://${u.hostname}`);
    if (/\.gif$/i.test(u.pathname)) return out.toString();   // an animated GIF stays as it was made
    out.searchParams.set('w', String(WIDTH));
    out.searchParams.set('q', '85');
    if (!RESIZABLE.test(u.pathname)) out.searchParams.set('fm', 'jpg');
    return out.toString();
}

/** Image-proxy wrappers front ends put round the real picture address. */
function unwrap(u: URL): string | null {
    if (/^\/(?:_next|_vercel)\/image\/?$|^\/\.netlify\/images\/?$/.test(u.pathname)) return u.searchParams.get('url');
    // Nuxt Image (IPX): /_ipx/w_800&f_webp/https://images.ctfassets.net/… (the // is sometimes collapsed).
    const ipx = u.pathname.match(/^\/_ipx\/[^/]+\/(https?:\/\/?.+)$/);
    if (ipx) return decodeURIComponent(ipx[1]).replace(/^(https?:)\/(?!\/)/, '$1//') + u.search;
    return null;
}

function fullSizeImage(src: string, depth = 0): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    const inner = depth < 2 ? unwrap(u) : null;
    if (inner) {
        let abs: string;
        try { abs = new URL(inner.startsWith('//') ? `https:${inner}` : inner, u).toString(); } catch { return null; }
        if (!/^https?:/.test(abs)) return null;
        return fullSizeImage(abs, depth + 1) ?? abs;
    }
    if (IMAGES_HOST.test(u.hostname)) return ctfImage(u);
    if (CTF_HOST.test(u.hostname)) return `https://${u.hostname}${u.pathname}`;   // downloads./assets.: the file itself
    return null;
}

// ── Laying out entries a client-only page carries in its data ─────────────────────────────────────

/** Entries that are site furniture or search settings, never the page's words. */
const SKIP_TYPE = /nav|menu|header|footer|seo|metadata|meta[A-Z_-]|^meta$|setting|config|redirect|cookie|consent|translation|label(s|Group)?$/i;
/** Fields that are the CMS's own (internal names, addresses, ids) — never shown to visitors. */
const SKIP_FIELD = /^(sys|__typename|internalName|internalTitle|entryTitle|slug|id|key|url|href|link|uri|path|metadata|seo.*|meta.*|contentType|locale|theme|variant|style|layout|className|colou?r|icon|anchor|order|position|alignment|type)$/i;
const HEADLINE_FIELD = /^(headline|heading|title|name|header|pageTitle|heroTitle|sectionTitle)$/i;
const SUBHEAD_FIELD = /^(subheadline|subheading|subtitle|subTitle|tagline|eyebrow|kicker)$/i;
const TEXT_FIELD = /^(intro|introduction|summary|description|excerpt|lead|leadText|text|body|bodyText|copy|content|caption|quote|paragraph|blurb|answer|question)$/i;
const LABEL_FIELD = /^(label|buttonText|buttonLabel|ctaText|ctaLabel|linkText|linkLabel)$/i;
const TARGET_FIELD = /^(url|href|link|externalUrl|target|ctaUrl|buttonUrl|linkUrl|slug)$/i;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Links a visitor can follow: web pages, the site's own pages, email and phone. */
function safeHref(h: unknown): string | null {
    if (typeof h !== 'string') return null;
    const t = h.trim();
    if (/^(https?:|mailto:|tel:)/i.test(t) || /^\/(?!\/)/.test(t)) return t;
    if (/^[a-z0-9][\w-]*(\/[\w-]*)*$/i.test(t)) return `/${t}`;   // a bare slug: one of their pages
    return null;
}

interface Ctx {
    out: string[];
    seen: Set<string>;
    budget: number;
    /** GraphQL rich text keeps embedded pictures and entries beside the document, by id. */
    linked: Map<string, Obj>;
    h1: boolean;
}

function emit(ctx: Ctx, html: string, key?: string): void {
    if (ctx.budget <= 0) return;
    if (key !== undefined) {
        const k = key.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!k || ctx.seen.has(k)) return;
        ctx.seen.add(k);
    }
    ctx.budget--;
    ctx.out.push(html);
}

const typeOf = (o: Obj): string => {
    const sys = isObj(o.sys) ? o.sys : null;
    const ct = sys && isObj(sys.contentType) && isObj(sys.contentType.sys) ? sys.contentType.sys.id : null;
    return String(ct ?? o.__typename ?? '');
};
const isDoc = (v: Json | undefined): v is Obj => isObj(v) && v.nodeType === 'document' && Array.isArray(v.content);

/** A picture object: a REST Asset (fields.file.url) or a GraphQL Asset ({url, title, description}). */
function asset(o: Obj): { src: string; alt: string; width?: number; height?: number } | null {
    const f = isObj(o.fields) ? o.fields : o;
    const file = isObj(f.file) ? f.file : null;
    const raw = typeof file?.url === 'string' ? file.url : typeof f.url === 'string' ? f.url : null;
    if (!raw || !/ctfassets\.net\//.test(raw)) return null;
    const type = String(file?.contentType ?? f.contentType ?? '');
    if (type && !type.startsWith('image/')) return null;
    if (/\.(svg|pdf|mp4|mov|webm)(\?|$)/i.test(raw)) return null;
    const src = raw.startsWith('//') ? `https:${raw}` : raw;
    const alt = [f.description, f.title].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
    const img = isObj(file?.details) && isObj(file.details.image) ? file.details.image : f;
    const width = typeof img.width === 'number' ? img.width : undefined;
    const height = typeof img.height === 'number' ? img.height : undefined;
    return { src, alt: alt?.trim() ?? '', width, height };
}

function emitAsset(ctx: Ctx, o: Obj): boolean {
    const a = asset(o);
    if (!a) return false;
    const size = a.width && a.height ? ` width="${a.width}" height="${a.height}"` : '';
    emit(ctx, `<img src="${esc(a.src)}" alt="${esc(a.alt)}"${size}>`, `img:${a.src}`);
    return true;
}

/** Contentful rich text → the plain HTML its own renderer would draw. */
function rich(node: Json, ctx: Ctx, depth = 0): string {
    if (!isObj(node) || depth > 30) return '';
    const kids = () => (Array.isArray(node.content) ? node.content.map((c) => rich(c, ctx, depth + 1)).join('') : '');
    const t = String(node.nodeType ?? '');
    const target = isObj(node.data) && isObj(node.data.target) ? node.data.target : null;
    const resolved = (): Obj | null => {
        if (!target) return null;
        if (isObj(target.fields) || typeof target.url === 'string') return target;
        const id = isObj(target.sys) ? String(target.sys.id ?? '') : '';
        return ctx.linked.get(id) ?? null;
    };
    switch (t) {
        case 'text': return typeof node.value === 'string' ? esc(node.value) : '';
        case 'paragraph': return `<p>${kids()}</p>`;
        case 'blockquote': return `<blockquote>${kids()}</blockquote>`;
        case 'unordered-list': return `<ul>${kids()}</ul>`;
        case 'ordered-list': return `<ol>${kids()}</ol>`;
        case 'list-item': return `<li>${kids()}</li>`;
        case 'table': return `<table>${kids()}</table>`;
        case 'table-row': return `<tr>${kids()}</tr>`;
        case 'table-cell': return `<td>${kids()}</td>`;
        case 'table-header-cell': return `<th>${kids()}</th>`;
        case 'hr': return '';
        case 'hyperlink': {
            const href = safeHref(isObj(node.data) ? node.data.uri : null);
            return href ? `<a href="${esc(href)}">${kids()}</a>` : kids();
        }
        case 'embedded-asset-block': {
            const r = resolved();
            const a = r ? asset(r) : null;
            return a ? `<img src="${esc(a.src)}" alt="${esc(a.alt)}">` : '';
        }
        case 'embedded-entry-block': case 'embedded-entry-inline': {
            const r = resolved();
            if (!r) return '';
            const sub: Ctx = { ...ctx, out: [] };
            entry(r, sub, depth + 1);
            ctx.budget = sub.budget;
            return sub.out.join('');
        }
        default:
            if (/^heading-[1-6]$/.test(t)) return `<h${t.slice(-1)}>${kids()}</h${t.slice(-1)}>`;
            return kids();   // entry-/asset-/resource-hyperlink, unknown nodes: their words only
    }
}

function document(doc: Obj, links: Json | undefined, ctx: Ctx): void {
    // GraphQL: links.assets.block / links.entries.block|inline hold what the document points at, by id.
    if (isObj(links)) for (const group of Object.values(links)) {
        if (!isObj(group)) continue;
        for (const list of Object.values(group)) if (Array.isArray(list)) for (const it of list) {
            if (isObj(it) && isObj(it.sys) && typeof it.sys.id === 'string') ctx.linked.set(it.sys.id, it);
        }
    }
    const html = rich(doc, ctx);
    if (html) emit(ctx, html);
}

/** One entry's fields in their order: headings, text, a button, pictures, then what it contains. */
function entry(o: Obj, ctx: Ctx, depth: number): void {
    if (depth > 25 || ctx.budget <= 0) return;
    if (SKIP_TYPE.test(typeOf(o))) return;
    if (emitAsset(ctx, o)) return;
    const f = isObj(o.fields) ? o.fields : o;
    const label = Object.keys(f).find((k) => LABEL_FIELD.test(k) && typeof f[k] === 'string');
    const target = Object.keys(f).find((k) => TARGET_FIELD.test(k) && typeof f[k] === 'string' && safeHref(f[k]));
    if (label && target) {
        const text = String(f[label]).trim();
        if (text && text.length <= 40) emit(ctx, `<p><a href="${esc(safeHref(f[target])!)}">${esc(text)}</a></p>`, `a:${text}`);
    }
    for (const [k, v] of Object.entries(f)) {
        if (k === label) continue;
        if (typeof v === 'string') {
            const s = v.trim();
            if (!s || SKIP_FIELD.test(k) || /^https?:|^\/\//.test(s)) continue;
            if (HEADLINE_FIELD.test(k) && s.length <= 160) {
                const level = ctx.h1 ? 2 : 1;
                ctx.h1 = true;
                emit(ctx, `<h${level}>${esc(s)}</h${level}>`, s);
            } else if (SUBHEAD_FIELD.test(k) || TEXT_FIELD.test(k)) emit(ctx, `<p>${esc(s)}</p>`, s);
            continue;
        }
        if (SKIP_FIELD.test(k) && !/^(link|content|body)$/i.test(k)) continue;
        if (isDoc(v)) { document(v, undefined, ctx); continue; }
        if (isObj(v) && isDoc(v.json)) { document(v.json, v.links, ctx); continue; }
        walk(v, ctx, depth + 1);
    }
}

/** Anywhere in the page data: rich text documents, and entries (things with sys or __typename). */
function walk(v: Json, ctx: Ctx, depth = 0): void {
    if (depth > 30 || ctx.budget <= 0 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, ctx, depth + 1); return; }
    if (isDoc(v)) { document(v, undefined, ctx); return; }
    if (isDoc(v.json)) { document(v.json, v.links, ctx); return; }
    if (isObj(v.sys) || typeof v.__typename === 'string') { entry(v, ctx, depth + 1); return; }
    for (const x of Object.values(v)) walk(x, ctx, depth + 1);
}

/** The page's data scripts, parsed: Next's __NEXT_DATA__ props and the App Router's RSC rows. */
function pageData($: cheerio.CheerioAPI): Json[] {
    const roots: Json[] = [];
    const next = $('script#__NEXT_DATA__').first().text();
    if (next && next.length < 4_000_000) {
        try { const d = JSON.parse(next) as Obj; roots.push(isObj(d.props) ? d.props : d); } catch { /* not JSON */ }
    }
    let rsc = '';
    $('script').each((_, el) => {
        const s = $(el).text();
        if (!s.includes('__next_f')) return;
        for (const m of s.matchAll(/__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
            try { rsc += JSON.parse(m[1]) as string; } catch { /* broken chunk */ }
        }
    });
    if (rsc.length < 4_000_000) for (const line of rsc.split('\n')) {
        const m = line.match(/^[0-9a-z]+:([[{].*)$/);
        if (!m) continue;
        try { roots.push(JSON.parse(m[1]) as Json); } catch { /* a row split across chunks, or not JSON */ }
    }
    return roots;
}

/** Words a visitor sees without scripts (menus, header and footer aside). */
function visibleWords($: cheerio.CheerioAPI): number {
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg, nav, header, footer, [role="navigation"]').remove();
    return body.text().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}
/** Under this the import would open the page in headless Chrome (site-import.ts IMPORT_THIN_WORDS). */
const THIN = 40;

function prepare($: cheerio.CheerioAPI): void {
    if (visibleWords($) >= THIN) return;   // server-rendered: the page already shows its words
    const ctx: Ctx = { out: [], seen: new Set(), budget: 400, linked: new Map(), h1: $('h1').length > 0 };
    for (const r of pageData($)) walk(r, ctx);
    if (!ctx.out.length) return;
    const main = $('main').first();
    (main.length ? main : $('body')).append(`<div data-contentful-entries="">${ctx.out.join('\n')}</div>`);
}

export const adapter: BuilderAdapter = {
    key: 'contentful',
    label: 'Contentful',
    detect: (html) => CTF_HOSTS.test(html) || CTF_JSON.test(html),
    prepare: ($) => prepare($),
    fullSizeImage: (src) => fullSizeImage(src),
    noise: /^powered by contentful$/i,
};

/** For the tests: the pieces, without a page. */
export const _test = { fullSizeImage, visibleWords, pageData };
