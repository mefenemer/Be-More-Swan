// src/utils/site-builders/windsurf.ts — Website import adapter for Windsurf.
// Findings, what is covered and what is not: docs/site-import-platforms/windsurf.md
// Tests: tests/site-platform-windsurf.test.ts (fixtures in tests/fixtures/site-platforms/windsurf/).
//
// Windsurf is an AI code editor, not a site builder: the page is ordinary framework output (Vite +
// React, Next.js, plain HTML + Tailwind). Its one trace is where App Deploys put it — Netlify, at
// <name>.windsurf.build. So detection reads only the page's OWN address (canonical, og:url) and its
// own files (scripts, stylesheets, icons) on that host; a page that merely talks about Windsurf or
// links to someone's demo is not a Windsurf site. On a custom domain there is no trace at all.
import type { BuilderAdapter } from './types';

/** An address on Windsurf's deploy host. */
const WINDSURF_HOST = /^https?:\/\/[a-z0-9-]+\.windsurf\.build(?:[/:?#]|$)/i;
/** Where a page names its own address or loads its own files from. Never <a href>: that is a link out. */
const OWN_ADDRESS = 'link[rel~="canonical"][href], meta[property="og:url"][content], meta[property="og:image"][content], script[src], link[rel~="stylesheet"][href], link[rel~="icon"][href], link[rel~="preload"][href], link[rel~="modulepreload"][href]';

export const adapter: BuilderAdapter = {
    key: 'windsurf',
    label: 'Windsurf',
    detect: (html, _gen, $) =>
        html.includes('.windsurf.build')
        && $(OWN_ADDRESS).toArray().some((el) => WINDSURF_HOST.test(($(el).attr('href') ?? $(el).attr('src') ?? $(el).attr('content') ?? '').trim())),
    /**
     * Next.js (a common Windsurf output) serves pictures through its resizer, /_next/image?url=…&w=3840:
     * a re-encoded copy. The original is the `url` parameter — a path on the site or a full address.
     */
    fullSizeImage: (src) => {
        try {
            const u = new URL(src);
            if (u.pathname !== '/_next/image') return null;
            const inner = u.searchParams.get('url');
            if (!inner) return null;
            const orig = new URL(inner, u.origin);
            return /^https?:$/.test(orig.protocol) ? orig.toString() : null;
        } catch { return null; }
    },
    // Most Windsurf deploys are Vite + React: an empty <div id="root"> until the JavaScript runs.
    rendersWithJs: true,
};
