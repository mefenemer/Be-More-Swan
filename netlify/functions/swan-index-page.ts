// netlify/functions/swan-index-page.ts
// The Swan Index — the whole public publication, server-rendered.
//
// One function rather than six because every route shares the same three preliminaries (parse,
// load the section nav, resolve the base URL) and Netlify bills and cold-starts per function. The
// routing itself is in src/utils/swan-index/route.ts, where it can be tested without a database.
//
//   GET /                     curated front page — lead story, featured grid, the index
//   GET /latest               everything live across the network, newest first
//   GET /section/:key         one section's feed
//   GET /@handle              an author's profile and back catalogue
//   GET /@handle/:slug        the article
//   GET /authors              the contributors index
//   GET /feed.xml             RSS
//   GET /sitemap.xml          indexable URLs only — see getIndexableUrls()
//
// Public and read-only. No tenant context: this is a magazine, and the whole point is that one
// workspace's article sits next to another's. Cross-tenant reads are the FEATURE here, which is
// exactly why every query filters on editorial status and profile status rather than trusting the
// URL — see src/utils/swan-index/queries.ts.

import { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { withLambda } from '@netlify/aws-lambda-compat';
import { parseSwanRoute } from '../../src/utils/swan-index/route';
import {
    listSections, getFeatured, getLatest, getByAuthor, getArticle, listAuthors, getIndexableUrls,
} from '../../src/utils/swan-index/queries';
import {
    renderShell, renderHome, renderList, renderArticle, renderAuthor,
    articlePath, authorPath, bylineText,
} from '../../src/utils/swan-index/render';
import { PUBLICATION_NAME, PUBLICATION_TAGLINE } from '../../src/utils/swan-index/design';
import { swanIndexBaseUrl } from '../../src/utils/swan-index/base-url';
import { getProfileByHandle } from '../../src/utils/swan-index/profile';
import { resolveInlineMedia, resolveFeatureImageUrl } from '../../src/utils/blog-media-resolve';
import { isAiAssisted, BLOG_AI_NOTICE } from '../../src/utils/blog-ai-assisted';
import { escHtml } from '../../src/utils/blog-seo';

// s-maxage stays under the 600s presigned-media lifetime, or a cached page outlives its own images.
// The article route resolves media on every render, so this is the ceiling, not a target.
const CACHE = 'public, max-age=120, s-maxage=300';

const html = (statusCode: number, body: string, cache = false) => ({
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(cache ? { 'Cache-Control': CACHE } : {}) },
    body,
});

const xml = (body: string) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': CACHE },
    body,
});

/** The staging prefix. Mirrors the netlify.toml rule and parseSwanRoute's normalisation. */
const PREVIEW_PREFIX = '/index-preview';

/**
 * Where this request thinks the publication lives.
 *
 * Two answers, and conflating them is the bug this function exists to avoid. On theswanindex.com
 * the publication is at the root and its origin is the real one. On the app domain, before DNS,
 * it is at /index-preview — and there BOTH the internal links and the absolute URLs have to carry
 * that prefix, or the preview links straight out of itself and into the marketing site.
 *
 * `base` is the internal-link prefix; `baseUrl` is the absolute origin+prefix used for canonical,
 * og:url and the feed. In production base is '' and baseUrl is the configured origin.
 */
export function resolveOrigin(pathname: string, rawUrl: string | undefined): { base: string; baseUrl: string } {
    const isPreview = pathname === PREVIEW_PREFIX || pathname.startsWith(`${PREVIEW_PREFIX}/`);
    if (!isPreview) return { base: '', baseUrl: swanIndexBaseUrl() };
    let origin = swanIndexBaseUrl();
    try { if (rawUrl) origin = new URL(rawUrl).origin; } catch { /* keep the configured origin */ }
    return { base: PREVIEW_PREFIX, baseUrl: `${origin}${PREVIEW_PREFIX}` };
}

/** A 404 in the publication's own clothes. noindex, so a dead link is never crawled as thin content. */
function notFound(sections: Awaited<ReturnType<typeof listSections>>, baseUrl: string, base: string) {
    return html(404, renderShell({
        head: {
            title: `Not found — ${PUBLICATION_NAME}`,
            description: 'This page is not available.',
            pageUrl: baseUrl,
            canonicalUrl: null,
            robots: 'noindex,nofollow',
        },
        sections,
        base,
        bodyHtml: `<div class="wrap empty">
          <h2>This page is not in the index.</h2>
          <p>It may have been withdrawn by its author. <a href="${base || '/'}">Return to the front page</a>.</p>
        </div>`,
    }));
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // A Netlify rewrite is a 200, so rawUrl still carries the URL the visitor actually requested —
    // the only place the real path survives. Same reason blog-page.ts reads it.
    const pathname = event.rawUrl ? new URL(event.rawUrl).pathname : (event.path || '/');
    const route = parseSwanRoute(pathname);

    const db = getDb();
    const { base, baseUrl } = resolveOrigin(pathname, event.rawUrl);
    const sections = await listSections(db);

    if (!route) return notFound(sections, baseUrl, base);

    // ── home ───────────────────────────────────────────────────────────────────────────────────
    if (route.kind === 'home') {
        const [featured, latest] = await Promise.all([getFeatured(db, 7), getLatest(db, 24)]);
        const [lead, ...rest] = featured;
        return html(200, renderHome({
            sections,
            base,
            lead: lead ?? null,
            featured: rest,
            // The index excludes what is already above it — a front page that repeats its own lead
            // story four inches further down reads as a bug, because it is one.
            latest: latest.filter((c) => !featured.some((f) => f.slug === c.slug && f.author.handle === c.author.handle)),
            baseUrl,
        }), true);
    }

    // ── latest / section ───────────────────────────────────────────────────────────────────────
    if (route.kind === 'latest' || route.kind === 'section') {
        const key = route.kind === 'section' ? route.key : null;
        const section = key ? sections.find((s) => s.key === key) : null;
        if (key && !section) return notFound(sections, baseUrl, base);

        return html(200, renderList({
            sections,
            base,
            heading: section ? section.label : 'The Index',
            standfirst: section?.standfirst ?? 'Everything published across the network, newest first.',
            currentSection: key,
            items: await getLatest(db, 60, key),
            pageUrl: `${baseUrl}${key ? `/section/${encodeURIComponent(key)}` : '/latest'}`,
            baseUrl,
            // Our own editorial listings, not syndicated content — indexable, unlike the articles.
            robots: 'index,follow',
        }), true);
    }

    // ── authors ────────────────────────────────────────────────────────────────────────────────
    if (route.kind === 'authors') {
        const authors = await listAuthors(db);
        const rows = authors.map((a) => `<li class="index-row reveal">
          <div class="index-row__meta"><span class="eyebrow">${a.pieces} ${a.pieces === 1 ? 'piece' : 'pieces'}</span></div>
          <div>
            <h3 class="serif index-row__title"><a href="${escHtml(authorPath(a.handle, base))}">${escHtml(a.displayName)}</a></h3>
            <span class="eyebrow">${escHtml([a.roleTitle, a.companyName].filter(Boolean).join(' · '))}</span>
          </div>
          <a class="index-row__plus" href="${escHtml(authorPath(a.handle, base))}" aria-label="Read ${escHtml(a.displayName)}">Read</a>
        </li>`).join('');

        return html(200, renderShell({
            head: {
                title: `Contributors — ${PUBLICATION_NAME}`,
                description: `The business owners and operators writing for ${PUBLICATION_NAME}.`,
                pageUrl: `${baseUrl}/authors`,
                canonicalUrl: `${baseUrl}/authors`,
                robots: 'index,follow',
            },
            sections,
            base,
            bodyHtml: `<section class="section"><div class="wrap">
              <div class="section__head"><div>
                <h1 class="serif section__title">Contributors</h1>
                <p class="dek">${escHtml(PUBLICATION_TAGLINE)}</p>
              </div></div>
              ${rows ? `<ul class="index-list">${rows}</ul>` : '<p class="dek">No contributors yet.</p>'}
            </div></section>`,
        }), true);
    }

    // ── author profile ─────────────────────────────────────────────────────────────────────────
    if (route.kind === 'author') {
        const profile = await getProfileByHandle(db, route.handle);
        if (!profile || profile.status !== 'active') return notFound(sections, baseUrl, base);
        const items = await getByAuthor(db, profile.id);

        return html(200, renderAuthor({
            sections,
            base,
            author: {
                handle: profile.handle,
                displayName: profile.displayName,
                roleTitle: profile.roleTitle,
                companyName: profile.companyName,
                siteUrl: profile.siteUrl,
                bio: profile.bio,
                avatarUrl: null,
            },
            items,
            pageUrl: `${baseUrl}${authorPath(profile.handle)}`,
            baseUrl,
            // A profile page is OUR index of an author, not a copy of their writing — nothing here
            // is duplicated from their site, so there is nothing for it to compete with.
            robots: 'index,follow',
        }), true);
    }

    // ── article ────────────────────────────────────────────────────────────────────────────────
    if (route.kind === 'article') {
        const found = await getArticle(db, route.handle, route.slug);
        if (!found) return notFound(sections, baseUrl, base);
        const { row, profileId } = found;

        const profile = await getProfileByHandle(db, route.handle);
        if (!profile) return notFound(sections, baseUrl, base);

        // Resolve the body from the SOURCE post's snapshot, with fresh media URLs — the same
        // read-time resolution blog-page.ts and widget-api.ts perform. This is the payoff of
        // referencing rather than copying: the one syndication target that carries the images.
        const payload = (row.publishedPayload as Record<string, any> | null) || null;
        let bodyHtml: string = (payload && typeof payload.html === 'string') ? payload.html : '';
        if (bodyHtml) bodyHtml = await resolveInlineMedia(db, row.organisationId, bodyHtml);
        // The article renders its own <h1>; the snapshot opens with the post's "# Title" line, and
        // two <h1>s is a malformed outline. Same fix, same reasoning, as blog-seo.ts stripLeadingH1.
        bodyHtml = bodyHtml.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');
        const imageUrl = await resolveFeatureImageUrl(db, row.organisationId, payload?.featureImage?.assetId);

        const more = (await getByAuthor(db, profileId, 4)).filter((c) => c.slug !== route.slug).slice(0, 3);

        return html(200, renderArticle({
            sections,
            base,
            author: {
                handle: profile.handle,
                displayName: profile.displayName,
                roleTitle: profile.roleTitle,
                companyName: profile.companyName,
                siteUrl: profile.siteUrl,
            },
            title: row.title,
            dek: row.dek,
            sectionKey: row.section,
            sectionLabel: row.sectionLabel,
            liveAt: row.liveAt ? row.liveAt.toISOString() : null,
            bodyHtml,
            imageUrl,
            imageAlt: (payload?.featureImage?.alt as string | undefined) || row.title,
            authorCanonicalUrl: row.authorCanonicalUrl,
            pageUrl: `${baseUrl}${articlePath(profile.handle, route.slug)}`,
            // Per-row, defaulting to noindex. An editor lifts a curated piece to 'index,follow'.
            robots: row.robots,
            aiAssisted: isAiAssisted(row),
            aiNotice: BLOG_AI_NOTICE,
            more,
            baseUrl,
        }), true);
    }

    // ── feed ───────────────────────────────────────────────────────────────────────────────────
    if (route.kind === 'feed') {
        const items = await getLatest(db, 40);
        const body = items.map((c) => {
            const url = `${baseUrl}${articlePath(c.author.handle, c.slug)}`;
            return `  <item>
    <title>${escHtml(c.title)}</title>
    <link>${escHtml(url)}</link>
    <guid isPermaLink="true">${escHtml(url)}</guid>
    <dc:creator>${escHtml(bylineText(c.author))}</dc:creator>
    ${c.liveAt ? `<pubDate>${new Date(c.liveAt).toUTCString()}</pubDate>` : ''}
    ${c.dek ? `<description>${escHtml(c.dek)}</description>` : ''}
  </item>`;
        }).join('\n');

        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escHtml(PUBLICATION_NAME)}</title>
  <link>${escHtml(baseUrl)}</link>
  <description>${escHtml(PUBLICATION_TAGLINE)}</description>
  <atom:link href="${escHtml(baseUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
${body}
</channel>
</rss>`);
    }

    // ── robots.txt ─────────────────────────────────────────────────────────────────────────────
    // Crawling is allowed everywhere; INDEXING is decided per page by the meta robots tag, which is
    // the only place it can be decided, because it differs per article. Disallowing paths here would
    // be actively counterproductive: a crawler blocked from an article can never read the noindex on
    // it, so the URL stays eligible to appear in results — the opposite of the intent.
    if (route.kind === 'robots') {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE },
            body: `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`,
        };
    }

    // ── sitemap ────────────────────────────────────────────────────────────────────────────────
    if (route.kind === 'sitemap') {
        const urls = await getIndexableUrls(db);
        const statics = ['', '/latest', '/authors', ...sections.map((s) => `/section/${s.key}`)];
        const entries = [
            ...statics.map((p) => `  <url><loc>${escHtml(baseUrl + p)}</loc></url>`),
            ...urls.map((u) => `  <url><loc>${escHtml(`${baseUrl}${articlePath(u.handle, u.slug)}`)}</loc>` +
                (u.liveAt ? `<lastmod>${u.liveAt.toISOString().slice(0, 10)}</lastmod>` : '') + `</url>`),
        ].join('\n');
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`);
    }

    return notFound(sections, baseUrl, base);
});
