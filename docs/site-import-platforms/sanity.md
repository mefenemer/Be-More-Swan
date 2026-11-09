# Sanity

## How sites on Sanity are built
Sanity is a headless CMS: it holds the words and pictures, and the owner's developer builds the
front end. Most of these front ends use Next.js (Sanity's own templates, `next-sanity`). Astro, Remix / React
Router, SvelteKit, Nuxt and Gatsby are the other common ones. So there is no Sanity markup as such, only
traces of it:

- **Pictures** come from `https://cdn.sanity.io/images/<projectId>/<dataset>/<assetId>-<W>x<H>.<ext>`,
  resized by query (`?w=&h=&fit=crop&auto=format`, plus `rect=x,y,w,h` for the editor's crop). The
  original's size is in the file name. They often sit inside the framework's own image route:
  `/_next/image?url=…` (Next.js), `/_image?href=…` (Astro), `/_vercel/image`, `/.netlify/images`,
  `/_ipx/…` (Nuxt), `/cdn-cgi/image/…` (Cloudflare). Vanity names like `…-1200x900.jpg/bench.jpg` are allowed.
- **Words** are written in Portable Text (an array of `{_type:'block', style, listItem, children:[spans],
  markDefs:[links]}`). They are rendered as plain `p`, `h2`–`h6`, `ul/ol > li` and `blockquote` tags, with
  pictures and custom types in between. When a renderer meets a type it has no component for,
  `@portabletext/react` draws a hidden `<div style="display:none">Unknown block type "x", specify a component
  for it in the components.types prop</div>`. That text is in the HTML.
- **Server-drawn (most sites):** Next.js App Router server components, Astro, and Pages Router with
  getStaticProps all send the words in the HTML. **Browser-drawn:** the words are only in page data. That
  means `__NEXT_DATA__` (Pages Router), the RSC payload `self.__next_f.push([1,"…"])` (App Router client
  components, Sanity's live `useQuery` / `initial` pattern), or `window.__remixContext` (Remix).
- **Live preview / Visual Editing:** `data-sanity="id=…;type=…;path=…"` attributes, a `<sanity-visual-editing>`
  overlay, and **stega**: runs of zero-width characters hidden inside every string. They are meant for
  preview only, but some sites leave them switched on in production.
- The menu is whatever the developer wrote, usually `<header><nav>`. Styles are the site's own
  (Tailwind is common), so Sanity adds nothing to the look.

## Already covered
Tested against `tests/fixtures/site-platforms/sanity/` (synthetic, modelled on Sanity's public Next.js
templates and typical Astro and Remix front ends):
- Server-drawn pages read well with no help: headings, paragraphs, list items, quotes, buttons, inline links,
  figure captions, menu, email and phone (`next-ssr-home`, `astro-about`).
- Pictures given directly as `cdn.sanity.io` addresses were found, with their alt text.

What the import got wrong before this pass:
- Browser-drawn pages (`next-pages-shell`, `next-app-rsc-shell`, `remix-shell`) were **not detected** and read
  0–1 words ("Loading…"). Importing them depended on headless Chrome.
- Stega characters ended up in headings and alt text ("Throw your first pot​‌‍​…").
- The hidden "Unknown block type … prop" warning was imported as a paragraph.
- Pictures stayed as `/_next/image?url=…` and `/_image?href=…` on the owner's host, or as small resized
  copies (`?w=600&q=70`).

## Fixed in this pass
All in `src/utils/site-builders/sanity.ts`. Tests are in `tests/site-platform-sanity.test.ts` (10 checks):
- **Detection** now also matches the API hosts (`*.api.sanity.io`, `*.apicdn.sanity.io`), image asset ids
  (`image-<40 hex>-WxH-ext`), `data-sanity` and `<sanity-visual-editing>`, and Portable Text data (`markDefs`
  together with `"_type":"block"`). Browser-drawn shells with no pictures are now recognised. A page that only
  mentions Sanity is not. *(Detection)*
- **Words from page data** (`prepare`). This runs only when the visible page has fewer than 40 words, so a
  server-drawn page is never doubled. It reads Portable Text from `__NEXT_DATA__.props.pageProps`, the RSC
  payload (pushes joined, then each JSON row parsed) and `__remixContext.state.loaderData`. It writes
  ordinary elements into `<main>`: block styles become h1–h6, p and blockquote; bullet and number lists
  become ul and ol; link marks become `<a>`. Section objects add their `heading`/`title` as h2 and plain
  fields (`tagline`, `subtitle`, `description`, `text` and so on) as p. Link, button and CTA objects become
  buttons. Image objects become `<img>`: the address is built from the `asset._ref` plus the project and
  dataset (read from any CDN address or `projectId`/`dataset` in the data), and the alt comes from the
  owner's own `alt` field. It skips SEO, settings, navigation, header and footer data, and the page
  document's own `title` (its menu name). The same field sent twice is read once. Text is escaped, and
  only http(s), mailto, tel, `/` and `#` links are kept. It never fetches and never adds words of its own.
  The rest of the import then needs no headless browser. *(Pages Router / App Router + Remix /
  never-doubled / never-trusted / whole-import tests)*
- **Stega stripped** from text, alt, title and aria-label. Only runs of 4 or more invisible characters
  are removed, so a single ZWJ (emoji) or ZWNJ (Persian) stays. *(stega test)*
- **Portable Text warnings and preview furniture** are removed: the hidden "Unknown … type" div, the
  `<sanity-visual-editing>` overlay, and "Exit preview mode", "Loading…" and "Edit in Studio" lines
  (`noise`). *(server-drawn test)*
- **Full-size pictures** (`fullSizeImage`). Framework wrappers are unwrapped to the inner address. A
  relative inner address resolves against the site, never the CDN. For Sanity images, `rect` (the editor's
  crop), `or` and `flip` are kept and every resize parameter (`w`, `h`, `fit`, `crop`, `fp-x`, `auto`,
  `q`) is dropped. `w=1600&fit=max` is added only when the original or the crop is wider than 1600, the
  same cap as Wix. `cdn.sanity.io/files/…` stays as it is. *(two picture tests)*

## Can be done (not done yet)
- **Logo through the adapter (S, shared: `site-extract.ts`).** The logo uses `fullSizeImageUrl(src)`
  directly, so a Sanity logo keeps `?w=300&h=100` and a `/_next/image` logo stays wrapped. Exact change, in
  `readImportPage`:
  `if (src && /^https?:/.test(src)) logo = { src: fullSize(src), alt: … };` (use the `fullSize` helper
  defined at the top of the function instead of `fullSizeImageUrl`).
- **Unwrap framework image routes for every platform (S, shared: `site-extract.ts` `fullSizeImageUrl`).**
  `/_next/image?url=`, `/_image?href=`, `/_vercel/image?url=`, `/.netlify/images?url=`, `/_ipx/<opts>/<url>`
  and `/cdn-cgi/image/<opts>/<url>` appear on Contentful, Strapi, Payload, v0, Lovable and hand-made sites
  too. `unwrapImage` in `sanity.ts` can move there as is, applied before the per-host rules.
- **SvelteKit and Nuxt page data (M, own file only).** SvelteKit inlines `devalue`-serialised data
  (`__sveltekit_*.resolve` / `data: [...]`, which is JavaScript, not JSON). Nuxt uses `__NUXT_DATA__`, a
  flattened index-reference array. Both are decodable without running scripts. I didn't do it yet because
  no fixture of a browser-drawn SvelteKit or Nuxt Sanity site could be confirmed, and most of these sites
  are server-rendered.
- **React Router 7 turbo-stream data (M, own file only)** (`__reactRouterContext.streamController.enqueue("…")`).
  Same idea as Remix, but in another encoding.
- **Prices in page data (S, own file).** The expanded words pass through the usual price filter in
  `site-import.ts`, as all words do. Nothing Sanity-specific is needed. Noted so nobody adds a second filter.

## Can't be done
- **Reading the dataset through the GROQ API.** A dataset marked *public* can be queried without a token:
  `https://<projectId>.apicdn.sanity.io/v2024-01-01/data/query/<dataset>?query=*[_type=="page"]`. The
  project id and dataset are in every picture address. Only published documents are returned (`drafts.` /
  `versions.` ids need a token). Private datasets return nothing. **Not appropriate to do on our own:**
  (1) it reads the whole content store, not what the owner publishes on their site. That can include
  documents the site never shows: retired pages, other brands, form submissions stored by mistake, staff
  profiles. (2) Every request counts against the owner's Sanity API quota and can be billed as overage.
  (3) robots.txt does not cover it, so our crawler rules give no answer. (4) We couldn't map documents to
  pages without knowing their schema. If it is ever wanted, make it an opt-in "Connect Sanity" where the
  owner pastes a read-only token and picks the document types. Never run it silently on detection.
- **Words a front end fetches after load** (client `fetch` to `apicdn.sanity.io` with nothing in page
  data). The plain read cannot see these, and only headless Chrome (already in place) can.
- **Custom block types' meaning.** `callout`, `pricingTable`, `testimonialSlider` and the like are the
  developer's own schemas. Their string fields are read as paragraphs, but how they were laid out isn't
  known.

## Suggested improvements to our import
- **Page data as a shared step.** Expanding `__NEXT_DATA__`, the RSC payload and Remix context into
  elements helps every Next.js or Remix site that draws in the browser, whatever the CMS (Contentful rich
  text, Strapi blocks, Payload Lexical). The walker in `sanity.ts` (`pageData`) could become
  `site-page-data.ts`, with per-CMS rich-text renderers registered by adapters, saving a headless Chrome
  run per page.
- **Strip stega and other invisible runs in `clean` (S, `site-extract.ts`).** Any Vercel-hosted site with
  `@vercel/stega` has the same problem (Contentful's and DatoCMS's Visual Editing use it too). Exact change:
  `const clean = (s) => (s ?? '').replace(/[​‌‍⁠-⁤﻿]{4,}/g, '').replace(/\s+/g, ' ').trim();`
- **Treat hidden elements as not content (S, `site-extract.ts`).** Remove `[hidden]`, `[aria-hidden="true"]`
  without images, and inline `display:none` before the walk. Renderer warnings and duplicate mobile menus
  live there on many platforms.

## Detection
`detect` matches when the raw HTML has any of the following:
- `cdn.sanity.io`
- `.api.sanity.io` or `.apicdn.sanity.io`
- an image asset id `image-<40 hex>-<W>x<H>-<ext>`
- ` data-sanity=` or ` data-sanity-edit-target=`
- `<sanity-visual-editing`
- Portable Text data: `"markDefs":` together with `"_type":"block"`, escaped or not

Order: Sanity sits after WordPress, Wix, Squarespace and the other site builders and after Contentful
(`index.ts`). A WordPress page that hot-links one Sanity picture stays WordPress, which is correct. A
Lovable, v0 or Bolt site using Sanity becomes `sanity` (they come later). That is the better reading,
because Sanity's data is where its words are. Two rare cases: a page using both Contentful and Sanity
reads as Contentful, and a page that shows Portable Text JSON in a code sample would match (harmless: the
expansion runs only on near-empty pages). Sanity's own website (sanity.io) detects as Sanity, which is
correct.
