// src/utils/swan-index/render.ts
// The Swan Index — server-rendered pages. Pure functions: data in, HTML string out, no DB and no
// network, so the whole publication is unit-testable without a database.
//
// Server-rendered for the same reason blog-page.ts is: social unfurlers execute no JavaScript, and
// a magazine whose entire product is shareable articles cannot afford to be invisible to them.

import { escHtml } from '../blog-seo';
import { socialEntries, type SocialsMap } from './socials';
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
    /** Validated profile URLs by platform — see socials.ts. Absent on card projections. */
    socials?: SocialsMap | null;
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
    modifiedAt?: string | null;
    authorName?: string | null;
    /** Article only: the masthead section, emitted as article:section. */
    sectionLabel?: string | null;
    /** Article only: the author's own tags, emitted as article:tag. */
    tags?: string[] | null;
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

/**
 * The credit after a name: ["Founder", "Acme"] — either half may be missing.
 *
 * A company equal to the display name is dropped. A profile auto-created from the organisation
 * record used to take BOTH from organisations.name, so every workspace that had never edited its
 * profile published as "Be More Swan, Be More Swan" — the duplication was in the data, and this is
 * the render half of the fix (ensureProfile() no longer writes it; existing rows still have it).
 * Compared case- and space-insensitively: "Acme Ltd" and "acme ltd " are the same company.
 */
export function creditParts(a: SwanAuthorRef): string[] {
    const norm = (s?: string | null) => String(s || '').trim().toLowerCase();
    const company = norm(a.companyName) && norm(a.companyName) !== norm(a.displayName) ? a.companyName : null;
    return [a.roleTitle, company].filter(Boolean).map(String);
}

/** "Jane Smith, Founder at Acme" — omitting whichever halves are missing. */
export function bylineText(a: SwanAuthorRef): string {
    const at = creditParts(a);
    if (at.length === 2) return `${a.displayName}, ${at[0]} at ${at[1]}`;
    return at.length ? `${a.displayName}, ${at[0]}` : a.displayName;
}

/**
 * The author's social links, as icons.
 *
 * rel="nofollow me": "me" is the rel-me convention that lets the author's own site verify the link
 * back, and nofollow is what keeps a masthead full of contributor profiles from being a link farm
 * — the same reasoning that makes syndicated articles noindex by default. The platform name is
 * carried in the accessible name rather than beside the glyph: a reader who can see the icon does
 * not need the word, and a reader who cannot needs more than "link".
 */
export function socialRow(a: SwanAuthorRef, className = 'socials'): string {
    const entries = socialEntries(a.socials);
    if (!entries.length) return '';
    const links = entries.map((e) => `<a class="socials__link" href="${escHtml(e.url)}" rel="nofollow me noopener" target="_blank" title="${escHtml(e.label)}">
        <span class="visually-hidden">${escHtml(a.displayName)} on ${escHtml(e.label)}</span>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">${e.icon}</svg>
      </a>`).join('');
    return `<span class="${escHtml(className)}">${links}</span>`;
}

// ── structured data ────────────────────────────────────────────────────────────────────────────

/**
 * The publication as an entity, in one place.
 *
 * Search engines resolve a site to an entity from the SAME node repeated across its pages, so a
 * publisher block written out three slightly different ways is three weak signals instead of one.
 * No `logo` key: an Organization logo must be a real image URL, and inventing one that 404s is a
 * structured-data error rather than a missing nicety.
 */
export function publisherLd(baseUrl: string): Record<string, unknown> {
    return {
        '@type': 'Organization',
        '@id': `${baseUrl}#publisher`,
        name: PUBLICATION_NAME,
        url: baseUrl,
        description: PUBLICATION_TAGLINE,
    };
}

/** A breadcrumb trail. Google renders it in place of the raw URL in a result. */
export function breadcrumbLd(items: Array<{ name: string; url: string }>): Record<string, unknown> {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: items.map((it, i) => ({
            '@type': 'ListItem', position: i + 1, name: it.name, item: it.url,
        })),
    };
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
    tags.push(`<meta property="og:locale" content="en_GB">`);
    if (d.publishedAt) tags.push(`<meta property="article:published_time" content="${escHtml(d.publishedAt)}">`);
    // Only when it differs: an article:modified_time equal to the publish date tells a crawler an
    // edit happened that did not, and "freshness" claimed and not delivered is worse than silence.
    if (d.modifiedAt && d.modifiedAt !== d.publishedAt) {
        tags.push(`<meta property="article:modified_time" content="${escHtml(d.modifiedAt)}">`);
    }
    if (d.authorName) tags.push(`<meta property="article:author" content="${escHtml(d.authorName)}">`);
    if (d.sectionLabel) tags.push(`<meta property="article:section" content="${escHtml(d.sectionLabel)}">`);
    for (const t of (d.tags || []).slice(0, 8)) tags.push(`<meta property="article:tag" content="${escHtml(t)}">`);
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
              <li><a href="${escHtml(base)}/about">About</a></li>
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
    /**
     * Supplied by the caller, like every other page here — NOT hardcoded.
     *
     * It used to be `'index,follow'` written inline, on the reasoning that the front page is our
     * own editorial work rather than a syndicated copy. True, and beside the point: the caller is
     * the only thing that knows whether this request is even arriving on the publication's own
     * domain. With the code live and DNS mid-cutover the front page answered on two origins, both
     * claiming index,follow and each self-canonical. See robotsFor() in swan-index-page.ts.
     */
    robots: string;
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
            robots: d.robots,
            ogType: 'website',
        },
        sections: d.sections,
        base: d.base,
        jsonLd: {
            '@context': 'https://schema.org',
            '@graph': [
                publisherLd(d.baseUrl),
                {
                    '@type': 'WebSite',
                    '@id': `${d.baseUrl}#website`,
                    name: PUBLICATION_NAME,
                    url: d.baseUrl,
                    description: PUBLICATION_TAGLINE,
                    inLanguage: 'en-GB',
                    publisher: { '@id': `${d.baseUrl}#publisher` },
                },
                // Periodical is the honest type for what this is, and it is what makes the section
                // pages read as parts of one publication rather than as unrelated tag archives.
                {
                    '@type': 'Periodical',
                    '@id': `${d.baseUrl}#periodical`,
                    name: PUBLICATION_NAME,
                    url: d.baseUrl,
                    description: PUBLICATION_TAGLINE,
                    publisher: { '@id': `${d.baseUrl}#publisher` },
                },
            ],
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
        // A CollectionPage whose itemList is the pieces on it. This is what makes a section read as
        // an edited part of the publication rather than a tag archive, which is the distinction
        // search engines apply their scaled-content judgement on.
        jsonLd: {
            '@context': 'https://schema.org',
            '@graph': [
                publisherLd(d.baseUrl),
                breadcrumbLd([
                    { name: PUBLICATION_NAME, url: d.baseUrl },
                    { name: d.heading, url: d.pageUrl },
                ]),
                {
                    '@type': 'CollectionPage',
                    name: d.heading,
                    url: d.pageUrl,
                    ...(d.standfirst ? { description: d.standfirst } : {}),
                    isPartOf: { '@id': `${d.baseUrl}#periodical` },
                    inLanguage: 'en-GB',
                    mainEntity: {
                        '@type': 'ItemList',
                        numberOfItems: d.items.length,
                        itemListElement: d.items.slice(0, 30).map((c, i) => ({
                            '@type': 'ListItem',
                            position: i + 1,
                            url: `${d.baseUrl}${articlePath(c.author.handle, c.slug)}`,
                            name: c.title,
                        })),
                    },
                },
            ],
        },
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
    /** swan_index_posts.updated_at — emitted only when it differs from liveAt. */
    modifiedAt?: string | null;
    /** The author's own tags. Emitted as article:tag and schema keywords, never as navigation. */
    tags?: string[] | null;
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
          ${socialRow(d.author)}
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
            modifiedAt: d.modifiedAt,
            authorName: d.author.displayName,
            sectionLabel: d.sectionLabel,
            tags: d.tags,
        },
        sections: d.sections,
        base: d.base,
        currentSection: d.sectionKey,
        jsonLd: {
            '@context': 'https://schema.org',
            '@graph': [
                publisherLd(d.baseUrl),
                breadcrumbLd([
                    { name: PUBLICATION_NAME, url: d.baseUrl },
                    ...(d.sectionKey && d.sectionLabel
                        ? [{ name: d.sectionLabel, url: `${d.baseUrl}/section/${encodeURIComponent(d.sectionKey)}` }]
                        : []),
                    { name: d.title, url: d.pageUrl },
                ]),
                {
                    '@type': 'BlogPosting',
                    headline: d.title,
                    ...(d.dek ? { description: d.dek } : {}),
                    // mainEntityOfPage is the author's page when they have one — the structured-data
                    // counterpart of rel=canonical, and search engines read both.
                    mainEntityOfPage: { '@type': 'WebPage', '@id': d.authorCanonicalUrl || d.pageUrl },
                    url: d.pageUrl,
                    ...(d.imageUrl ? { image: [d.imageUrl] } : {}),
                    ...(d.liveAt ? { datePublished: d.liveAt } : {}),
                    ...(d.modifiedAt && d.modifiedAt !== d.liveAt ? { dateModified: d.modifiedAt } : {}),
                    ...(d.sectionLabel ? { articleSection: d.sectionLabel } : {}),
                    ...(d.tags?.length ? { keywords: d.tags.slice(0, 12).join(', ') } : {}),
                    inLanguage: 'en-GB',
                    isAccessibleForFree: true,
                    author: {
                        '@type': 'Person',
                        name: d.author.displayName,
                        ...(d.author.siteUrl ? { url: d.author.siteUrl } : {}),
                        ...(socialEntries(d.author.socials).length
                            ? { sameAs: socialEntries(d.author.socials).map((e) => e.url) }
                            : {}),
                    },
                    publisher: { '@id': `${d.baseUrl}#publisher` },
                },
            ],
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
        <span class="eyebrow">${escHtml(creditParts(a).join(' · ') || 'Contributor')}</span>
        <h1 class="serif author__name">${escHtml(a.displayName)}</h1>
        ${a.bio ? `<p class="author__bio">${escHtml(a.bio)}</p>` : ''}
        <div class="author__links">
          ${a.siteUrl ? `<a class="eyebrow" href="${escHtml(a.siteUrl)}" rel="nofollow">${escHtml(hostOf(a.siteUrl) || 'Website')} →</a>` : ''}
          <span class="eyebrow">${d.items.length} ${d.items.length === 1 ? 'piece' : 'pieces'}</span>
          ${socialRow(a, 'socials socials--author')}
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
            url: d.pageUrl,
            isPartOf: { '@id': `${d.baseUrl}#periodical` },
            publisher: publisherLd(d.baseUrl),
            mainEntity: {
                '@type': 'Person',
                name: a.displayName,
                ...(a.roleTitle ? { jobTitle: a.roleTitle } : {}),
                ...(a.siteUrl ? { url: a.siteUrl } : {}),
                // sameAs is how a search engine ties this profile to the author's own accounts.
                // It is the reason the social links are worth collecting at all beyond decoration:
                // the entity credit accrues to the AUTHOR, which is what we promise contributors.
                ...(socialEntries(a.socials).length
                    ? { sameAs: socialEntries(a.socials).map((e) => e.url) }
                    : {}),
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

// ── about ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The publication's own account of itself.
 *
 * Every claim here is one the code actually honours, and that is the constraint the page is written
 * under rather than a nicety: an About page is where a publication is easiest to over-sell, and the
 * two promises below (the canonical credit and the human review) are the two a contributor decides
 * on. If either ever stops being true in the code, this page has to change with it.
 */
export const ABOUT_SECTIONS: Array<{ heading: string; body: string[] }> = [
    {
        heading: 'What this is',
        body: [
            `${PUBLICATION_NAME} is a business magazine written by the people running the businesses — owners, founders and operators publishing what they have actually learned, rather than what an agency thinks their industry wants to read.`,
            'Every piece here first appeared on its author’s own site. We republish it, credit it, and send readers back.',
        ],
    },
    {
        heading: 'The credit goes to the author',
        body: [
            'A syndicated copy that outranks the original is worse than useless to the person who wrote it. So every article on this site names where it first appeared, links to it, and points <code>rel="canonical"</code> at the author’s own URL.',
            'Syndicated pieces are not submitted for indexing by default. Editorial selection is what changes that: a piece the editors choose for the front page is a publication decision, and search engines are told so.',
        ],
    },
    {
        heading: 'A person decides what runs',
        body: [
            'Submissions land in an editors’ queue, not on the site. Someone reads the piece, files it under a section, and decides. Nothing reaches the front page automatically, and an author can withdraw their work at any time — disconnecting the destination takes their back catalogue down with it.',
            'There is a monthly limit on how much any one contributor can publish. It exists to keep this a magazine rather than a content farm.',
        ],
    },
    {
        heading: 'How the writing is made',
        body: [
            `Contributors draft with Be More Swan, which means most pieces here are written by a person working with an AI assistant. Where that is true the article says so, in plain words, at the foot of the page — that is the ${'European AI Act'}’s requirement and, more to the point, what a reader is owed.`,
            'What is never automated is the decision to publish.',
        ],
    },
    {
        heading: 'Writing for us',
        body: [
            'Contributing is open to any Be More Swan workspace: connect The Swan Index as a blog destination, publish on your own site as normal, and the piece is submitted here under your byline.',
        ],
    },
];

export interface AboutData {
    sections: SwanSection[];
    base: string;
    pageUrl: string;
    baseUrl: string;
    robots: string;
}

export function renderAbout(d: AboutData): string {
    const blocks = ABOUT_SECTIONS.map((s) => `<section class="about__block reveal">
      <h2 class="serif about__heading">${escHtml(s.heading)}</h2>
      ${s.body.map((p) => `<p>${p}</p>`).join('')}
    </section>`).join('');

    const body = `<section class="section"><div class="wrap">
      <div class="section__head"><div>
        <span class="eyebrow">About</span>
        <h1 class="serif section__title">${escHtml(PUBLICATION_NAME)}</h1>
        <p class="dek">${escHtml(PUBLICATION_TAGLINE)}</p>
      </div></div>
      <div class="about">${blocks}</div>
      <p class="about__cta"><a href="${escHtml(d.base)}/latest">Read the latest</a> · <a href="${escHtml(d.base)}/authors">Meet the contributors</a></p>
    </div></section>`;

    return renderShell({
        head: {
            title: `About — ${PUBLICATION_NAME}`,
            description: `${PUBLICATION_NAME} republishes business writing by the owners and operators who wrote it, credits the original, and puts a human editor between a submission and the front page.`,
            pageUrl: d.pageUrl,
            canonicalUrl: d.pageUrl,
            robots: d.robots,
            ogType: 'website',
        },
        sections: d.sections,
        base: d.base,
        jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'AboutPage',
            name: `About ${PUBLICATION_NAME}`,
            url: d.pageUrl,
            mainEntity: publisherLd(d.baseUrl),
        },
        bodyHtml: body,
    });
}

// ── the feed's stylesheet ──────────────────────────────────────────────────────────────────────

/**
 * XSLT that turns /feed.xml into a readable page in a browser.
 *
 * The feed was correct all along — valid RSS 2.0, `application/xml`, the right dc:creator — but a
 * browser with no stylesheet renders "This XML file does not appear to have any style information"
 * over a colour-coded document tree, which to anyone who did not come looking for a feed URL looks
 * like the site is broken. A feed reader ignores <?xml-stylesheet?> entirely, so this changes
 * nothing about the feed itself.
 *
 * ⚠️ Browser XSLT support is being wound down (Chrome has announced removal). When that lands this
 * degrades to exactly today's behaviour — the raw tree — and the feed keeps working. It is a
 * presentation nicety with a known end date, not something to build on.
 */
export function renderFeedStylesheet(base: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <meta name="robots" content="noindex,follow"/>
        <title><xsl:value-of select="/rss/channel/title"/> — RSS feed</title>
        <link rel="stylesheet" href="${escHtml(FONT_CSS_URL)}"/>
        <style><![CDATA[${STYLESHEET}
.feed__note { border: 1px solid var(--rule); background: var(--paper); padding: clamp(1.25rem, 3vw, 2rem); margin-bottom: clamp(2rem, 4vw, 3rem); }
.feed__url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--step--1); word-break: break-all; }
        ]]></style>
      </head>
      <body>
        <header class="masthead"><div class="wrap masthead__inner">
          <a class="logo" href="${escHtml(base || '/')}">
            <span class="logo__the">${escHtml(MASTHEAD.article)}</span>
            <span class="logo__name">${escHtml(MASTHEAD.name)}</span>
          </a>
          <p class="eyebrow masthead__meta">RSS feed</p>
        </div></header>
        <main class="section"><div class="wrap">
          <div class="section__head"><div>
            <span class="eyebrow">Subscribe</span>
            <h1 class="serif section__title">This page is a feed</h1>
            <p class="dek">You are looking at the machine-readable version of <xsl:value-of select="/rss/channel/title"/>. Paste its address into any feed reader and new pieces arrive as they publish.</p>
          </div></div>
          <div class="feed__note">
            <span class="eyebrow">Feed address</span>
            <p class="feed__url"><xsl:value-of select="/rss/channel/atom:link/@href" xmlns:atom="http://www.w3.org/2005/Atom"/></p>
            <p><a href="${escHtml(base || '/')}">Read it in a browser instead →</a></p>
          </div>
          <ul class="index-list">
            <xsl:for-each select="/rss/channel/item">
              <li class="index-row">
                <div class="index-row__meta"><span class="eyebrow"><xsl:value-of select="pubDate"/></span></div>
                <div>
                  <h2 class="serif index-row__title">
                    <a><xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute><xsl:value-of select="title"/></a>
                  </h2>
                  <p class="dek"><xsl:value-of select="description"/></p>
                  <span class="eyebrow"><xsl:value-of select="dc:creator"/></span>
                </div>
                <a class="index-row__plus"><xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>Read</a>
              </li>
            </xsl:for-each>
          </ul>
        </div></main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>`;
}
