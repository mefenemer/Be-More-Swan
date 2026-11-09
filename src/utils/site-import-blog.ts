// src/utils/site-import-blog.ts — the posts of a blog on the owner's OLD site (WordPress, Squarespace,
// Wix, Ghost or bespoke), brought into the Blog Assistant as DRAFTS by "Import my current site".
//
// site-import.ts runImport finds the blog's index among the pages it reads (findBlogIndex), and this
// file reads the posts: the list from their feed when there is one (RSS/Atom), topped up from
// WordPress's own API and the links on the index page; then each post page, in turns of 3, through the
// same fetcher as every imported page (robots.txt + SSRF fence, site-fetch.ts). PURE apart from the
// fetchers passed in — tests/site-import-blog.test.ts runs it on saved pages.
//
// Nothing is published. The posts wait in the import's report (site_imports.report.blog) and become
// blog_posts drafts only when the owner presses "Use this as my draft" (site-import-store.ts
// acceptImport) — the owner reviews and publishes each one in the Blog Assistant. Their words are
// copied as they are, as Markdown (the Blog Assistant's source of truth): no model touches them.
// Pictures come only when the owner chose to copy pictures; otherwise they are left out (never
// hot-linked from the old site's CDN).

import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { fullSizeImageUrl, statesPrice } from './site-extract';
import { redirectKey } from './site-definition';

/** Posts brought in at most, per import. */
export const BLOG_IMPORT_MAX_POSTS = 30;
/** Pictures copied at most across all the posts (feature pictures first), and per post. */
export const BLOG_IMPORT_MAX_PICTURES = 60;
export const BLOG_IMPORT_MAX_PICTURES_PER_POST = 8;
/** A post's body is cut at this many characters (a 6,000-word article is ~40k). */
export const BLOG_IMPORT_MAX_BODY = 60_000;
/** Below this many words a post page's main body is not trusted over the feed's copy. */
const MIN_BODY_WORDS = 30;

type Fetch = { ok: true; html: string; finalUrl: string } | { ok: false; message: string };

export interface BlogIndexSignal {
    /** The index page (their "Blog" / "News" page). */
    url: string;
    /** Their feed (RSS or Atom), when the page names one — or the builder's usual address for it. */
    feedUrl: string | null;
    /** WordPress's REST API root (…/wp-json/), when the page names one. */
    wpApi: string | null;
    /** Post addresses linked from the index page, in page order. */
    postLinks: string[];
    /** The builder the page looked like, for the review. */
    kind: 'wordpress' | 'squarespace' | 'wix' | 'ghost' | 'other';
}

/** One post as read from the old site — held in the import's report until the owner accepts. */
export interface ImportedBlogPost {
    title: string;
    /** The address it will have on the new site, before checking it's free (acceptImport). */
    slug: string;
    /** Where it was on the old site — kept as the draft's canonical_url, and the redirect's source. */
    sourceUrl: string;
    /** redirectKey of the old address: what a visitor's old link is matched on. */
    fromPath: string;
    /** When it was first published on the old site (ISO), when the page or feed said. */
    date: string | null;
    bodyMarkdown: string;
    /** Their own description of it (meta description / feed summary) — the draft's meta description. */
    excerpt: string | null;
    tags: string[];
    words: number;
    /** The feature picture, copied into their library (only when they chose to copy pictures). */
    featureAssetId: number | null;
    featureAlt: string | null;
    /** The body mentions a price — shown on the review so they check it is still right. */
    mentionsPrice: boolean;
}

export interface ImportedBlog {
    indexUrl: string;
    /** Their menu's word for the blog ("Blog", "News") — the new site's menu entry. */
    label: string;
    kind: BlogIndexSignal['kind'];
    /** Where the list of posts came from. */
    source: 'feed' | 'wordpress' | 'page';
    posts: ImportedBlogPost[];
    /** Posts found but not brought in, and why. */
    failed: Array<{ url: string; title: string; note: string }>;
    /** More posts were listed than BLOG_IMPORT_MAX_POSTS. */
    more: boolean;
    pictures: { copied: number; failed: number };
}

// ── Finding the blog ────────────────────────────────────────────────────────────────────────────

/** Paths that are a post's own address on the common builders. */
const POST_PATH = /^\/(?:(?:blog|news|posts?|articles?|journal|insights|stories|updates|diary|musings)\/[^/]+|\d{4}\/\d{1,2}\/(?:\d{1,2}\/)?[^/]+|[^/]+\/\d{4}\/\d{1,2}\/[^/]+)\/?$/i;
/** Listing machinery, never a post. */
const NOT_POST = /\/(?:tag|tags|category|categories|author|page|feed|comments|search|archive|wp-json|wp-content|wp-admin|rss|amp)(?:\/|$)|\?|\.(?:xml|json|pdf|jpe?g|png|gif|webp|zip)$/i;

const hostKey = (u: string) => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const pathOf = (u: string) => { try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch { return ''; } };
const sameUrl = (a: string, b: string) => hostKey(a) === hostKey(b) && pathOf(a) === pathOf(b);
const absolute = (href: string | undefined, base: string): string | null => {
    if (!href) return null;
    try {
        const u = new URL(href.trim(), base);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        u.hash = '';
        return u.toString();
    } catch { return null; }
};

/** An index page's own address that says "blog" — its children are posts even without a builder's marker. */
const BLOGGY_INDEX = /(?:^|\/)(?:blog|blogs|news|journal|articles?|insights|stories|updates|diary|posts|musings)(?:\/|$)/i;

/**
 * Whether `url` (on the old site) looks like one post, seen from the index page `indexUrl`. A page
 * beneath the index counts only when the index is plainly a blog (`loose`: its address or a builder's
 * blog marker) — /services/coaching beneath /services is a page, not a post.
 */
export function isPostUrl(url: string, indexUrl: string, loose = BLOGGY_INDEX.test(pathOf(indexUrl))): boolean {
    if (hostKey(url) !== hostKey(indexUrl)) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.search || NOT_POST.test(u.pathname)) return false;
    const path = u.pathname.replace(/\/+$/, '');
    const index = pathOf(indexUrl);
    if (!path || path === index) return false;
    if (POST_PATH.test(u.pathname)) return true;
    // Beneath the index page itself: /our-blog/my-post (Squarespace collections, Ghost on a subpath).
    return loose && index !== '/' && path.startsWith(`${index}/`) && path.slice(index.length + 1).split('/').length === 1;
}

/**
 * Whether this page is a blog's index — and if so, where its posts can be listed from. Null for any
 * other page (a services page of cards is not a blog: its links aren't post addresses).
 * `menuUrls`: the site's own menu pages, never counted as posts.
 */
export function findBlogIndex(html: string, url: string, menuUrls: string[] = []): BlogIndexSignal | null {
    let $: cheerio.CheerioAPI;
    try { $ = cheerio.load(html); } catch { return null; }
    const bodyClass = ($('body').attr('class') ?? '').toLowerCase();
    const gen = ($('meta[name="generator"]').attr('content') ?? '').toLowerCase();
    const kind: BlogIndexSignal['kind'] = gen.includes('wordpress') || /\/wp-content\//.test(html) ? 'wordpress'
        : gen.includes('squarespace') || /squarespace-cdn\.com|static1\.squarespace\.com/.test(html) ? 'squarespace'
        : gen.includes('wix') || /static\.wixstatic\.com/.test(html) ? 'wix'
        : gen.includes('ghost') ? 'ghost' : 'other';

    // A single post (or a page) is not an index, whatever it links to.
    // (Not "page": a WordPress page built with a posts block is a fine index.)
    if (/(?:^|\s)(single|single-post|post-template)(?:\s|$)/.test(bodyClass) && !/\b(blog|archive|home-template|tag-template)\b/.test(bodyClass)) return null;

    const marker = /\b(blog|archive|home-template|tag-template|collection-type-blog)\b/.test(bodyClass)
        || $('[data-controller="BlogList"], .blog-list, .BlogList, .blog-basic-grid, .blog-masonry, [data-hook="post-list"], [data-hook="post-list-pro-gallery"], .post-feed, .gh-postfeed').length > 0;

    const loose = marker || BLOGGY_INDEX.test(pathOf(url));
    const links: string[] = [];
    const add = (href: string | undefined) => {
        const abs = absolute(href, url);
        if (!abs || menuUrls.some((m) => sameUrl(m, abs)) || !isPostUrl(abs, url, loose) || links.some((l) => sameUrl(l, abs))) return;
        links.push(abs);
    };
    // Article cards first (their title link), then every other link that is a post's address.
    $('article').each((_, el) => { add($(el).find('h1 a, h2 a, h3 a, a[rel="bookmark"]').first().attr('href') ?? $(el).find('a[href]').first().attr('href')); });
    $('[data-hook="post-title"] a, a[data-hook="post-title"], .blog-item a, .post-card a, .entry-title a').each((_, el) => { add($(el).attr('href')); });
    const articles = links.length;
    $('main a[href], #content a[href], body a[href]').each((_, el) => { if (!$(el).closest('nav, header, footer, aside').length) add($(el).attr('href')); });

    const feeds = $('link[rel="alternate"]').toArray()
        .filter((el) => /rss|atom/i.test($(el).attr('type') ?? ''))
        .map((el) => ({ href: absolute($(el).attr('href'), url), title: ($(el).attr('title') ?? '').toLowerCase() }))
        .filter((f): f is { href: string; title: string } => !!f.href && !/comment/.test(f.title) && !/\/comments\/feed/.test(f.href));
    // The feed for THIS page (Squarespace: /blog?format=rss) beats the site-wide one.
    const index = pathOf(url);
    const feed = feeds.find((f) => index !== '/' && pathOf(f.href).startsWith(index)) ?? feeds[0] ?? null;
    const wpApi = absolute($('link[rel="https://api.w.org/"]').attr('href'), url);

    const isIndex = (marker && (links.length >= 1 || !!feed))
        || articles >= 2
        || links.length >= 3;
    if (!isIndex) return null;

    const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
    const guessed = kind === 'wordpress' ? `${origin}/feed/` : kind === 'wix' ? `${origin}/blog-feed.xml` : kind === 'ghost' ? `${origin}/rss/`
        : kind === 'squarespace' && index !== '/' ? `${origin}${index}?format=rss` : null;
    return {
        url, kind,
        feedUrl: feed?.href ?? guessed,
        wpApi: wpApi ?? (kind === 'wordpress' ? `${origin}/wp-json/` : null),
        postLinks: links.slice(0, BLOG_IMPORT_MAX_POSTS * 2),
    };
}

// ── The list of posts ───────────────────────────────────────────────────────────────────────────

export interface ListedPost {
    url: string;
    title: string | null;
    date: string | null;
    /** The post's body as the feed or API carries it (HTML), when it does. */
    contentHtml: string | null;
    summary: string | null;
    tags: string[];
    image: string | null;
}

const isoDate = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const t = new Date(s.trim());
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const textOf = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
/** HTML entities in a feed's title ("Tips &amp; tricks", "&#8217;") → text. */
const decode = (s: string | null | undefined): string => {
    const t = textOf(s);
    if (!/[&<]/.test(t)) return t;
    try { return textOf(cheerio.load(`<p>${t}</p>`)('p').text()); } catch { return t; }
};

/** The posts an RSS or Atom feed lists, newest first as the feed has them. */
export function readFeed(xml: string, base: string): ListedPost[] {
    let $: cheerio.CheerioAPI;
    try { $ = cheerio.load(xml, { xmlMode: true }); } catch { return []; }
    const out: ListedPost[] = [];
    $('item').each((_, el) => {
        const it = $(el);
        const url = absolute(textOf(it.children('link').first().text()) || it.children('guid').first().text(), base);
        if (!url) return;
        const enclosure = it.children('enclosure').toArray().find((e) => /^image\//.test($(e).attr('type') ?? ''));
        const media = it.find('media\\:content, media\\:thumbnail').first().attr('url');
        out.push({
            url,
            title: decode(it.children('title').first().text()) || null,
            date: isoDate(it.children('pubDate').first().text() || it.children('dc\\:date').first().text()),
            contentHtml: it.children('content\\:encoded').first().text() || null,
            summary: decode(it.children('description').first().text()) || null,
            tags: it.children('category').toArray().map((c) => decode($(c).text())).filter(Boolean),
            image: absolute(enclosure ? $(enclosure).attr('url') : media, base),
        });
    });
    $('entry').each((_, el) => {
        const it = $(el);
        const link = it.children('link').toArray().find((l) => ($(l).attr('rel') ?? 'alternate') === 'alternate') ?? it.children('link').get(0);
        const url = absolute(link ? $(link).attr('href') : undefined, base);
        if (!url) return;
        out.push({
            url,
            title: decode(it.children('title').first().text()) || null,
            date: isoDate(it.children('published').first().text() || it.children('updated').first().text()),
            contentHtml: it.children('content').first().text() || null,
            summary: decode(it.children('summary').first().text()) || null,
            tags: it.children('category').toArray().map((c) => textOf($(c).attr('term'))).filter(Boolean),
            image: absolute(it.find('media\\:thumbnail, media\\:content').first().attr('url'), base),
        });
    });
    return out;
}

/** The posts WordPress's REST API lists (wp/v2/posts). */
export function readWpPosts(json: string, base: string): ListedPost[] {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const out: ListedPost[] = [];
    for (const p of raw as Array<Record<string, any>>) {
        const url = absolute(typeof p?.link === 'string' ? p.link : undefined, base);
        if (!url) continue;
        out.push({
            url,
            title: decode(p.title?.rendered) || null,
            date: isoDate(p.date_gmt ? `${p.date_gmt}Z` : p.date),
            contentHtml: typeof p.content?.rendered === 'string' ? p.content.rendered : null,
            summary: decode(p.excerpt?.rendered) || null,
            tags: [],
            image: null,
        });
    }
    return out;
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────────────────────────
// The Blog Assistant keeps Markdown (blog_posts.body_markdown, rendered by marked at publish). Only
// their words, headings, lists, quotes, links and (as numbered tokens) pictures come across; their
// HTML, scripts, styles, share buttons and forms never do.

export interface MarkdownImage { src: string; alt: string; }
/** A picture's place in the body until it is copied: `![alt](bms-import-image:N)`. */
export const IMAGE_TOKEN = /!\[([^\]]*)\]\(bms-import-image:(\d+)\)/g;

const DROP = 'script, style, noscript, template, form, button, input, select, textarea, svg, canvas, nav, aside, iframe:not([src*="youtube"]):not([src*="vimeo"]), '
    + '.sharedaddy, .sd-sharing, .jp-relatedposts, .wpcnt, .post-navigation, .nav-links, .comments-area, #comments, .comment-respond, .addtoany_share_save_container, '
    + '.ss-social, .blog-item-comments, .squarespace-comments, .blog-meta-section, .entry-meta, .post-meta, .entry-footer, .author-bio, .wp-block-buttons, .screen-reader-text, [aria-hidden="true"]';

// Markdown's own marks, and < > so a post's text can never become HTML (the renderers sanitise too).
const esc = (s: string) => s.replace(/([\\`*_[\]<>])/g, '\\$1');

export function htmlToMarkdown(html: string, base: string): { markdown: string; images: MarkdownImage[] } {
    const $ = cheerio.load(`<div id="bms-root">${html}</div>`);
    $(DROP).remove();
    const images: MarkdownImage[] = [];
    const image = (el: Element): string => {
        const $el = $(el);
        const src = absolute($el.attr('data-src') || $el.attr('data-lazy-src') || $el.attr('data-image') || $el.attr('src'), base);
        const w = Number($el.attr('width') || 0);
        if (!src || /^data:/.test(src) || /\bwp-smiley\b|\bemoji\b/.test($el.attr('class') ?? '') || /s\.w\.org\/images\/core\/emoji/.test(src) || (w > 0 && w < 40)) return '';
        if (images.length >= BLOG_IMPORT_MAX_PICTURES_PER_POST) return '';
        images.push({ src: fullSizeImageUrl(src), alt: textOf($el.attr('alt')) });
        return `![${esc(textOf($el.attr('alt')))}](bms-import-image:${images.length - 1})`;
    };
    const inline = (nodes: AnyNode[]): string => nodes.map((n) => {
        if (n.type === 'text') return esc((n as unknown as { data: string }).data.replace(/\s+/g, ' '));
        if (n.type !== 'tag') return '';
        const el = n as Element;
        const kids = () => inline(el.children as AnyNode[]);
        switch (el.name) {
            case 'br': return '\n';
            case 'strong': case 'b': { const t = kids().trim(); return t ? `**${t}**` : ''; }
            case 'em': case 'i': { const t = kids().trim(); return t ? `*${t}*` : ''; }
            case 'code': return `\`${$(el).text().replace(/`/g, '')}\``;
            case 'img': return image(el);
            case 'a': {
                const t = kids().trim();
                const href = $(el).attr('href') ?? '';
                const to = /^(mailto|tel):/i.test(href) ? href.replace(/\s+/g, '') : absolute(href, base);
                return t && to && !t.startsWith('![') ? `[${t}](${to})` : t;
            }
            default: return kids();
        }
    }).join('');
    const tidy = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    const blocks = (nodes: AnyNode[], quote = false): string[] => {
        const out: string[] = [];
        let run: AnyNode[] = [];
        const flush = () => { const t = tidy(inline(run)); if (t) out.push(t); run = []; };
        for (const n of nodes) {
            if (n.type !== 'tag') { run.push(n); continue; }
            const el = n as Element;
            const name = el.name;
            if (/^h[1-6]$/.test(name)) {
                flush();
                const t = tidy(inline(el.children as AnyNode[])).replace(/\n/g, ' ');
                // The post's title is the page's h1; headings inside the body start at ##.
                if (t) out.push(`${'#'.repeat(Math.min(6, Math.max(2, Number(name[1]))))} ${t}`);
            } else if (name === 'p') {
                flush();
                const t = tidy(inline(el.children as AnyNode[]));
                if (t) out.push(t);
            } else if (name === 'ul' || name === 'ol') {
                flush();
                const items = $(el).children('li').toArray().map((li, k) => {
                    const t = tidy(inline(li.children as AnyNode[]).replace(/\n+/g, ' '));
                    return t ? `${name === 'ol' ? `${k + 1}.` : '-'} ${t}` : '';
                }).filter(Boolean);
                if (items.length) out.push(items.join('\n'));
            } else if (name === 'blockquote') {
                flush();
                const inner = blocks(el.children as AnyNode[], true);
                if (inner.length) out.push(inner.map((b) => b.split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n'));
            } else if (name === 'pre') {
                flush();
                const t = $(el).text().replace(/\n+$/, '');
                if (t.trim()) out.push(`\`\`\`\n${t.replace(/```/g, '')}\n\`\`\``);
            } else if (name === 'hr') {
                flush();
                if (!quote) out.push('---');
            } else if (name === 'figure') {
                flush();
                const img = $(el).find('img').get(0);
                const md = img ? image(img) : '';
                const cap = tidy(inline(($(el).find('figcaption').get(0)?.children ?? []) as AnyNode[]));
                if (md) out.push(md);
                if (cap) out.push(`*${cap}*`);
                if (!img) out.push(...blocks(el.children as AnyNode[], quote));
            } else if (name === 'iframe') {
                flush();
                const src = absolute($(el).attr('src'), base);
                if (src) out.push(`[Watch the video](${src})`);
            } else if (name === 'table') {
                flush();
                const rows = $(el).find('tr').toArray().map((tr) => $(tr).children('td, th').toArray().map((c) => tidy(inline(c.children as AnyNode[])).replace(/\n/g, ' ')).filter(Boolean).join(' — ')).filter(Boolean);
                if (rows.length) out.push(rows.join('\n'));
            } else if (name === 'img') {
                run.push(n);
            } else if (['div', 'section', 'article', 'main', 'header', 'span', 'center', 'figcaption', 'details', 'summary'].includes(name) && hasBlockChild(el)) {
                flush();
                out.push(...blocks(el.children as AnyNode[], quote));
            } else if (['div', 'section', 'article', 'main', 'header', 'center', 'details', 'summary'].includes(name)) {
                flush();
                const t = tidy(inline(el.children as AnyNode[]));
                if (t) out.push(t);
            } else {
                run.push(n);
            }
        }
        flush();
        return out;
    };
    const root = $('#bms-root').get(0) as Element;
    const parts = blocks(root.children as AnyNode[]);
    let markdown = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (markdown.length > BLOG_IMPORT_MAX_BODY) {
        const cut = markdown.lastIndexOf('\n\n', BLOG_IMPORT_MAX_BODY);
        markdown = markdown.slice(0, cut > 0 ? cut : BLOG_IMPORT_MAX_BODY).trim();
    }
    return { markdown, images };
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'figure', 'table', 'div', 'section', 'article', 'iframe']);
function hasBlockChild(el: Element): boolean {
    return (el.children as AnyNode[]).some((c) => c.type === 'tag' && BLOCK_TAGS.has((c as Element).name));
}

const wordCount = (md: string) => md.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\]\([^)]*\)/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// ── One post ────────────────────────────────────────────────────────────────────────────────────

/** The main body of a post page, by the names the builders give it — the first that holds words. */
const BODY_SELECTORS = [
    '.entry-content', '.post-content', '.gh-content', '.post-full-content', '.blog-item-content', '.blog-item-content-wrapper',
    '[data-hook="post-description"]', '.post-content__body', '[itemprop="articleBody"]', '.article-content', '.article-body',
    '.single-post-content', '.post-body', '.wp-block-post-content', 'article', 'main', '[role="main"]',
];

export function postSlug(url: string, title: string): string {
    const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
    let last = '';
    try { last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { /* none */ }
    const fromUrl = slugify(last.replace(/\.html?$/i, ''));
    // A bare number (/?p=123, /2024/03/) names nothing — the title does.
    return (fromUrl && !/^\d+$/.test(fromUrl) ? fromUrl : slugify(title)) || 'post';
}

/**
 * One post page (or, when it couldn't be read, the feed's copy) as a post. Null when it holds no
 * words worth a draft. `html` null = the page wasn't read: only the feed's copy is used.
 */
export function readBlogPost(html: string | null, url: string, listed: ListedPost | null): (Omit<ImportedBlogPost, 'featureAssetId' | 'featureAlt'> & { images: MarkdownImage[]; featureImage: MarkdownImage | null }) | null {
    let $: cheerio.CheerioAPI | null = null;
    if (html) { try { $ = cheerio.load(html); } catch { $ = null; } }
    const meta = (sel: string) => ($ ? textOf($(sel).first().attr('content')) : '');

    // The body: the page's own article when it has one with words, else what the feed or API carried.
    let body: { markdown: string; images: MarkdownImage[] } = { markdown: '', images: [] };
    if ($) {
        for (const sel of BODY_SELECTORS) {
            const el = $(sel).first();
            if (!el.length) continue;
            const md = htmlToMarkdown(el.html() ?? '', url);
            if (wordCount(md.markdown) >= MIN_BODY_WORDS) { body = md; break; }
        }
    }
    if (listed?.contentHtml) {
        const fromFeed = htmlToMarkdown(listed.contentHtml, url);
        if (wordCount(fromFeed.markdown) > Math.max(wordCount(body.markdown) * 1.2, MIN_BODY_WORDS - 1) || !body.markdown) body = fromFeed;
    }

    const h1 = $ ? textOf($('h1.entry-title, h1.post-title, h1.gh-article-title, article h1, h1').first().text()) : '';
    const titleTag = $ ? textOf($('title').first().text()).split(/\s[|–—·-]\s/)[0].trim() : '';
    const title = (listed?.title || meta('meta[property="og:title"]') || h1 || titleTag).slice(0, 200);
    if (!title) return null;
    // The page's h1 often opens the body too.
    const firstLine = body.markdown.split('\n')[0].replace(/^#+\s*/, '').trim();
    if (firstLine && firstLine.toLowerCase() === title.toLowerCase()) body.markdown = body.markdown.split('\n').slice(1).join('\n').trim();
    const words = wordCount(body.markdown);
    if (words < 15) return null;

    let ldDate: string | null = null;
    if ($) {
        $('script[type="application/ld+json"]').each((_, el) => {
            if (ldDate) return;
            const m = /"datePublished"\s*:\s*"([^"]+)"/.exec($(el).text());
            if (m) ldDate = isoDate(m[1]);
        });
    }
    const date = isoDate(meta('meta[property="article:published_time"]')) ?? ldDate
        ?? ($ ? isoDate($('article time[datetime], time.entry-date[datetime], time[datetime]').first().attr('datetime')) : null) ?? listed?.date ?? null;

    const ogImage = absolute(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'), url) ?? listed?.image ?? null;
    const featureImage = ogImage && !/^data:/.test(ogImage) ? { src: fullSizeImageUrl(ogImage), alt: meta('meta[property="og:image:alt"]') || title } : null;
    // The feature picture shown again as the body's first picture is shown once.
    if (featureImage && body.images[0] && body.images[0].src === featureImage.src) {
        body.markdown = body.markdown.replace(/^!\[[^\]]*\]\(bms-import-image:0\)\s*/, '').trim();
    }

    const excerpt = (meta('meta[name="description"]') || meta('meta[property="og:description"]') || listed?.summary || '').slice(0, 300) || null;
    const tags = [...new Set([...($ ? $('meta[property="article:tag"]').toArray().map((e) => textOf($!(e).attr('content'))) : []), ...(listed?.tags ?? [])].filter((t) => t && t.length <= 40 && !/^uncategori[sz]ed$/i.test(t)))].slice(0, 8);
    const sourceUrl = url;
    return {
        title, slug: postSlug(sourceUrl, title), sourceUrl, fromPath: redirectKey(new URL(sourceUrl).pathname),
        date, bodyMarkdown: body.markdown, excerpt, tags, words,
        mentionsPrice: statesPrice(body.markdown),
        images: body.images, featureImage,
    };
}

// ── The whole blog, with its fetchers passed in ─────────────────────────────────────────────────

export interface BlogDeps {
    fetchHtml(url: string): Promise<Fetch>;
    fetchJson?(url: string): Promise<Fetch>;
    /** Copy one picture into the library: its asset id, or null. Absent = pictures are left out. */
    savePicture?(src: string, alt: string): Promise<number | null>;
}

async function inTurns<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
        while (next < list.length) { const i = next++; out[i] = await fn(list[i]); }
    }));
    return out;
}

/** Every post of the blog found at `index`, read, with its pictures copied when `deps.savePicture` is given. Never throws. */
export async function readImportedBlog(index: BlogIndexSignal, label: string, deps: BlogDeps): Promise<ImportedBlog> {
    const listed: ListedPost[] = [];
    let source: ImportedBlog['source'] = 'page';
    const take = (items: ListedPost[]) => {
        for (const it of items) {
            if (hostKey(it.url) !== hostKey(index.url) || sameUrl(it.url, index.url) || listed.some((l) => sameUrl(l.url, it.url))) continue;
            listed.push(it);
        }
    };
    // 1. Their feed (the cleanest copy of each post, and its date).
    if (index.feedUrl) {
        const r = await deps.fetchHtml(index.feedUrl).catch(() => null);
        if (r?.ok && /<(rss|feed|rdf:RDF)\b/i.test(r.html)) {
            const items = readFeed(r.html, r.finalUrl);
            if (items.length) { take(items); source = 'feed'; }
        }
    }
    // 2. WordPress lists more than its feed's ten.
    if (listed.length < BLOG_IMPORT_MAX_POSTS && index.wpApi && deps.fetchJson) {
        const api = `${index.wpApi.replace(/\/+$/, '')}/wp/v2/posts?per_page=${BLOG_IMPORT_MAX_POSTS}&_fields=link,title,date,date_gmt,content,excerpt`;
        const r = await deps.fetchJson(api).catch(() => null);
        if (r?.ok) {
            const before = listed.length;
            take(readWpPosts(r.html, r.finalUrl));
            if (listed.length > before && source === 'page') source = 'wordpress';
        }
    }
    // 3. The links on the index page itself.
    take(index.postLinks.map((url) => ({ url, title: null, date: null, contentHtml: null, summary: null, tags: [], image: null })));

    const more = listed.length > BLOG_IMPORT_MAX_POSTS;
    const chosen = listed.slice(0, BLOG_IMPORT_MAX_POSTS);
    const failed: ImportedBlog['failed'] = [];
    const read = await inTurns(chosen, 3, async (it) => {
        const r = await deps.fetchHtml(it.url).catch(() => ({ ok: false as const, message: 'We couldn\'t reach that page just now.' }));
        const post = readBlogPost(r.ok ? r.html : null, r.ok ? r.finalUrl : it.url, it);
        if (!post) failed.push({ url: it.url, title: it.title ?? pathOf(it.url), note: r.ok ? 'We couldn\'t find the words of this post.' : r.message });
        return post;
    });

    // Pictures: feature pictures first (one per post), then those inside the posts, up to the cap.
    const pictures = { copied: 0, failed: 0 };
    let budget = deps.savePicture ? BLOG_IMPORT_MAX_PICTURES : 0;
    const save = async (img: MarkdownImage, fallbackAlt: string): Promise<number | null> => {
        if (budget <= 0 || !deps.savePicture) return null;
        budget--;
        const id = await deps.savePicture(img.src, (img.alt || fallbackAlt).slice(0, 200)).catch(() => null);
        if (id) pictures.copied++; else pictures.failed++;
        return id;
    };
    const posts: ImportedBlogPost[] = [];
    const ok = read.filter((p): p is NonNullable<typeof p> => !!p);
    const featureIds = new Map<number, number | null>();
    for (const [k, p] of ok.entries()) featureIds.set(k, p.featureImage ? await save(p.featureImage, p.title) : null);
    for (const [k, p] of ok.entries()) {
        const ids: Array<number | null> = [];
        for (const img of p.images) ids.push(await save(img, p.title));
        const bodyMarkdown = p.bodyMarkdown.replace(IMAGE_TOKEN, (_m, alt: string, n: string) => {
            const id = ids[Number(n)];
            return id ? `![${alt}](asset://${id})` : '';
        }).replace(/\n{3,}/g, '\n\n').trim();
        const { images: _i, featureImage, ...rest } = p;
        posts.push({ ...rest, bodyMarkdown, featureAssetId: featureIds.get(k) ?? null, featureAlt: featureImage?.alt?.slice(0, 200) ?? null });
    }
    // Two posts wanting the same address: the later one gets -2, -3…
    const seen = new Set<string>();
    for (const p of posts) {
        let s = p.slug; let n = 2;
        while (seen.has(s)) s = `${p.slug.slice(0, 76)}-${n++}`;
        p.slug = s; seen.add(s);
    }
    return { indexUrl: index.url, label, kind: index.kind, source, posts, failed, more, pictures };
}

/** What the Website tab and the chat see of the posts: never their bodies. */
export function blogSummary(blog: ImportedBlog | null | undefined) {
    if (!blog) return null;
    return {
        indexUrl: blog.indexUrl, label: blog.label, kind: blog.kind, source: blog.source, more: blog.more, pictures: blog.pictures, failed: blog.failed,
        posts: blog.posts.map((p) => ({ title: p.title, slug: p.slug, path: p.fromPath, date: p.date, words: p.words, picture: !!p.featureAssetId, mentionsPrice: p.mentionsPrice })),
    };
}
export type ImportedBlogSummary = NonNullable<ReturnType<typeof blogSummary>>;
