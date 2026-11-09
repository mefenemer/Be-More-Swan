// src/utils/site-builders/v0.ts — Website import adapter for v0 (Vercel's AI site builder).
// Findings, what is covered and what is not: docs/site-import-platforms/v0.md
// Tests: tests/site-platform-v0.test.ts (fixtures in tests/fixtures/site-platforms/v0/).
//
// v0 writes a Next.js App Router project (React Server Components, Tailwind, shadcn/ui) and hosts it on
// Vercel. Pages are SERVER-RENDERED: almost every word is in the HTML. What the plain read misses:
//  - closed accordion panels and inactive tabs (Radix renders them EMPTY; their words are only in the
//    React Server Components payload, the `self.__next_f.push([1,"…"])` scripts);
//  - streamed Suspense content (sent at the end of <body> as <div hidden id="S:0">, outside <main>,
//    with a "Loading…" fallback left where it belongs);
//  - pictures behind next/image (`/_next/image?url=%2Fhero.jpg&w=3840&q=75`) and v0's stock
//    placeholders (`/placeholder.svg?height=400&width=600`, placeholder.jpg, placeholder-user.jpg…).
// prepare() puts those words back where the browser would show them — all of them the owner's own,
// read from the page itself; it never fetches and never writes words.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Next.js App Router (or Pages Router) markup. v0 sites are Next.js sites; most Next.js sites are not v0. */
const NEXT = /\/_next\/static\/|self\.__next_f\.push|id="__NEXT_DATA__"/;
/** v0's own fingerprints, any one of which (on a Next.js page) says v0 made it. */
const V0_MARKS = new RegExp([
    String.raw`v0\.(?:app|dev)/chat/api/open/built-with-v0`,     // the free plan's "Built with v0" badge
    String.raw`id="v0-built-with`,
    String.raw`https?://v0-[a-z0-9-]+\.vercel\.app`,              // v0's default deployment name
    String.raw`hebbkx1anhila5yf\.public\.blob\.vercel-storage\.com`, // v0's shared upload store
    String.raw`/placeholder\.svg\?(?:height|width)=\d`,           // v0's placeholder pictures
    String.raw`%2Fplaceholder\.svg%3F(?:height|width)%3D\d`,
].join('|'), 'i');

/** v0's stock placeholder pictures (public/placeholder.svg, placeholder.jpg, placeholder-logo.png, placeholder-user.jpg). */
const PLACEHOLDER = /(?:^|\/)placeholder(?:-[a-z]+)?\.(?:svg|png|jpe?g|webp)$/i;

/** `/_next/image?url=%2Fhero.jpg&w=3840&q=75` → the picture it resizes (absolute), else null. */
export function unwrapNextImage(src: string, base?: URL | null): string | null {
    try {
        const u = new URL(src, base ?? undefined);
        if (!/\/_next\/image\/?$/.test(u.pathname)) return null;
        const inner = u.searchParams.get('url');
        if (!inner) return null;
        const full = new URL(inner, u.origin);
        return /^https?:$/.test(full.protocol) ? full.toString() : null;
    } catch { return null; }
}

function isPlaceholder(src: string, base: URL | null): boolean {
    try { return PLACEHOLDER.test(new URL(src, base ?? 'https://x.invalid/').pathname); } catch { return false; }
}

// ── The React Server Components payload ─────────────────────────────────────────────────────────
// Rows of `id:value\n`, joined from every self.__next_f.push([1,"…"]). A value is JSON (elements are
// ["$", type, key, props]), or `T<hex byte length>,<text>` for long text; "$5" / "$L5" point at row 5,
// "$$…" is a literal "$…", any other "$…" string is React's own bookkeeping.

const FLIGHT_MAX_BYTES = 2_000_000;
const FLIGHT_MAX_ROWS = 5000;

/** The page's RSC rows, or null when it has none. Exported for the tests. */
export function readFlight(html: string): Map<string, unknown> | null {
    const chunks: string[] = [];
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let total = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
        try { const s = JSON.parse(m[1]) as string; chunks.push(s); total += s.length; } catch { /* a broken chunk is skipped */ }
        if (total > FLIGHT_MAX_BYTES) break;
    }
    if (!chunks.length) return null;
    const buf = Buffer.from(chunks.join(''), 'utf8');
    const rows = new Map<string, unknown>();
    let pos = 0;
    while (pos < buf.length && rows.size < FLIGHT_MAX_ROWS) {
        const colon = buf.indexOf(0x3a, pos);
        if (colon < 0) break;
        const id = buf.toString('utf8', pos, colon);
        if (!/^[0-9a-f]{1,8}$/i.test(id)) {   // not a row start: skip the line
            const nl = buf.indexOf(0x0a, pos);
            if (nl < 0) break;
            pos = nl + 1;
            continue;
        }
        const t = /^T([0-9a-f]+),/i.exec(buf.toString('utf8', colon + 1, Math.min(buf.length, colon + 20)));
        if (t) {
            const start = colon + 1 + t[0].length;
            const end = Math.min(buf.length, start + parseInt(t[1], 16));
            rows.set(id, buf.toString('utf8', start, end));
            pos = end;
            if (buf[pos] === 0x0a) pos++;
            continue;
        }
        let nl = buf.indexOf(0x0a, colon);
        if (nl < 0) nl = buf.length;
        const line = buf.toString('utf8', colon + 1, nl);
        if (/^[[{"\d\-tfn]/.test(line)) { try { rows.set(id, JSON.parse(line)); } catch { /* not JSON: skip */ } }
        pos = nl + 1;
    }
    return rows.size ? rows : null;
}

type El = ['$', unknown, unknown, Record<string, unknown>];
const isEl = (v: unknown): v is El => Array.isArray(v) && v[0] === '$' && v.length >= 4 && typeof v[3] === 'object' && v[3] !== null;

/** Tags whose words never belong on the page. */
const SKIP_TAGS = new Set(['script', 'style', 'head', 'meta', 'title', 'link', 'svg', 'template', 'noscript', 'input', 'textarea', 'select', 'option', 'iframe', 'video', 'audio', 'canvas', 'object']);
/** Tags written back as themselves; any other tag is read through (its children only). */
const KEEP_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'a', 'img', 'blockquote', 'section', 'article', 'div', 'span', 'strong', 'em', 'b', 'i', 'u', 'br', 'hr', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'main', 'header', 'footer', 'nav', 'aside', 'button', 'label', 'small', 'time', 'address', 'q', 'cite', 'mark', 'sub', 'sup']);
const VOID = new Set(['img', 'br', 'hr']);
/** Next.js router props that hold someone else's words (its 404 page, loading skeletons, error pages). */
const DROP_PROPS = new Set(['notFound', 'notFoundStyles', 'forbidden', 'unauthorized', 'loading', 'loadingStyles', 'loadingScripts', 'error', 'errorStyles', 'errorScripts', 'globalErrorComponent', 'globalErrorStyles', 'template', 'templateStyles', 'templateScripts', 'fallback', 'styles', 'children']);
const ATTRS: Record<string, string> = { className: 'class', href: 'href', src: 'src', alt: 'alt', width: 'width', height: 'height', role: 'role', srcSet: 'srcset' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class FlightRenderer {
    private out = 0;
    constructor(private rows: Map<string, unknown>) {}
    /** A "$…" string: the row it points at, the literal it escapes, or undefined (React's bookkeeping). */
    resolve(v: unknown, depth = 0): unknown {
        if (typeof v !== 'string' || !v.startsWith('$') || depth > 20) return v;
        if (v.startsWith('$$')) return v.slice(1);
        const ref = /^\$L?([0-9a-f]+)$/i.exec(v);
        if (ref) return this.rows.has(ref[1]) ? this.resolve(this.rows.get(ref[1]), depth + 1) : undefined;
        return undefined;
    }
    /** Owner-visible HTML for a value. `asChild`: strings are text (inside children), not router data. */
    html(v: unknown, asChild: boolean, depth = 0): string {
        if (depth > 80 || this.out > 400_000) return '';
        const r = this.resolve(v);
        if (r === undefined || r === null || typeof r === 'boolean') return '';
        if (typeof r === 'string' || typeof r === 'number') {
            if (!asChild) return '';
            const s = esc(String(r));
            this.out += s.length;
            return s;
        }
        if (isEl(r)) return this.element(r, depth);
        if (Array.isArray(r)) return r.map((x) => this.html(x, asChild, depth + 1)).join('');
        if (typeof r === 'object') return Object.values(r as Record<string, unknown>).map((x) => this.html(x, false, depth + 1)).join('');
        return '';
    }
    private element(el: El, depth: number): string {
        const type = this.resolve(el[1]);
        const props = el[3];
        const kids = () => this.html(props.children, true, depth + 1);
        if (typeof type === 'string' && /^[a-z][a-z0-9-]*$/.test(type)) {
            if (SKIP_TAGS.has(type)) return '';
            if (!KEEP_TAGS.has(type)) return kids();
            const attrs = Object.entries(ATTRS).map(([p, a]) => (typeof props[p] === 'string' || typeof props[p] === 'number' ? ` ${a}="${esc(String(props[p]))}"` : '')).join('');
            return VOID.has(type) ? `<${type}${attrs}>` : `<${type}${attrs}>${kids()}</${type}>`;
        }
        // A component (client component, fragment, Suspense, the Next.js router): its children, and any
        // elements it was handed in other props — but never the router's 404, loading or error pages.
        const others = Object.entries(props).filter(([k]) => !DROP_PROPS.has(k)).map(([, x]) => this.html(x, false, depth + 1)).join('');
        const inner = kids();
        return inner || others ? `<div>${inner}${others}</div>` : '';
    }
    /** Every component element, in page order, with where it sits among its siblings. */
    components(): Array<{ el: El; siblings: unknown[]; at: number }> {
        const found: Array<{ el: El; siblings: unknown[]; at: number }> = [];
        const seen = new Set<unknown>();
        const visit = (v: unknown, siblings: unknown[] | null, at: number, depth: number) => {
            const r = this.resolve(v);
            if (depth > 80 || r === null || typeof r !== 'object' || seen.has(r) || found.length > 3000) return;
            seen.add(r);
            if (isEl(r)) {
                if (typeof this.resolve(r[1]) !== 'string' || !/^[a-z]/.test(String(this.resolve(r[1])))) found.push({ el: r, siblings: siblings ?? [r], at: siblings ? at : 0 });
                for (const [k, x] of Object.entries(r[3])) {
                    if (DROP_PROPS.has(k) && k !== 'children') continue;
                    const kid = this.resolve(x);
                    if (k === 'children' && Array.isArray(kid) && !isEl(kid)) kid.forEach((c, i) => visit(c, kid, i, depth + 1));
                    else visit(x, null, 0, depth + 1);
                }
                return;
            }
            if (Array.isArray(r)) r.forEach((c, i) => visit(c, r, i, depth + 1));
            else Object.values(r).forEach((c) => visit(c, null, 0, depth + 1));
        };
        visit(this.rows.get('0'), null, 0, 0);
        return found;
    }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const wordCount = (s: string) => squash(s).split(' ').filter((w) => /[a-z0-9]/i.test(w)).length;

/** Text of an HTML fragment (for comparing an RSC element with what the page shows). */
function textOfHtml($: cheerio.CheerioAPI, html: string): string {
    return squash($('<div></div>').html(html).text());
}

/**
 * Closed accordion panels, collapsibles and inactive tabs are in the HTML as EMPTY boxes; their words
 * are in the RSC payload, beside the trigger whose words the page does show. Fill each box from there.
 */
function fillClosedPanels($: cheerio.CheerioAPI, f: FlightRenderer): void {
    let comps: ReturnType<FlightRenderer['components']> | null = null;
    const byId = new Map<string, ReturnType<cheerio.CheerioAPI>>();
    $('[id]').each((_, el) => { byId.set($(el).attr('id')!, $(el)); });
    $('[data-state="closed"][id], [data-state="inactive"][id]').each((_, el) => {
        const $panel = $(el);
        if (squash($panel.text()) || $panel.find('img').length) return;
        const id = $panel.attr('id')!;
        const trigger = $(`[aria-controls]`).filter((_, t) => $(t).attr('aria-controls') === id).first();
        const label = trigger.length ? trigger : byId.get($panel.attr('aria-labelledby') ?? '') ?? null;
        const want = label ? squash(label.text()) : '';
        if (!want) return;
        comps ??= f.components();
        const text = (x: unknown) => textOfHtml($, f.html(x, true));
        let words = '';
        const tabValue = /-content-(.+)$/.exec(id)?.[1];
        if (tabValue) {
            // Tabs: the TabsContent with the same value (its trigger has it too, with the label's words).
            const hit = comps.filter((c) => String(c.el[3].value ?? '') === tabValue).map((c) => f.html(c.el[3].children, true)).filter((h) => { const t = textOfHtml($, h); return t && t !== want; }).sort((a, b) => b.length - a.length)[0];
            words = hit ?? '';
        } else {
            // Accordion / collapsible: the trigger's next sibling.
            const at = comps.find((c) => text(c.el[3].children) === want && c.at + 1 < c.siblings.length);
            const next = at ? f.resolve(at.siblings[at.at + 1]) : null;
            if (next && isEl(next)) words = f.html(next[3].children, true);
        }
        if (words && textOfHtml($, words)) $panel.html(words).removeAttr('hidden');
    });
}

/** The page's own words, in the main area (menus, header, footer and scripts aside). */
function visibleWords($: cheerio.CheerioAPI): number {
    const root = ($('main').first().length ? $('main').first() : $('body').first()).clone();
    root.find('script, style, noscript, template, svg, header, footer, nav, [hidden]').remove();
    return wordCount(root.text());
}

/**
 * React streams slow parts of a page later in the same HTML: the fallback ("Loading…") stands where the
 * part belongs, between <template id="B:0"> and <!--/$-->, and the part itself arrives as
 * <div hidden id="S:0"> at the end of <body>. Put it where the browser would ($RC does this).
 */
function spliceStreamed($: cheerio.CheerioAPI): void {
    $('template[id^="B:"]').each((_, t) => {
        const n = ($(t).attr('id') ?? '').slice(2);
        const seg = $('div[hidden]').filter((_, d) => $(d).attr('id') === `S:${n}`).first();
        if (!seg.length) return;
        let sib = t.next;
        while (sib && !(sib.type === 'comment' && (sib as unknown as { data: string }).data === '/$')) { const nx = sib.next; $(sib).remove(); sib = nx; }
        $(t).replaceWith(seg.contents());
        seg.remove();
    });
}

export const adapter: BuilderAdapter = {
    key: 'v0',
    label: 'v0',
    // v0 puts <meta name="generator" content="v0.app"> (earlier "v0.dev") on every page it builds. When
    // the owner has removed it, a v0 site looks like any Next.js site: only v0's own fingerprints (its
    // badge, a v0-*.vercel.app address, its upload store, its placeholder pictures) tell it apart. A page
    // that merely LINKS to v0.app is not a v0 site.
    detect: (html, gen) => /^v0(?:\.app|\.dev)?\b/.test(gen) || (NEXT.test(html) && V0_MARKS.test(html)),
    prepare($, url) {
        spliceStreamed($);
        const html = $.html();
        const rows = readFlight(html);
        if (rows) {
            const f = new FlightRenderer(rows);
            try { fillClosedPanels($, f); } catch { /* the plain read still stands */ }
            // A page whose HTML is only a loading shell: read the words from the payload instead (saves
            // the headless browser, which readPage would otherwise open for a page under 40 words).
            try {
                const have = visibleWords($);
                if (have < 40) {
                    const rendered = f.html(rows.get('0'), false);
                    const frag = $('<div></div>').html(rendered);
                    const inner = frag.find('main').first();
                    const body = inner.length ? inner : frag;
                    body.find('header, footer, nav').remove();
                    if (wordCount(body.text()) > have + 10) {
                        const main = $('main').first();
                        if (main.length) main.html(body.html() ?? '');
                        else $('body').append(`<main>${body.html() ?? ''}</main>`);
                    }
                }
            } catch { /* the plain read still stands */ }
        }
        // Pictures: next/image wrappers → the picture itself; v0's placeholders are not the owner's.
        $('img').each((_, img) => {
            const $i = $(img);
            const src = $i.attr('src') ?? '';
            const real = unwrapNextImage(src, url) ?? unwrapNextImage(($i.attr('srcset') ?? '').split(/[\s,]+/)[0] ?? '', url);
            if (real) { $i.attr('src', real); $i.removeAttr('srcset'); }
            const now = $i.attr('src') ?? '';
            if (now && isPlaceholder(now, url)) $i.remove();
        });
        // v0's free-plan badge, and screen-reader-only labels on icon buttons ("Toggle menu").
        $('a[href*="built-with-v0"], [id^="v0-built-with"], button .sr-only').remove();
    },
    noise: /^(built with v0|edit (this )?(in|with) v0|open in v0|toggle (menu|navigation|theme|sidebar)|(previous|next) slide|loading(\.\.\.|…)?)$/i,
    fullSizeImage: (src) => unwrapNextImage(src),
    // Server-rendered: the words are in the HTML (and the RSC payload), so the headless browser is rarely needed.
    rendersWithJs: false,
};
