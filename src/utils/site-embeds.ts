// src/utils/site-embeds.ts — read the words a page keeps inside an embedded HTML box.
//
// Some builders let an owner paste their own HTML into the page and serve it in an <iframe> from
// another address. Wix's "Embed HTML" box loads from <site>.filesusr.com/html/…, and its server
// HTML doesn't even carry the frame: it ships an empty <div id="comp-…"> and the page's script
// looks the address up in the page's data file. A page built that way has almost no words of its
// own (kudzucollab.com, 2026-11-07: 35 words on the page, 455 inside the box). Both readers drop
// every <iframe>, and headless Chrome's page.content() is the top document only, so neither
// Website import nor the Mystery Shopper saw the words.
//
// This file finds those boxes — an <iframe> in the HTML, or a Wix box through the page's data file
// on static.wixstatic.com — reads each one through the caller's fetch (site-fetch.ts: robots.txt
// and the SSRF fence), and puts its body where the box sits on the page. The extractors
// (site-extract.ts) then read the page as a visitor sees it. Only boxes that hold the owner's own
// pasted HTML are read: Wix "htmlEmbedded" boxes and frames from the page's own site. Maps, videos,
// booking widgets and other people's frames stay out.

import * as cheerio from 'cheerio';
import type { HtmlFetch } from './site-fetch';

/** At most this many boxes are read on one page. */
export const EMBED_MAX = 3;

export interface EmbedFetchers {
    html(url: string): Promise<HtmlFetch>;
    /** Wix's page data file (JSON). */
    json(url: string): Promise<HtmlFetch>;
}

/** Where a box's words go: in place of an <iframe> with this src, or inside Wix's empty component. */
export type EmbedTarget = { url: string; iframeSrc: string } | { url: string; wixComponentId: string };

const hostKey = (h: string) => h.toLowerCase().replace(/^www\./, '');

/** A Wix "Embed HTML" box: https://<site>.filesusr.com/html/<file>.html */
function isWixEmbed(u: URL): boolean {
    return u.protocol === 'https:' && /(^|\.)filesusr\.com$/i.test(u.hostname) && /^\/html\/[\w-]+\.html$/.test(u.pathname);
}

/** <iframe>s in the HTML worth reading: Wix embed boxes, and frames from the page's own site. */
export function iframeEmbedTargets(html: string, pageUrl: string): EmbedTarget[] {
    let page: URL;
    try { page = new URL(pageUrl); } catch { return []; }
    const $ = cheerio.load(html);
    const out: EmbedTarget[] = [];
    $('iframe').each((_, el) => {
        const src = $(el).attr('src');
        if (!src) return;
        let u: URL;
        try { u = new URL(src, page); } catch { return; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
        if (!isWixEmbed(u) && hostKey(u.hostname) !== hostKey(page.hostname)) return;
        if (u.href === page.href || out.some((t) => t.url === u.href)) return;
        out.push({ url: u.href, iframeSrc: src });
    });
    return out;
}

/**
 * A Wix page's data file and the address its embed boxes are served from, from the page's own HTML:
 * `landingPageId` names the page, `pageJsonFileNames` its data file, `staticHTMLComponentUrl` the
 * filesusr.com origin. Null for anything that isn't a Wix page shaped this way.
 */
export function wixPageData(html: string): { jsonUrl: string; embedBase: string } | null {
    const page = html.match(/"landingPageId"\s*:\s*"([\w-]+)"/)?.[1];
    if (!page) return null;
    const files = html.match(/"pageJsonFileNames"\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
    const file = files.match(new RegExp(`"${page}"\\s*:\\s*"([\\w-]+\\.json)"`))?.[1];
    const baseRaw = html.match(/"staticHTMLComponentUrl"\s*:\s*"([^"]+)"/)?.[1];
    if (!file || !baseRaw) return null;
    let base: URL;
    try { base = new URL(baseRaw.replace(/\\\//g, '/')); } catch { return null; }
    if (base.protocol !== 'https:' || !/(^|\.)filesusr\.com$/i.test(base.hostname)) return null;
    return { jsonUrl: `https://static.wixstatic.com/sites/${file}.z?v=3`, embedBase: base.origin + '/' };
}

/** The Wix "htmlEmbedded" boxes a page data file describes, with the component each one fills. */
export function wixEmbedTargets(json: unknown, embedBase: string): EmbedTarget[] {
    const doc = json as { data?: { document_data?: Record<string, { type?: string; url?: unknown; sourceType?: unknown }> } } | null;
    const data = doc?.data?.document_data ?? {};
    const out: EmbedTarget[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const o = node as Record<string, unknown>;
        if (typeof o.id === 'string' && typeof o.dataQuery === 'string' && /HtmlComponent$/.test(String(o.componentType ?? ''))) {
            const item = data[o.dataQuery.replace(/^#/, '')];
            if (item?.type === 'HtmlComponent' && item.sourceType === 'htmlEmbedded' && typeof item.url === 'string') {
                try {
                    const u = new URL(item.url, embedBase);
                    if (isWixEmbed(u) && !out.some((t) => 'wixComponentId' in t && t.wixComponentId === o.id)) out.push({ url: u.href, wixComponentId: o.id });
                } catch { /* not an address */ }
            }
        }
        for (const v of Object.values(o)) walk(v);
    };
    walk((json as { structure?: unknown } | null)?.structure);
    return out;
}

/** The readable body of one embedded box: no scripts or styles, links and pictures made absolute. */
function embedBody(html: string, url: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript, template, iframe, head').remove();
    $('[src]').each((_, el) => { try { $(el).attr('src', new URL($(el).attr('src')!, url).href); } catch { $(el).removeAttr('src'); } });
    $('[href]').each((_, el) => { try { $(el).attr('href', new URL($(el).attr('href')!, url).href); } catch { $(el).removeAttr('href'); } });
    // A box's own <main> must not become the page's main: the page around it is still the page.
    $('main').each((_, el) => { if (el.type === 'tag') el.name = 'div'; });
    return $('body').html() ?? '';
}

export interface EmbedRead { html: string; found: number; read: number }

/**
 * The page with each embedded box's body where the box sits. A box that can't be read is left as it
 * was (the extractors drop it, as before). Never throws.
 */
export async function inlineEmbeds(html: string, pageUrl: string, fetch: EmbedFetchers): Promise<EmbedRead> {
    let targets = iframeEmbedTargets(html, pageUrl);
    const wix = wixPageData(html);
    if (wix) {
        const r = await fetch.json(wix.jsonUrl).catch(() => null);
        let parsed: unknown = null;
        if (r?.ok) { try { parsed = JSON.parse(r.html); } catch { parsed = null; } }
        for (const t of wixEmbedTargets(parsed, wix.embedBase)) if (!targets.some((x) => x.url === t.url)) targets.push(t);
    }
    targets = targets.slice(0, EMBED_MAX);
    if (!targets.length) return { html, found: 0, read: 0 };

    const bodies = await Promise.all(targets.map(async (t) => {
        const r = await fetch.html(t.url).catch(() => null);
        return r?.ok ? embedBody(r.html, r.finalUrl) : null;
    }));
    const $ = cheerio.load(html);
    let read = 0;
    targets.forEach((t, i) => {
        const body = bodies[i];
        if (body === null) return;
        const block = `<div data-embedded>${body}</div>`;
        if ('iframeSrc' in t) {
            const frame = $('iframe').filter((_, el) => $(el).attr('src') === t.iframeSrc).first();
            if (!frame.length) return;
            frame.replaceWith(block);
        } else {
            const slot = $(`[id="${t.wixComponentId.replace(/"/g, '')}"]`).first();
            if (slot.length) slot.html(block);
            else ($('main').length ? $('main').first() : $('body')).append(block);
        }
        read++;
    });
    return { html: read ? $.html() : html, found: targets.length, read };
}
