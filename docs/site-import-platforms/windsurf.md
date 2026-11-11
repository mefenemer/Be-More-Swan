# Windsurf

## How sites on Windsurf are built
Windsurf is an AI code editor (formerly Codeium's; its docs now also appear under Devin Desktop), not a
site builder. What a business ends up with is ordinary framework output that Cascade wrote:
- **Vite + React** (most common): `index.html` is an empty `<div id="root">` plus `/assets/index-<hash>.js`.
  Words, menu and pictures appear only after the JavaScript runs. Tailwind classes, lucide icons as inline
  SVG, framer-motion inline `opacity:0`, heroes drawn with `bg-[url(...)]`.
- **Next.js** (app router, often static export): words in the HTML; pictures through `/_next/image?url=…&w=…`.
- **Plain HTML + Tailwind CDN**: one page with an `#anchor` menu.

**App Deploys** (beta, "intended primarily for preview") upload the build to Netlify under Windsurf's
account, at `<name>.windsurf.build` (also a `.netlify.app` name). The owner can claim the site into their
own Netlify account and add a custom domain. The repo gets a `windsurf_deployment.yaml`, which is never
served. Nothing Windsurf-specific is written into the page itself: no generator tag, no badge, no class
names. Netlify adds headers (`server: Netlify`, `x-nf-request-id`), but adapters only see the HTML.
Source: docs.windsurf.com/windsurf/cascade/app-deploys.

## Already covered
Tested against the synthetic fixtures in `tests/fixtures/site-platforms/windsurf/`:
- Vite shell → 0 words → `runImport` asks `renderHtml` for each page. The rendered page reads well:
  headings (including ones framer-motion hides until scrolled), text, quote, Tailwind `<a>` buttons,
  `bg-[url()]` hero picture, `<img>`, header logo, mailto, Instagram link, menu.
- Next.js export: words, list items, button, `tel:` number and menu read from the plain HTML, with no browser needed.
- One-page HTML: every section is read; the `#anchor` menu adds no pages, which is right for a one-pager.
- lucide SVG icons, `<noscript>` "enable JavaScript" text and the © line are dropped.

## Fixed in this pass
- **Detection tightened.** The old `/windsurf|codeium/i` matched any page that mentioned the editor,
  including a blog post about it. `detect` now needs the page's own canonical, `og:url`/`og:image`, or its
  own scripts, stylesheets, icons or preloads on `https://<name>.windsurf.build`. A plain `<a href>` to a
  demo doesn't count, and neither does a look-alike host. Test: "a page that talks about Windsurf…".
- **Next.js pictures at their original address.** `fullSizeImage` turns `/_next/image?url=%2Fimages%2Fx.jpg&w=3840`
  into `/images/x.jpg` (and an absolute `url=` into that address), so we copy the owner's file, not a
  re-encoded resize. Non-http `url=` values are refused. Test: "Next.js /_next/image pictures…".
- `rendersWithJs: true`, because most deploys are Vite SPAs.

## Can be done (not done yet)
- **Pass the page's address to `detect`** (S, shared: `site-builders/types.ts`, `index.ts` `adapterFor(html, $, url?)`,
  `site-extract.ts` line ~695 `adapterFor(html, $, base)`). The plain Vite shell (`vite-shell-bare.html`)
  has no canonical. Its only trace is the host it is served from (`*.windsurf.build`, also `*.netlify.app`).
  With the URL, windsurf.ts would add `url?.hostname.endsWith('.windsurf.build')`. The same change helps
  Lovable (`*.lovable.app`), Replit (`*.replit.app`), Bolt and v0.
- **⚠️ Magento claims every Vite site** (S, `magento.ts`, owned by the magento session, which has been told).
  `mage\/` matches `image/` in `<link rel="icon" type="image/svg+xml">`, so a Vite shell reads as
  `platform: 'magento'`. That is harmless for words, because the rendered page is re-detected, but the report
  says Magento whenever the rendered read doesn't win. Suggested: `/Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config/`.
- **Move `/_next/image` unwrapping into the shared `fullSizeImageUrl`** (S, `site-extract.ts`). Every Next.js site
  needs it, not only Windsurf ones (Cursor, v0, Claude Code, plain Next). Copy the body of `windsurf.ts`
  `fullSizeImage`, and resolve a relative `url=` against `u.origin`.
- **Hash-router menus** (M, `site-extract.ts` nav walk + `site-import.ts` `pickImportPages`). An SPA using
  `HashRouter` has menu links `#/about`. The nav walk strips the hash, so every page collapses into home
  and only the home page is imported. `#/` links (not plain `#section` anchors) need keeping as distinct
  pages, and `renderHtml` needs to open them.

## Can't be done
- **Recognise Windsurf on a custom domain or a claimed `.netlify.app` site.** The built page carries no
  trace of the editor. Such sites import as generic framework output (the `cursor` / `claude-code` adapters cover those shapes).
- **Read Netlify response headers in `detect`.** Adapters see HTML only, and the header says Netlify, not
  Windsurf. Many non-Windsurf sites use Netlify.
- **Import from the repo** (`windsurf_deployment.yaml`, source files). It isn't served, and we only read public pages.
- **Stock photos.** Cascade often fills sites with Unsplash/placeholder pictures that aren't the owner's.
  We can't tell them from the owner's own photos, so they are copied like any picture when the owner chooses "copy".

## Suggested improvements to our import
- Give `detect` the final URL (see above). It's the single biggest gain for every AI-builder platform, whose
  only reliable trace is the host.
- Unwrap `/_next/image` in the shared code.
- The header logo link's words ("Pebble & Fern") are taken as the Home menu label, because the logo `<a>`
  comes before the real "Home" link. Skip a nav link to `/` whose only content is the logo image and site
  name when another link to `/` follows (S, `site-extract.ts` nav walk).
- In `runImport`, a SPA on Netlify serves the same shell for every path, so every menu page costs a
  headless-browser render. A cache of the shell's hash would let us note "same app, rendered per route"
  in the report, but the renders themselves are still needed.

## Detection
- Signal: an address on `https://<name>.windsurf.build` in the page's `link[rel=canonical]`,
  `meta[property=og:url|og:image]`, `script[src]`, or `link[rel=stylesheet|icon|preload|modulepreload]`.
  A cheap `html.includes('.windsurf.build')` gate runs first.
- False positives checked: blog post naming Windsurf/Codeium with an `<a>` to a `*.windsurf.build` demo
  (not matched); a `windsurf.build.evil.example` canonical (not matched).
- False negatives: any Windsurf site on a custom domain or claimed Netlify name; a bare Vite shell on
  `*.windsurf.build` with no canonical/og tags and relative asset paths. Fixing that one needs the URL passed to `detect`.
- Order: listed after Lovable, Bolt, v0 and Replit and before Cursor and Claude Code. Magento (earlier in
  the list) currently steals Vite shells (see above).
