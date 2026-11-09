// src/utils/site-builders/strapi.ts — Website import adapter for Strapi (self-hosted or Strapi Cloud).
// Findings, what is covered and what is not: docs/site-import-platforms/strapi.md
// Tests: tests/site-platform-strapi.test.ts (fixtures in tests/fixtures/site-platforms/strapi/).
//
// Strapi is a headless CMS: it never draws the page. The front end (usually Next.js, Nuxt or Gatsby)
// does, so there is no generator tag and no Strapi markup. What gives it away is the media library:
//   · Strapi Cloud serves pictures from <project>.media.strapiapp.com;
//   · every upload gets a 10-hex-digit hash suffix and resized copies prefixed thumbnail_/small_/
//     medium_/large_ (…/uploads/medium_shop_counter_0f9e8d7c6b.jpg);
//   · the page's data (__NEXT_DATA__, the App Router's self.__next_f payload, __NUXT_DATA__) carries
//     Strapi's media objects, with field names no other CMS uses together: alternativeText and
//     provider_metadata.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/**
 * A Strapi media-library file name: a format prefix, the name, a 10-hex hash, an extension. The hash must
 * hold a letter: ten digits is more often a date or timestamp (photo_2024031512.jpg) than a Strapi hash.
 */
const FORMAT_FILE = /^(thumbnail|small|medium|large)_(.+_(?=\d*[a-f])[0-9a-f]{10}\.(?:jpe?g|png|webp|gif|avif))$/i;
const HOSTED_MEDIA = /[a-z0-9-]+\.(?:media\.)?strapiapp\.com/i;
/** A resized upload named in the page (also inside an encoded /_next/image?url=…%2F address). */
const FORMAT_IN_PAGE = /(?:\/|%2F)(?:thumbnail|small|medium|large)_[\w.-]+?_(?=\d*[a-f])[0-9a-f]{10}\.(?:jpe?g|png|webp|gif|avif)\b/i;
/** Strapi's media object in the page's data, plain or with its quotes escaped inside a script string. */
const MEDIA_FIELDS = /\\*"alternativeText\\*"\s*:/;
const PROVIDER_FIELD = /\\*"provider_metadata\\*"\s*:/;

/**
 * The import's picture limit is 8 MB (site-import-store.ts PICTURE_MAX_BYTES): a full-size upload
 * larger than this is never copied, so the largest resized copy under it is used instead.
 */
const MAX_PICTURE_BYTES = 7.5 * 1024 * 1024;

interface MediaFile { url: string; bytes: number | null; width: number | null; }
interface Media { alt: string | null; original: MediaFile; formats: MediaFile[]; }

/**
 * Best picture per file name, found in the page's data by prepare() and read by fullSizeImage().
 * readImportPage runs prepare then reads every picture in one synchronous call, so this always
 * belongs to the page being read; keys are hashed file names, so a leftover can't mislead another page.
 */
let bestByFile = new Map<string, string>();
/** The Strapi server's address when the page names one (https://cms.example.com), for /uploads/… met relative. */
let cmsHost: string | null = null;

const fileOf = (u: string): string => { try { return decodeURIComponent(new URL(u, 'https://x.invalid').pathname.split('/').pop() ?? ''); } catch { return ''; } };

function asFile(o: unknown): MediaFile | null {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    if (typeof r.url !== 'string' || !r.url) return null;
    const bytes = typeof r.sizeInBytes === 'number' ? r.sizeInBytes : typeof r.size === 'number' ? r.size * 1000 : null;   // Strapi's size is kB
    return { url: r.url, bytes, width: typeof r.width === 'number' ? r.width : null };
}

/** A Strapi media object ({ url, alternativeText, formats: { large: {…}, … }, mime }), or null. */
function asMedia(o: unknown): Media | null {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    if (!('alternativeText' in r) || typeof r.url !== 'string' || !/^image\//.test(String(r.mime ?? 'image/'))) return null;
    const original = asFile(r);
    if (!original) return null;
    const formats: MediaFile[] = [];
    if (r.formats && typeof r.formats === 'object') for (const v of Object.values(r.formats as Record<string, unknown>)) { const f = asFile(v); if (f) formats.push(f); }
    return { alt: typeof r.alternativeText === 'string' && r.alternativeText.trim() ? r.alternativeText.trim() : null, original, formats };
}

/** The address to copy: the upload itself unless it is too big for the import, then the largest copy that fits. */
function bestOf(m: Media): string {
    if (m.original.bytes === null || m.original.bytes <= MAX_PICTURE_BYTES) return m.original.url;
    const fits = m.formats.filter((f) => f.bytes !== null && f.bytes <= MAX_PICTURE_BYTES).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return fits[0]?.url ?? m.original.url;
}

function walkJson(o: unknown, fn: (v: unknown) => void, depth = 0): void {
    if (depth > 40 || !o || typeof o !== 'object') return;
    fn(o);
    for (const v of Array.isArray(o) ? o : Object.values(o as Record<string, unknown>)) walkJson(v, fn, depth + 1);
}

/** The text of one JSON object starting at `from` (a '{'), string-aware; null when unbalanced. */
function objectAt(text: string, from: number): string | null {
    let depth = 0, inStr = false;
    for (let i = from; i < text.length && i - from < 20000; i++) {
        const c = text[i];
        if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
    }
    return null;
}

/**
 * Media objects inside the App Router's payload (self.__next_f.push([1,"…"])): its rows are not one
 * JSON document, so each media object is cut out around its "alternativeText" field and parsed alone.
 */
function mediaInFlight($: cheerio.CheerioAPI): Media[] {
    let text = '';
    $('script:not([src])').each((_, el) => {
        const s = $(el).text();
        if (!s.includes('self.__next_f')) return;
        for (const m of s.matchAll(/self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
            try { text += JSON.parse(m[1]) as string; } catch { /* a broken row is skipped */ }
        }
    });
    const out: Media[] = [];
    for (let at = text.indexOf('"alternativeText"'); at !== -1 && out.length < 200; at = text.indexOf('"alternativeText"', at + 1)) {
        // Back to the brace that opens this object (media objects hold no braces in their strings before it).
        let depth = 0, start = -1;
        for (let i = at; i >= 0 && at - i < 4000; i--) {
            if (text[i] === '}') depth++;
            else if (text[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
        }
        const json = start >= 0 ? objectAt(text, start) : null;
        if (!json) continue;
        try { const m = asMedia(JSON.parse(json)); if (m) out.push(m); } catch { /* not an object after all */ }
    }
    return out;
}

function nextData($: cheerio.CheerioAPI): unknown {
    try { return JSON.parse($('script#__NEXT_DATA__').first().text() || 'null'); } catch { return null; }
}

// ── Words kept only in the page's data (a page drawn in the browser) ─────────────────────────────

/** Branches of the page's data that are not the page's own words. */
const NOT_CONTENT = /^(seo|meta|metadata|localizations|createdBy|updatedBy|global|navbar|navigation|nav|header|footer|menu|menus|layout|settings|i18n|messages|translations)$/i;
const HEADING_KEY = /^(title|heading|headline)$/i;
const SUBHEADING_KEY = /^(subtitle|subheading|tagline|kicker)$/i;
const RICH_KEY = /^(content|body|text|richText|rich_text|description|intro|summary|copy|paragraph)$/i;
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'list', 'quote', 'code', 'image']);

const isBlocks = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) && v.length > 0 && v.every((b) => b && typeof b === 'object' && BLOCK_TYPES.has(String((b as Record<string, unknown>).type)) && (Array.isArray((b as Record<string, unknown>).children) || (b as Record<string, unknown>).type === 'image'));

const safeHref = (h: unknown): string | null => (typeof h === 'string' && /^(https?:|mailto:|tel:|\/(?!\/)|#)/i.test(h.trim()) ? h.trim() : null);

/** Builds the page's words as ordinary elements; text always goes in through .text(), never as markup. */
class Builder {
    count = 0;
    constructor(private $: cheerio.CheerioAPI, private out: cheerio.Cheerio<any>, private cms: string | null) {}
    private add(tag: string): cheerio.Cheerio<any> | null {
        if (this.count >= 160) return null;
        this.count++;
        const el = this.$(`<${tag}></${tag}>`);
        this.out.append(el);
        return el;
    }
    heading(level: number, text: string): void { const t = text.trim(); if (t) this.add(`h${Math.min(6, Math.max(1, level))}`)?.text(t); }
    image(m: Media): void {
        let src = bestOf(m);
        if (!/^https?:/i.test(src)) { if (!this.cms) return; src = new URL(src, this.cms).toString(); }
        const img = this.add('img');
        img?.attr('src', src);
        if (m.alt) img?.attr('alt', m.alt);
    }
    button(text: string, href: string): void { this.add('a')?.attr('href', href).text(text.trim()); }
    /** Strapi 5's Blocks editor JSON. */
    blocks(list: Array<Record<string, unknown>>): void {
        for (const b of list) {
            const type = String(b.type);
            if (type === 'heading') this.heading(Number(b.level) || 2, this.plain(b.children));
            else if (type === 'paragraph' || type === 'code') { const p = this.add('p'); if (p) this.inline(p, b.children); }
            else if (type === 'quote') { const q = this.add('blockquote'); if (q) this.inline(q, b.children); }
            else if (type === 'list') {
                const ul = this.add(b.format === 'ordered' ? 'ol' : 'ul');
                for (const li of Array.isArray(b.children) ? b.children : []) { if (!ul) break; const el = this.$('<li></li>'); this.inline(el, (li as Record<string, unknown>).children); ul.append(el); }
            } else if (type === 'image') { const m = asMedia(b.image); if (m) this.image(m); }
        }
    }
    private plain(children: unknown): string {
        return (Array.isArray(children) ? children : []).map((c) => { const r = c as Record<string, unknown>; return typeof r.text === 'string' ? r.text : this.plain(r.children); }).join('');
    }
    private inline(el: cheerio.Cheerio<any>, children: unknown): void {
        for (const c of Array.isArray(children) ? children : []) {
            const r = c as Record<string, unknown>;
            if (r.type === 'link') {
                const href = safeHref(r.url);
                const text = this.plain(r.children);
                if (href) el.append(this.$('<a></a>').attr('href', href).text(text)); else el.append(this.$('<span></span>').text(text));
            } else if (r.type === 'list-item' || Array.isArray(r.children)) this.inline(el, r.children);
            else if (typeof r.text === 'string') el.append(this.$('<span></span>').text(r.text));
        }
    }
    /** Strapi 4's Markdown rich text (or older HTML rich text, read as text only). */
    markdown(src: string): void {
        if (/^\s*<[a-z][\s\S]*>\s*$/i.test(src)) { const p = this.add('div'); p?.text(this.$('<div></div>').html(src).text()); return; }
        for (const para of src.replace(/\r/g, '').split(/\n{2,}/)) {
            const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
            if (!lines.length) continue;
            const h = lines[0].match(/^(#{1,6})\s+(.+)$/);
            if (h && lines.length === 1) { this.heading(h[1].length, this.mdText(h[2])); continue; }
            if (lines.every((l) => /^([-*+]|\d+[.)])\s+/.test(l))) {
                const ul = this.add(/^\d/.test(lines[0]) ? 'ol' : 'ul');
                for (const l of lines) { if (!ul) break; const li = this.$('<li></li>'); this.mdInline(li, l.replace(/^([-*+]|\d+[.)])\s+/, '')); ul.append(li); }
                continue;
            }
            if (lines.every((l) => l.startsWith('>'))) { const q = this.add('blockquote'); if (q) this.mdInline(q, lines.map((l) => l.replace(/^>\s?/, '')).join(' ')); continue; }
            const p = this.add('p');
            if (p) this.mdInline(p, lines.join(' '));
        }
    }
    private mdText(s: string): string { return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, '$2').trim(); }
    private mdInline(el: cheerio.Cheerio<any>, s: string): void {
        const re = /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
        let last = 0;
        for (const m of s.matchAll(re)) {
            if (m.index! > last) el.append(this.$('<span></span>').text(this.mdText(s.slice(last, m.index)) + (/\s$/.test(s.slice(last, m.index)) ? ' ' : '')));
            const href = safeHref(m[2]);
            el.append(href ? this.$('<a></a>').attr('href', href).text(this.mdText(m[1])) : this.$('<span></span>').text(this.mdText(m[1])));
            last = m.index! + m[0].length;
        }
        if (last < s.length) el.append(this.$('<span></span>').text((/^\s/.test(s.slice(last)) ? ' ' : '') + this.mdText(s.slice(last))));
    }
    /** One branch of the page's data, in its own order. */
    walk(o: unknown, depth = 0): void {
        if (depth > 25 || !o || typeof o !== 'object' || this.count >= 160) return;
        if (Array.isArray(o)) { if (isBlocks(o)) this.blocks(o); else for (const v of o) this.walk(v, depth + 1); return; }
        const m = asMedia(o);
        if (m) { this.image(m); return; }
        const r = o as Record<string, unknown>;
        // A link component: { text|label, url|href } — a button.
        const label = typeof r.text === 'string' ? r.text : typeof r.label === 'string' ? r.label : null;
        const href = safeHref(r.url ?? r.href ?? r.link);
        if (label && href && label.length <= 40 && Object.keys(r).filter((k) => typeof r[k] === 'string').length <= 6) { this.button(label, href); return; }
        const inComponent = typeof r.__component === 'string';
        for (const [k, v] of Object.entries(r)) {
            if (NOT_CONTENT.test(k) || k === '__component') continue;
            if (typeof v === 'string') {
                // Only a component's or the page's own fields: ids, slugs and dates are strings too.
                if (!inComponent && depth > 3) continue;
                if (HEADING_KEY.test(k) && v.length <= 160) this.heading(inComponent ? 2 : 1, v);
                else if (SUBHEADING_KEY.test(k) && v.length <= 300) { const p = this.add('p'); p?.text(v.trim()); }
                else if (RICH_KEY.test(k) && /\s/.test(v.trim())) this.markdown(v);
            } else this.walk(v, depth + 1);
        }
    }
}

const wordsIn = ($: cheerio.CheerioAPI): number => {
    const body = $('body').clone();
    body.find('script, style, noscript, template, nav, header, footer').remove();
    return body.text().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
};

/** Where relative media addresses (/uploads/…) live: the first absolute Strapi upload address in the page. */
function cmsOrigin(html: string): string | null {
    const m = html.match(/https?:\/\/[a-z0-9.-]+(?::\d+)?(?=\/uploads\/)/i) ?? html.match(/https?:\/\/[a-z0-9-]+\.media\.strapiapp\.com/i);
    return m ? m[0] : null;
}

// ── Resized pictures ─────────────────────────────────────────────────────────────────────────────

/** The picture inside a front end's image resizer: Next.js /_next/image?url=…, Nuxt Image /_ipx/<size>/…. */
function unwrapResizer(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    if (u.pathname.endsWith('/_next/image')) {
        const inner = u.searchParams.get('url');
        if (!inner) return null;
        try { const v = new URL(inner, u.origin); return /^https?:$/.test(v.protocol) ? v.toString() : null; } catch { return null; }
    }
    const ipx = u.pathname.match(/^\/_ipx\/[^/]+\/(.+)$/);
    if (ipx) {
        const rest = decodeURIComponent(ipx[1]);
        const abs = rest.match(/^(https?):\/+(.+)$/i);
        try { return abs ? new URL(`${abs[1]}://${abs[2]}`).toString() : new URL(`/${rest}`, u.origin).toString(); } catch { return null; }
    }
    return null;
}

/** medium_x_0f9e8d7c6b.jpg → x_0f9e8d7c6b.jpg: Strapi always keeps the upload beside its resized copies. */
function stripFormat(src: string): string | null {
    try {
        const u = new URL(src);
        const parts = u.pathname.split('/');
        const m = decodeURIComponent(parts[parts.length - 1]).match(FORMAT_FILE);
        if (!m) return null;
        parts[parts.length - 1] = encodeURIComponent(m[2]);
        u.pathname = parts.join('/');
        return u.toString();
    } catch { return null; }
}

export const adapter: BuilderAdapter = {
    key: 'strapi',
    label: 'Strapi',
    // The word "strapi" alone proves nothing (an agency's page about Strapi). Strapi's own media
    // library does: its hosted media domain, its resized-file names, or its media objects in the data.
    detect: (html) => HOSTED_MEDIA.test(html) || FORMAT_IN_PAGE.test(html) || (MEDIA_FIELDS.test(html) && PROVIDER_FIELD.test(html)),
    prepare($, url) {
        bestByFile = new Map();
        cmsHost = cmsOrigin($.html());
        const data = nextData($);
        const media: Media[] = [];
        if (data) walkJson(data, (v) => { const m = asMedia(v); if (m) media.push(m); });
        media.push(...mediaInFlight($));
        for (const m of media) {
            const best = bestOf(m);
            for (const f of [m.original, ...m.formats]) { const k = fileOf(f.url); if (k) bestByFile.set(k, best); }
        }
        // A page drawn in the browser: the plain page has no words, but its data has them all.
        if (data && wordsIn($) < 40) {
            const props = (data as { props?: { pageProps?: unknown } }).props?.pageProps;
            if (!props) return;
            const scratch = $('<div></div>');
            const b = new Builder($, scratch, cmsHost ?? url?.origin ?? null);
            b.walk(props);
            if (!b.count) return;
            const main = $('main').first();
            if (main.length) main.empty().append(scratch.children()); else $('body').append($('<main></main>').append(scratch.children()));
        }
    },
    fullSizeImage(src) {
        let inner = unwrapResizer(src) ?? src;
        // Nuxt Image is often given the path alone (/_ipx/w_750/uploads/x.jpg): the upload is on the Strapi server.
        if (inner !== src && cmsHost) { try { const u = new URL(inner); if (u.origin === new URL(src).origin && u.pathname.startsWith('/uploads/')) inner = new URL(u.pathname + u.search, cmsHost).toString(); } catch { /* keep it */ } }
        const key = fileOf(inner);
        const best = key ? bestByFile.get(key) : undefined;
        if (best) {
            try { return new URL(best, inner).toString(); } catch { /* fall through */ }
        }
        return stripFormat(inner) ?? (inner !== src ? inner : null);
    },
    // Strapi front ends are usually server-drawn (Next.js, Nuxt, Gatsby), so no headless browser is expected.
    rendersWithJs: false,
};
