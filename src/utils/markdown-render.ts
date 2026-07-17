// src/utils/markdown-render.ts
// Autonomous Content Engine — server-side Markdown → sanitised HTML.
//
// Used at publish time to snapshot blog_posts.body_markdown into blog_posts.published_payload
// (docs/content-engine-epic-plan.md §8). The output renders on THIRD-PARTY customer domains via
// the native widget, so sanitisation is security-critical — a stored-XSS here would execute on a
// customer's site. We render with `marked` then hard-sanitise with `sanitize-html` (allowlist).
//
// The browser editor renders with marked + DOMPurify (workspace.html pattern); this is the
// server counterpart so the persisted snapshot is safe regardless of client behaviour. Both sides
// share ONE directive tokenizer (src/lib/marked-bms-directives.js) so the Studio's preview can't
// disagree with what actually publishes — see docs/blog-media-composition-plan.md §3.2.

import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
// Plain .js, UMD-ish, deliberately shared with the browser — see that file's header.
import { install as installDirectives } from '../lib/marked-bms-directives.js';

// An ISOLATED marked instance: registering extensions on the shared singleton would leak blog
// directives into every other server-side marked caller.
// NOTE: no `resolveUrl` is passed — that is what keeps media src-less in the snapshot. Presigned
// R2 URLs expire and this payload is immutable + CDN-cached, so a baked-in src would produce posts
// whose media 404s hours after publish. widget-api injects a fresh src at read time instead.
const md = installDirectives(new Marked(), {});

// Conservative allowlist — standard long-form blog structure, no scripts/iframes/embeds.
// `video`/`audio`/`source` carry inline media (plan §3.4); `div` exists ONLY for column layouts and
// is gated to the two BMS classes below — a bare or arbitrary-class div must not survive.
const ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'strong', 'em', 'del', 'hr', 'br', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'video', 'audio', 'source', 'div',
];

// The media attribute set is CLOSED and identical in spirit to img's:
//   · NO `src` — the snapshot is src-less by design (see the `md` note above).
//   · NO `autoplay` — an autoplaying video on someone else's page is a hostile default.
//   · NO event handlers — sanitize-html drops unlisted attributes, and `on*` is never listed.
const MEDIA_ATTRS = ['data-bms-asset', 'controls', 'preload', 'width', 'height', 'poster', 'class'];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
        a: ['href', 'title', 'rel', 'target'],
        // data-bms-asset: a stable ref to a content_asset for inline media. We never bake a
        // (short-lived, presigned) URL into this snapshot — widget-api resolves a fresh src at
        // read time. See transformTags.img below and the widget-api inline resolver.
        img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'data-bms-asset', 'class'],
        video: MEDIA_ATTRS,
        audio: MEDIA_ATTRS,
        source: ['type'],                  // src intentionally absent — same rule as video/audio
        div: ['class', 'data-cols'],       // columns only; further narrowed by allowedClasses below
        figure: ['class'],
        code: ['class'], // language-* hints for client-side highlighting
        th: ['scope'],
    },
    // Belt-and-braces over allowedAttributes: even though `class` is permitted on these tags, only
    // BMS layout/media classes survive. Without this, `class` would be an open string attribute on
    // a div we just allowed — a CSS-injection foothold on a customer's own stylesheet.
    allowedClasses: {
        div: ['bms-columns', 'bms-column'],
        figure: ['bms-media-figure'],
        img: ['bms-media', 'bms-media-image', 'bms-align-*'],
        video: ['bms-media', 'bms-media-video', 'bms-align-*'],
        audio: ['bms-media', 'bms-media-audio', 'bms-align-*'],
        code: ['language-*'],
    },
    // Only safe URL schemes; no javascript:/data: (data: images would bypass our media pipeline).
    allowedSchemes: ['http', 'https', 'mailto'],
    // https only for media: the sole case where a real URL appears is a Pexels hotlink
    // (contentAssets.externalUrl), which is always https.
    allowedSchemesByTag: { img: ['http', 'https'], video: ['https'], audio: ['https'], source: ['https'] },
    // Force external links to open safely from the customer's page.
    transformTags: {
        a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
        // Inline media authored as ![alt](asset://N) arrives here as <img src="asset://N">.
        // Rewrite it to a src-less <img data-bms-asset="N"> so the expiring URL is resolved
        // fresh at read time rather than frozen into the cached payload. Real http(s) images
        // (e.g. Pexels hotlinks) pass through unchanged.
        // (`:::media` directives already emit data-bms-asset directly and have no src to rewrite.)
        img: (tagName, attribs) => {
            const m = /^asset:\/\/(\d+)$/.exec((attribs.src || '').trim());
            if (!m) return { tagName, attribs };
            const next: Record<string, string> = { 'data-bms-asset': m[1], alt: attribs.alt || '' };
            if (attribs.title) next.title = attribs.title;
            if (attribs.class) next.class = attribs.class;
            return { tagName: 'img', attribs: next };
        },
        // `data-cols` drives a CSS attribute selector in the widget. The columns renderer already
        // clamps it to 2..3, but this is the last gate before the payload is frozen — re-clamp here
        // rather than trust an upstream invariant we'd have to re-verify on every future edit.
        div: (tagName, attribs) => {
            if (!attribs['data-cols']) return { tagName, attribs };
            const n = parseInt(attribs['data-cols'], 10);
            const next: Record<string, string> = { ...attribs };
            if (n >= 2 && n <= 3) next['data-cols'] = String(n);
            else delete next['data-cols'];
            return { tagName, attribs: next };
        },
    },
};

/**
 * Render Markdown to sanitised, embed-safe HTML.
 * Synchronous: marked is configured for sync parsing (no async extensions here).
 */
export function renderMarkdown(mdSource: string): string {
    const rawHtml = md.parse(mdSource ?? '', { async: false, gfm: true, breaks: false }) as string;
    return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
}

/** Plain-text excerpt (tags stripped, collapsed whitespace) for list views / meta descriptions. */
export function excerpt(mdSource: string, maxChars = 200): string {
    const text = sanitizeHtml(md.parse(mdSource ?? '', { async: false, gfm: true }) as string, {
        allowedTags: [],
        allowedAttributes: {},
    }).replace(/\s+/g, ' ').trim();
    return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '…' : text;
}
