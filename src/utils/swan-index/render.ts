// src/utils/swan-index/render.ts
// The Swan Index — server-rendered pages. Pure functions: data in, HTML string out, no DB and no
// network, so the whole publication is unit-testable without a database.
//
// Server-rendered for the same reason blog-page.ts is: social unfurlers execute no JavaScript, and
// a magazine whose entire product is shareable articles cannot afford to be invisible to them.

import { escHtml } from '../blog-seo';
import {
    STYLESHEET, MOTION_SCRIPT, FONT_CSS_URL, FONT_ORIGINS,
    MASTHEAD, PUBLICATION_NAME, PUBLICATION_TAGLINE, POWERED_BY_HTML,
} from './design';

// ── shared types ───────────────────────────────────────────────────────────────────────────────

export interface SwanSection { key: string; label: string; standfirst?: string | null }

export interface SwanAuthorRef {
    handle: string;
    displayName: string;
    roleTitle?: string | null;
    companyName?: string | null;
    siteUrl?: string | null;
}

/** One piece, as every list surface needs it. */
export interface SwanCard {
    slug: string;
    title: string;
    dek?: string | null;
    section?: string | null;
    sectionLabel?: string | null;
    liveAt?: string | null;          // ISO
    imageUrl?: string | null;
    imageAlt?: string | null;
    author: SwanAuthorRef;
    readCount?: number;
}

export interface SwanHead {
    title: string;
    description: string;
    pageUrl: string;
    canonicalUrl: string | null;
    robots: string;
    imageUrl?: string | null;
    ogType?: 'website' | 'article' | 'profile';
    publishedAt?: string | null;
    authorName?: string | null;
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────────

/** "20 August 2026" — long form, en-GB, matching the reference publications. */
export function formatDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The URL for a piece.
 *
 * `base` is prepended to every internal link on the site, and it is not optional decoration: the
 * publication is served at the root of theswanindex.com but at /index-preview on the app domain
 * before that domain is attached. Root-absolute hrefs ("/latest") are correct on the first and
 * broken on the second — they would escape the prefix and land on the Be More Swan marketing site.
 * Threading the base through the two helpers and the chrome is what keeps one renderer honest on
 * both. Defaults to '' so a caller that only wants the path still gets one.
 */
export function articlePath(handle: string, slug: string, base = ''): string {
    return `${base}/@${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
}

export function authorPath(handle: string, base = ''): string {
    return `${base}/@${encodeURIComponent(handle)}`;
}

/** "Jane Smith, Founder at Acme" — omitting whichever halves are missing. */
export function bylineText(a: SwanAuthorRef): string {
    const at = [a.roleTitle, a.companyName].filter(Boolean);
    if (at.length === 2) return `${a.displayName}, ${at[0]} at ${at[1]}`;
    return at.length ? `${a.displayName}, ${at[0]}` : a.displayName;
}

// ── head ───────────────────────────────────────────────────────────────────────────────────────

export function buildHead(d: SwanHead): string {
    const tags = [
        `<title>${escHtml(d.title)}</title>`,
        `<meta name="description" content="${escHtml(d.description)}">`,
        // Defaults to noindex for syndicated copies; the front page and curated pieces pass
        // 'index,follow' explicitly. See db/swan-index.sql for the reasoning.
        `<meta name="robots" content="${escHtml(d.robots)}">`,
    ];
    if (d.canonicalUrl) tags.push(`<link rel="canonical" href="${escHtml(d.canonicalUrl)}">`);
    tags.push(
        `<meta property="og:type" content="${escHtml(d.ogType || 'website')}">`,
        `<meta property="og:title" content="${escHtml(d.title)}">`,
        `<meta property="og:description" content="${escHtml(d.description)}">`,
        `<meta property="og:url" content="${escHtml(d.pageUrl)}">`,
        `<meta property="og:site_name" content="${escHtml(PUBLICATION_NAME)}">`,
    );
    if (d.imageUrl) tags.push(`<meta property="og:image" content="${escHtml(d.imageUrl)}">`);
    if (d.publishedAt) tags.push(`<meta property="article:published_time" content="${escHtml(d.publishedAt)}">`);
    if (d.authorName) tags.push(`<meta property="article:author" content="${escHtml(d.authorName)}">`);
    tags.push(
        `<meta name="twitter:card" content="${d.imageUrl ? 'summary_large_image' : 'summary'}">`,
        `<meta name="twitter:title" content="${escHtml(d.title)}">`,
        `<meta name="twitter:description" content="${escHtml(d.description)}">`,
    );
    if (d.imageUrl) tags.push(`<meta name="twitter:image" content="${escHtml(d.imageUrl)}">`);
    return tags.join('\n    ');
}

// ── chrome ─────────────────────────────────────────────────────────────────────────────────────

function masthead(base: string): string {
    return `<header class="masthead">
      <div class="wrap masthead__inner">
        <a class="logo" href="${escHtml(base || '/')}" aria-label="${escHtml(PUBLICATION_NAME)} — home">
          <span class="logo__the">${escHtml(MASTHEAD.article)}</span>
          <span class="logo__name">${escHtml(MASTHEAD.name)}</span>
        </a>
        <p class="eyebrow masthead__meta">${escHtml(PUBLICATION_TAGLINE)}</p>
      </div>
    </header>`;
}

function nav(sections: SwanSection[], base: string, current?: string | null): string {
    if (!sections.length) return '';
    const items = sections.map((s) => {
        const active = s.key === current ? ' aria-current="page"' : '';
        return `<a href="${escHtml(base)}/section/${encodeURIComponent(s.key)}"${active}>${escHtml(s.label)}</a>`;
    }).join('');
    return `<nav class="nav" aria-label="Sections"><div class="wrap nav__inner">${items}</div></nav>`;
}

function footer(sections: SwanSection[], base: string): string {
    const secLinks = sections
        .map((s) => `<li><a href="${escHtml(base)}/section/${encodeURIComponent(s.key)}">${escHtml(s.label)}</a></li>`)
        .join('');
    return `<footer class="foot">
      <div class="wrap">
        <div class="foot__grid">
          <div>
            <span class="eyebrow">${escHtml(PUBLICATION_NAME)}</span>
            <p class="foot__note">${POWERED_BY_HTML}</p>
          </div>
          <div><span class="eyebrow">Sections</span><ul>${secLinks}</ul></div>
          <div>
            <span class="eyebrow">Index</span>
            <ul>
              <li><a href="${escHtml(base)}/latest">Latest</a></li>
              <li><a href="${escHtml(base)}/authors">Authors</a></li>
              <li><a href="${escHtml(base)}/feed.xml">RSS</a></li>
            </ul>
          </div>
        </div>
        <div class="foot__rule">
          <p class="foot__note">© ${new Date().getFullYear()} ${escHtml(PUBLICATION_NAME)}. Articles remain the property of their authors and are republished here with permission.</p>
        </div>
      </div>
    </footer>`;
}

export interface ShellOptions {
    head: SwanHead;
    sections: SwanSection[];
    /** Prefix for every internal link — '' in production, '/index-preview' before DNS. */
    base: string;
    currentSection?: string | null;
    /** Structured data for this page, already an object; serialised safely. */
    jsonLd?: Record<string, unknown> | null;
    bodyHtml: string;
}

export function renderShell(o: ShellOptions): string {
    const preconnect = FONT_ORIGINS
        .map((h) => `<link rel="preconnect" href="${escHtml(h)}"${h.includes('gstatic') ? ' crossorigin' : ''}>`)
        .join('\n    ');
    // '<' is escaped so a value containing "</script>" cannot break out of the element.
    const ld = o.jsonLd
        ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, '\\u003c')}</script>`
        : '';

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${buildHead(o.head)}
    ${preconnect}
    <link rel="stylesheet" href="${escHtml(FONT_CSS_URL)}">
    <link rel="alternate" type="application/rss+xml" title="${escHtml(PUBLICATION_NAME)}" href="${escHtml(o.base)}/feed.xml">
    <style>${STYLESHEET}</style>
    ${ld}
  </head>
  <body>
    ${masthead(o.base)}
    ${nav(o.sections, o.base, o.currentSection)}
    <main id="main">${o.bodyHtml}</main>
    ${footer(o.sections, o.base)}
    <script>${MOTION_SCRIPT}</script>
  </body>
</html>`;
}

// ── components ─────────────────────────────────────────────────────────────────────────────────

/** The kicker above a headline: SECTION · DATE. */
function kicker(c: SwanCard): string {
    const bits = [c.sectionLabel || c.section, formatDate(c.liveAt)].filter(Boolean) as string[];
    return bits.length ? `<span class="eyebrow">${bits.map(escHtml).join(' · ')}</span>` : '';
}

/** The oversized lead story. PS Blog's post-card--featured, set in the OM register. */
export function leadStory(c: SwanCard, base = ''): string {
    const href = articlePath(c.author.handle, c.slug, base);
    const fig = c.imageUrl
        ? `<figure class="lead__figure"><a href="${escHtml(href)}"><img src="${escHtml(c.imageUrl)}" alt="${escHtml(c.imageAlt || c.title)}" loading="eager"></a></figure>`
        : '';
    return `<section class="lead"><div class="wrap"><div class="lead__grid">
      <div class="reveal">
        ${kicker(c)}
        <h2 class="serif lead__title"><a href="${escHtml(href)}">${escHtml(c.title)}</a></h2>
        ${c.dek ? `<p class="dek">${escHtml(c.dek)}</p>` : ''}
        <p class="byline"><strong>${escHtml(bylineText(c.author))}</strong></p>
      </div>
      ${fig}
    </div></div></section>`;
}

/** One card in the four-across grid. */
export function card(c: SwanCard, base = ''): string {
    const href = articlePath(c.author.handle, c.slug, base);
    // The box is reserved either way — see .card__figure--empty in design.ts. The plate carries the
    // publication's initials rather than being blank, which is the difference between "this post
    // has no photograph" and "this image failed to load".
    const fig = c.imageUrl
        ? `<figure class="card__figure"><img src="${escHtml(c.imageUrl)}" alt="${escHtml(c.imageAlt || c.title)}" loading="lazy"></figure>`
        : `<div class="card__figure card__figure--empty" data-label="TSI" aria-hidden="true"></div>`;
    return `<article class="card reveal">
      <a href="${escHtml(href)}">
        ${fig}
        ${kicker(c)}
        <h3 class="serif card__title">${escHtml(c.title)}</h3>
        ${c.dek ? `<p class="card__dek">${escHtml(c.dek)}</p>` : ''}
      </a>
      <div class="card__foot">
        <a class="eyebrow" href="${escHtml(authorPath(c.author.handle, base))}">${escHtml(c.author.displayName)}</a>
      </div>
    </article>`;
}

/**
 * The index row — Orchestre Métropolitain's news list, and the publication's namesake unit.
 * Date-led, image-free, one hairline per item.
 */
export function indexRow(c: SwanCard, base = '', opts: { showAuthor?: boolean } = {}): string {
    const href = articlePath(c.author.handle, c.slug, base);
    // Suppressed on an author's own page, where every row would otherwise repeat the name printed
    // in the masthead six inches above it.
    const showAuthor = opts.showAuthor !== false;
    return `<li class="index-row reveal">
      <div class="index-row__meta">
        <span class="eyebrow">${escHtml(formatDate(c.liveAt))}</span>
        ${c.sectionLabel || c.section ? `<span class="eyebrow">${escHtml(c.sectionLabel || c.section || '')}</span>` : ''}
      </div>
      <div>
        <h3 class="serif index-row__title"><a href="${escHtml(href)}">${escHtml(c.title)}</a></h3>
        ${showAuthor ? `<span class="eyebrow">${escHtml(c.author.displayName)}</span>` : ''}
      </div>
      <a class="index-row__plus" href="${escHtml(href)}" aria-label="Read: ${escHtml(c.title)}">Read</a>
    </li>`;
}

function sectionBlock(title: string, inner: string, href?: string): string {
    if (!inner) return '';
    const more = href ? `<a class="eyebrow" href="${escHtml(href)}">All →</a>` : '';
    return `<section class="section"><div class="wrap">
      <div class="section__head"><h2 class="serif section__title">${escHtml(title)}</h2>${more}</div>
      ${inner}
    </div></section>`;
}

function emptyState(title: string, line: string): string {
    return `<div class="wrap empty"><h2>${escHtml(title)}</h2><p>${escHtml(line)}</p></div>`;
}

// ── pages ──────────────────────────────────────────────────────────────────────────────────────

export interface HomeData {
    sections: SwanSection[];
    /** Internal-link prefix; see articlePath(). */
    base: string;
    lead: SwanCard | null;
    featured: SwanCard[];   // curated, minus the lead
    latest: SwanCard[];     // chronological, whole network
    baseUrl: string;
}

export function renderHome(d: HomeData): string {
    const body = (d.lead || d.featured.length || d.latest.length)
        ? [
            d.lead ? leadStory(d.lead, d.base) : '',
            sectionBlock('Featured', d.featured.length ? `<div class="cards">${d.featured.map((c) => card(c, d.base)).join('')}</div>` : ''),
            sectionBlock(
                'The Index',
                d.latest.length ? `<ul class="index-list">${d.latest.map((c) => indexRow(c, d.base)).join('')}</ul>` : '',
                `${d.base}/latest`,
            ),
        ].join('')
        : emptyState('The first issue is in preparation.', 'Nothing has been published yet.');

    return renderShell({
        head: {
            title: `${PUBLICATION_NAME} — ${PUBLICATION_TAGLINE}`,
            description: PUBLICATION_TAGLINE,
            pageUrl: d.baseUrl,
            canonicalUrl: d.baseUrl,
            // The front page is an editorial artefact of our own making, not syndicated content —
            // it is the one surface that indexes by default.
            robots: 'index,follow',
            ogType: 'website',
        },
        sections: d.sections,
        base: d.base,
        jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'Periodical',
            name: PUBLICATION_NAME,
            url: d.baseUrl,
            description: PUBLICATION_TAGLINE,
        },
        bodyHtml: body,
    });
}

export interface ListData {
    sections: SwanSection[];
    /** Internal-link prefix; see articlePath(). */
    base: string;
    heading: string;
    standfirst?: string | null;
    currentSection?: string | null;
    items: SwanCard[];
    pageUrl: string;
    baseUrl: string;
    robots: string;
}

export function renderList(d: ListData): string {
    const body = `<section class="section"><div class="wrap">
      <div class="section__head">
        <div>
          <h1 class="serif section__title">${escHtml(d.heading)}</h1>
          ${d.standfirst ? `<p class="dek">${escHtml(d.standfirst)}</p>` : ''}
        </div>
      </div>
      ${d.items.length
        ? `<ul class="index-list">${d.items.map((c) => indexRow(c, d.base)).join('')}</ul>`
        : `<p class="dek">Nothing here yet.</p>`}
    </div></section>`;

    return renderShell({
        head: {
            title: `${d.heading} — ${PUBLICATION_NAME}`,
            description: d.standfirst || PUBLICATION_TAGLINE,
            pageUrl: d.pageUrl,
            canonicalUrl: d.pageUrl,
            robots: d.robots,
        },
        sections: d.sections,
        base: d.base,
        currentSection: d.currentSection,
        bodyHtml: body,
    });
}

export interface ArticleData {
    sections: SwanSection[];
    /** Internal-link prefix; see articlePath(). */
    base: string;
    author: SwanAuthorRef;
    title: string;
    dek?: string | null;
    sectionKey?: string | null;
    sectionLabel?: string | null;
    liveAt: string | null;
    /** Already-sanitised, media-resolved HTML from blog_posts.published_payload. Not escaped. */
    bodyHtml: string;
    imageUrl?: string | null;
    imageAlt?: string | null;
    /** blog_posts.canonical_url — the author's own copy. THE most important tag on this page. */
    authorCanonicalUrl: string | null;
    pageUrl: string;
    robots: string;
    aiAssisted: boolean;
    aiNotice: string;
    /** More by the same author. */
    more: SwanCard[];
    baseUrl: string;
}

export function renderArticle(d: ArticleData): string {
    const hero = d.imageUrl
        ? `<figure class="wrap article__hero"><img src="${escHtml(d.imageUrl)}" alt="${escHtml(d.imageAlt || d.title)}"></figure>`
        : '';

    const kick = [d.sectionLabel, formatDate(d.liveAt)].filter(Boolean).map(String);

    // The credit line. When the author's own copy exists we name it and link it — this is the
    // promise the whole network rests on, so it is stated in words on the page and not left to a
    // <link> tag no reader can see.
    const firstPublished = d.authorCanonicalUrl
        ? `<p>First published on <a href="${escHtml(d.authorCanonicalUrl)}" rel="canonical bookmark">${escHtml(hostOf(d.authorCanonicalUrl) || 'the author’s site')}</a>. This is a republication.</p>`
        : '';
    const aiLine = d.aiAssisted ? `<p>✦ ${escHtml(d.aiNotice)}</p>` : '';

    const moreBlock = d.more.length
        ? sectionBlock(`More from ${d.author.displayName}`, `<div class="cards">${d.more.map((c) => card(c, d.base)).join('')}</div>`, authorPath(d.author.handle, d.base))
        : '';

    const body = `<article class="article">
      <header class="wrap article__head">
        ${kick.length ? `<span class="eyebrow">${kick.map(escHtml).join(' · ')}</span>` : ''}
        <h1 class="serif article__title">${escHtml(d.title)}</h1>
        ${d.dek ? `<p class="dek article__dek">${escHtml(d.dek)}</p>` : ''}
        <div class="byline">
          <strong><a href="${escHtml(authorPath(d.author.handle, d.base))}">${escHtml(bylineText(d.author))}</a></strong>
          ${d.author.siteUrl ? `<a href="${escHtml(d.author.siteUrl)}" rel="nofollow">${escHtml(hostOf(d.author.siteUrl) || 'Website')}</a>` : ''}
        </div>
      </header>
      ${hero}
      <div class="wrap"><div class="prose">${d.bodyHtml}</div></div>
      <div class="wrap"><div class="provenance">
        ${firstPublished}
        ${aiLine}
        <p>${POWERED_BY_HTML}</p>
      </div></div>
    </article>
    ${moreBlock}`;

    return renderShell({
        head: {
            title: `${d.title} — ${PUBLICATION_NAME}`,
            description: d.dek || `${d.title} — by ${bylineText(d.author)}`,
            pageUrl: d.pageUrl,
            // Point at the author's own copy whenever there is one; fall back to self-canonical.
            canonicalUrl: d.authorCanonicalUrl || d.pageUrl,
            robots: d.robots,
            imageUrl: d.imageUrl,
            ogType: 'article',
            publishedAt: d.liveAt,
            authorName: d.author.displayName,
        },
        sections: d.sections,
        base: d.base,
        currentSection: d.sectionKey,
        jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: d.title,
            ...(d.dek ? { description: d.dek } : {}),
            // mainEntityOfPage is the author's page when they have one — the structured-data
            // counterpart of rel=canonical, and search engines read both.
            mainEntityOfPage: { '@type': 'WebPage', '@id': d.authorCanonicalUrl || d.pageUrl },
            url: d.pageUrl,
            ...(d.imageUrl ? { image: [d.imageUrl] } : {}),
            ...(d.liveAt ? { datePublished: d.liveAt } : {}),
            author: {
                '@type': 'Person',
                name: d.author.displayName,
                ...(d.author.siteUrl ? { url: d.author.siteUrl } : {}),
            },
            publisher: { '@type': 'Organization', name: PUBLICATION_NAME, url: d.baseUrl },
        },
        bodyHtml: body,
    });
}

export interface AuthorData {
    sections: SwanSection[];
    /** Internal-link prefix; see articlePath(). */
    base: string;
    author: SwanAuthorRef & { bio?: string | null; avatarUrl?: string | null };
    items: SwanCard[];
    pageUrl: string;
    baseUrl: string;
    robots: string;
}

export function renderAuthor(d: AuthorData): string {
    const a = d.author;
    const avatar = a.avatarUrl
        ? `<img class="author__avatar" src="${escHtml(a.avatarUrl)}" alt="${escHtml(a.displayName)}">`
        : `<div class="author__avatar" aria-hidden="true"></div>`;

    const body = `<section class="wrap author">
      ${avatar}
      <div>
        <span class="eyebrow">${escHtml([a.roleTitle, a.companyName].filter(Boolean).join(' · ') || 'Contributor')}</span>
        <h1 class="serif author__name">${escHtml(a.displayName)}</h1>
        ${a.bio ? `<p class="author__bio">${escHtml(a.bio)}</p>` : ''}
        <div class="author__links">
          ${a.siteUrl ? `<a class="eyebrow" href="${escHtml(a.siteUrl)}" rel="nofollow">${escHtml(hostOf(a.siteUrl) || 'Website')} →</a>` : ''}
          <span class="eyebrow">${d.items.length} ${d.items.length === 1 ? 'piece' : 'pieces'}</span>
        </div>
      </div>
    </section>
    <section class="section"><div class="wrap">
      ${d.items.length
        ? `<ul class="index-list">${d.items.map((c) => indexRow(c, d.base, { showAuthor: false })).join('')}</ul>`
        : `<p class="dek">No published pieces yet.</p>`}
    </div></section>`;

    return renderShell({
        head: {
            title: `${a.displayName} — ${PUBLICATION_NAME}`,
            description: a.bio || `Articles by ${bylineText(a)} on ${PUBLICATION_NAME}.`,
            pageUrl: d.pageUrl,
            canonicalUrl: d.pageUrl,
            robots: d.robots,
            ogType: 'profile',
        },
        sections: d.sections,
        base: d.base,
        jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'ProfilePage',
            mainEntity: {
                '@type': 'Person',
                name: a.displayName,
                ...(a.roleTitle ? { jobTitle: a.roleTitle } : {}),
                ...(a.siteUrl ? { url: a.siteUrl } : {}),
            },
        },
        bodyHtml: body,
    });
}

/** "acme.com" from "https://acme.com/blog/x", or null when the URL will not parse. */
export function hostOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; }
}
