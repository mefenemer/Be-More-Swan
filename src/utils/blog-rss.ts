// src/utils/blog-rss.ts
// Pure RSS 2.0 serialisation for the per-widget blog feed (US 3.2, docs/content-engine-remaining-build.md
// §A.4). No DB, no network — the lambda (netlify/functions/widget-rss.ts) does the reads and hands
// the projected values here, the same split as blog-seo.ts behind blog-page.ts.
//
// Deliberately dependency-free so the public lambda can import it without pulling a transitive graph.

/** One feed entry. Every field is already projected/escaped-free text — this module owns escaping. */
export interface RssItemInput {
    title: string;
    /** Where a reader should send someone: the post's canonical URL. */
    link: string;
    /** Stable, permanent identity for the entry — see feedGuid(). */
    guid: string;
    publishedAt: Date | null;
    description: string | null;
    /** Full post HTML for <content:encoded>, or null to ship a headline-only entry. */
    contentHtml: string | null;
    tags: string[];
}

export interface RssChannelInput {
    title: string;
    /** The human-readable site this feed describes. Required by RSS 2.0; may be '' if unknown. */
    link: string;
    description: string;
    /** This feed's own URL, for <atom:link rel="self">. Null when no base URL is resolvable. */
    selfUrl: string | null;
    lastBuildDate: Date | null;
}

/** Escape text destined for an XML text node or attribute (& first, then the angle/quote set). */
export function escXml(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Wrap arbitrary HTML in CDATA safely.
 *
 * A body containing the literal `]]>` would otherwise close the section early and inject raw markup
 * into the feed — the same breakout class as the `</script>` guard on the JSON-LD in blog-seo.ts,
 * and reachable here because post bodies are author-controlled. The fix is to end one section and
 * open another around the offending `>`; parsers rejoin the pieces into the original text.
 */
export function cdata(v: string): string {
    return `<![CDATA[${v.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** RSS 2.0 dates are RFC-822. toUTCString() emits exactly that form ("Tue, 18 Aug 2026 09:00:00 GMT"). */
export function rfc822(d: Date): string {
    return d.toUTCString();
}

/**
 * The stable identity of a feed entry.
 *
 * Deliberately NOT the post's link. A canonical URL changes the moment a customer fills in
 * site_base_url + site_post_path, and a changed guid makes every subscriber's reader re-announce the
 * entire back catalogue as new. This urn depends only on values that are fixed once a post is
 * published, so the same article keeps one identity for its whole life.
 */
export function feedGuid(publicKey: string, slug: string): string {
    return `urn:bms:blog:${publicKey}:${slug}`;
}

/** A well-formed but empty feed — served for an unknown or disabled widget key so a stale subscriber
 *  sees an empty channel rather than a parse error looping in their reader. */
export function emptyRssFeed(): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>'
        + '<title>Not found</title><link/><description/>'
        + '</channel></rss>';
}

function renderItem(item: RssItemInput): string {
    const categories = item.tags
        .filter((t) => t && t.trim())
        .map((t) => `      <category>${escXml(t)}</category>`)
        .join('\n');

    return '    <item>\n'
        + `      <title>${escXml(item.title)}</title>\n`
        + `      <link>${escXml(item.link)}</link>\n`
        + `      <guid isPermaLink="false">${escXml(item.guid)}</guid>\n`
        + (item.publishedAt ? `      <pubDate>${rfc822(item.publishedAt)}</pubDate>\n` : '')
        + (item.description ? `      <description>${escXml(item.description)}</description>\n` : '')
        + (item.contentHtml ? `      <content:encoded>${cdata(item.contentHtml)}</content:encoded>\n` : '')
        + (categories ? `${categories}\n` : '')
        + '    </item>';
}

/** Serialise a complete RSS 2.0 document. */
export function buildRssFeed(channel: RssChannelInput, items: RssItemInput[]): string {
    const body = items.map(renderItem).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" '
        + 'xmlns:atom="http://www.w3.org/2005/Atom">\n'
        + '  <channel>\n'
        + `    <title>${escXml(channel.title)}</title>\n`
        + `    <link>${escXml(channel.link)}</link>\n`
        + `    <description>${escXml(channel.description)}</description>\n`
        + (channel.selfUrl ? `    <atom:link href="${escXml(channel.selfUrl)}" rel="self" type="application/rss+xml"/>\n` : '')
        + (channel.lastBuildDate ? `    <lastBuildDate>${rfc822(channel.lastBuildDate)}</lastBuildDate>\n` : '')
        + '    <generator>Be More Swan</generator>\n'
        + body + (items.length ? '\n' : '')
        + '  </channel>\n'
        + '</rss>';
}
