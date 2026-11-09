// src/utils/site-page-data.ts — a JavaScript framework's page, read without a browser where possible
// (2026-11-09, the platform reports' shared "framework page data" fix; v0, Sanity, Sitecore, Contentful,
// Strapi, Payload, Cursor, Windsurf and Lovable each needed some of it).
//
//   · spliceStreamed — React streams slow parts later in the same HTML (<div hidden id="S:0">); they are
//     put where the browser would put them. Always safe: only moves what the server already sent.
//   · expandThinPage — a page that arrives as a shell (under 40 visible words) has its words in the page
//     data the framework leaves behind: Next.js (__NEXT_DATA__ and the RSC flight payload), Remix,
//     SvelteKit and Nuxt. Headings and paragraphs are taken from content-like keys only; nothing is
//     written, and words already on the page are not repeated. A page the server drew is left alone.
//
// Runs in site-extract.ts readImportPage after the platform adapter's own prepare, so an adapter that
// reads its own data better (Sanity's Portable Text) goes first and this finds the page no longer thin.
import type * as cheerio from 'cheerio';

type Json = unknown;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** React's streamed Suspense boundaries, put in place of their "Loading…" fallbacks ($RC's job). */
export function spliceStreamed($: cheerio.CheerioAPI): void {
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

/** Every page-data blob the frameworks leave in a page. */
export function pageDataBlobs($: cheerio.CheerioAPI): Json[] {
    const found: Json[] = [];
    const parse = (s: string) => { try { found.push(JSON.parse(s) as Json); } catch { /* not JSON */ } };
    // Next.js pages router.
    const nd = $('script#__NEXT_DATA__').first().text();
    if (nd) { try { const d = JSON.parse(nd) as Obj; found.push(isObj(d.props) && isObj(d.props.pageProps) ? d.props.pageProps : d); } catch { /* broken */ } }
    // Nuxt 3 (<script id="__NUXT_DATA__" type="application/json">) and SvelteKit's fetched data.
    $('script#__NUXT_DATA__, script[type="application/json"][data-sveltekit-fetched], script[type="application/json"][data-nuxt-data]').each((_, el) => {
        const t = $(el).text();
        parse(t);
        try { const o = JSON.parse(t) as Obj; if (typeof o.body === 'string') parse(o.body); } catch { /* not JSON */ }
    });
    let flight = '';
    $('script:not([src])').each((_, el) => {
        const s = $(el).text();
        // Next.js app router: the RSC flight payload, in self.__next_f.push([1, "…"]) chunks.
        for (const m of s.matchAll(/self\.__next_f\.push\((\[1,\s*"(?:[^"\\]|\\.)*"\])\)/g)) {
            try { flight += (JSON.parse(m[1]) as [number, string])[1]; } catch { /* broken */ }
        }
        const remix = s.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\});\s*(?:__remixContext|$)/);
        if (remix) { try { const r = JSON.parse(remix[1]) as Obj; found.push(isObj(r.state) ? r.state.loaderData ?? null : null); } catch { /* broken */ } }
        // Nuxt 2: window.__NUXT__=(function(a,b){return {...}}(…)) is code, not JSON — only a plain object.
        const nuxt = s.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
        if (nuxt) parse(nuxt[1]);
    });
    // RSC rows "5:[…]" / "5:{…}" are data; text rows "5:T…" hold long text after a length marker.
    for (const line of flight.split('\n')) {
        const m = line.match(/^[0-9a-f]+:([[{].*)$/);
        if (m) parse(m[1]);
        const t = line.match(/^[0-9a-f]+:T[0-9a-f]+,(.+)$/);
        if (t) found.push(t[1]);
    }
    return found;
}

/** Keys whose values are never words for a visitor. */
const SKIP_KEY = /^(_|\$)|(^|_)(id|ids|key|keys|slug|url|urls|href|src|srcset|path|class|classname|style|styles|type|token|hash|locale|lang|query|params|cursor|etag|mime|format|width|height|size|color|colour|icon|variant|theme|status|version|created|updated|date|time|timestamp|seo|meta|og|twitter|schema|analytics|tracking|config|env|build|chunk|manifest|buildid)s?$/i;
const HEADING_KEY = /^(title|heading|headline|name|label|question|q)$/i;
const TEXT_KEY = /^(text|body|description|content|summary|excerpt|subtitle|subheading|caption|answer|a|copy|paragraph|intro|lead|quote|bio|value|children)$/i;
const looksLikeWords = (s: string) => /[a-z]/i.test(s) && !/^(https?:|\/|#|\{|<|data:)/i.test(s.trim()) && !/[{}<>]|=>|function\s*\(|\bvar\b|\$\{/.test(s);
const words = (s: string) => s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

/** Headings and paragraphs from page data, in the order found, each once. */
export function proseFromData(blobs: Json[], already: string): Array<{ kind: 'h' | 'p'; text: string }> {
    const out: Array<{ kind: 'h' | 'p'; text: string }> = [];
    const seen = new Set<string>();
    const have = already.replace(/\s+/g, ' ').toLowerCase();
    const add = (kind: 'h' | 'p', raw: string) => {
        const t = raw.replace(/\s+/g, ' ').trim();
        const k = t.toLowerCase();
        if (!t || seen.has(k) || have.includes(k) || !looksLikeWords(t) || t.length > 3000) return;
        if (kind === 'h' ? words(t) < 1 || words(t) > 16 : words(t) < 6) return;
        seen.add(k); out.push({ kind, text: t });
    };
    const walk = (v: unknown, key: string, depth: number) => {
        if (depth > 40 || out.length > 400) return;
        if (typeof v === 'string') {
            if (!key) { if (words(v) >= 6) add('p', v); return; }
            if (SKIP_KEY.test(key)) return;
            if (HEADING_KEY.test(key)) add('h', v);
            else if (TEXT_KEY.test(key) || words(v) >= 12) add('p', v);
            return;
        }
        if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
        if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (!SKIP_KEY.test(k)) walk(x, k, depth + 1); }
    };
    for (const b of blobs) walk(b, '', 0);
    return out;
}

/** Words on the page a visitor sees without JavaScript. */
export function visibleWords($: cheerio.CheerioAPI): number {
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg').remove();
    return words(body.text());
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A shell page (under 40 visible words) gets the words its framework data holds. True when it added some. */
export function expandThinPage($: cheerio.CheerioAPI, thinWords = 40): boolean {
    if (visibleWords($) >= thinWords) return false;
    const blobs = pageDataBlobs($);
    if (!blobs.length) return false;
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg').remove();
    const prose = proseFromData(blobs, body.text());
    if (!prose.length || prose.reduce((n, x) => n + words(x.text), 0) < 12) return false;
    const box = `<div data-page-data>${prose.map((x) => (x.kind === 'h' ? `<h2>${esc(x.text)}</h2>` : `<p>${esc(x.text)}</p>`)).join('')}</div>`;
    const main = $('main').first();
    if (main.length) { main.find('p').filter((_, p) => /^loading\W*$/i.test($(p).text().trim())).remove(); main.append(box); }
    else $('body').append(`<main>${box}</main>`);
    return true;
}

/**
 * Radix (shadcn) renders a closed accordion or an inactive tab as an EMPTY panel; its words are only in
 * the page data. When a page has such empty panels, the words its data holds that the page lacks are
 * added at the end of its content (better than lost; a platform adapter can place them more exactly, as
 * v0's does). True when it added some.
 */
export function fillClosedPanels($: cheerio.CheerioAPI): boolean {
    const empty = $('[data-state="closed"], [data-state="inactive"]').filter((_, el) => {
        const role = ($(el).attr('role') ?? '').toLowerCase();
        const panel = role === 'region' || role === 'tabpanel' || $(el).is('[hidden]') || /content|panel/i.test($(el).attr('class') ?? '');
        return panel && !$(el).text().trim();
    });
    if (!empty.length) return false;
    const blobs = pageDataBlobs($);
    if (!blobs.length) return false;
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg').remove();
    const prose = proseFromData(blobs, body.text()).filter((x) => x.kind === 'p');
    if (!prose.length) return false;
    const box = `<div data-closed-panels>${prose.map((x) => `<p>${esc(x.text)}</p>`).join('')}</div>`;
    const main = $('main').first();
    (main.length ? main : $('body')).append(box);
    return true;
}

/** Phone-only menu drawers and overlays (Tailwind md:hidden / lg:hidden, fixed or a dialog): the menu again, never content. */
export function removePhoneDrawers($: cheerio.CheerioAPI): void {
    $('[class*="md:hidden"], [class*="lg:hidden"], [class*="sm:hidden"]').filter((_, el) => {
        const cls = ` ${$(el).attr('class') ?? ''} `;
        const overlay = /\s(fixed|inset-0)\s/.test(cls) || ($(el).attr('role') ?? '') === 'dialog';
        return overlay && $(el).find('a[href]').length >= 2;
    }).remove();
}
