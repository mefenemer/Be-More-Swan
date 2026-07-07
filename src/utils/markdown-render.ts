// src/utils/markdown-render.ts
// Autonomous Content Engine — server-side Markdown → sanitised HTML.
//
// Used at publish time to snapshot blog_posts.body_markdown into blog_posts.published_payload
// (docs/content-engine-epic-plan.md §8). The output renders on THIRD-PARTY customer domains via
// the native widget, so sanitisation is security-critical — a stored-XSS here would execute on a
// customer's site. We render with `marked` then hard-sanitise with `sanitize-html` (allowlist).
//
// The browser editor renders with marked + DOMPurify (workspace.html pattern); this is the
// server counterpart so the persisted snapshot is safe regardless of client behaviour.

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// Conservative allowlist — standard long-form blog structure, no scripts/iframes/embeds.
const ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'strong', 'em', 'del', 'hr', 'br', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
        a: ['href', 'title', 'rel', 'target'],
        // data-bms-asset: a stable ref to a content_asset for inline media. We never bake a
        // (short-lived, presigned) URL into this snapshot — widget-api resolves a fresh src at
        // read time. See transformTags.img below and the widget-api inline resolver.
        img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'data-bms-asset'],
        code: ['class'], // language-* hints for client-side highlighting
        th: ['scope'],
    },
    // Only safe URL schemes; no javascript:/data: (data: images would bypass our media pipeline).
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    // Force external links to open safely from the customer's page.
    transformTags: {
        a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
        // Inline media authored as ![alt](asset://N) arrives here as <img src="asset://N">.
        // Rewrite it to a src-less <img data-bms-asset="N"> so the expiring URL is resolved
        // fresh at read time rather than frozen into the cached payload. Real http(s) images
        // (e.g. Pexels hotlinks) pass through unchanged.
        img: (tagName, attribs) => {
            const m = /^asset:\/\/(\d+)$/.exec((attribs.src || '').trim());
            if (!m) return { tagName, attribs };
            const next: Record<string, string> = { 'data-bms-asset': m[1], alt: attribs.alt || '' };
            if (attribs.title) next.title = attribs.title;
            return { tagName: 'img', attribs: next };
        },
    },
};

/**
 * Render Markdown to sanitised, embed-safe HTML.
 * Synchronous: marked is configured for sync parsing (no async extensions here).
 */
export function renderMarkdown(md: string): string {
    const rawHtml = marked.parse(md ?? '', { async: false, gfm: true, breaks: false }) as string;
    return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
}

/** Plain-text excerpt (tags stripped, collapsed whitespace) for list views / meta descriptions. */
export function excerpt(md: string, maxChars = 200): string {
    const text = sanitizeHtml(marked.parse(md ?? '', { async: false, gfm: true }) as string, {
        allowedTags: [],
        allowedAttributes: {},
    }).replace(/\s+/g, ' ').trim();
    return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '…' : text;
}
