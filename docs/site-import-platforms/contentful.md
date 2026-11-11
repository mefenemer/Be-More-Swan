# Contentful

## How sites on Contentful are built
Contentful is a headless CMS: it stores the words and pictures, and the owner's developer builds the front
end — usually Next.js (pages router or App Router), sometimes Gatsby, Nuxt, Astro or a plain React app.
So there is no "Contentful markup"; what gives it away is where things come from:

- Pictures from `images.ctfassets.net` (EU spaces: `images.eu.ctfassets.net`), resized by query string
  (`?w=&h=&fit=&f=&r=&fm=webp&q=`). On Next.js they are usually wrapped: `/_next/image?url=<encoded>&w=3840&q=75`.
  Gatsby (`gatsby-plugin-image`) puts a `data:image/jpeg` placeholder first and the real sizes in
  `data-srcset`. Files (PDFs) come from `downloads.ctfassets.net` / `assets.ctfassets.net`.
- Data from `cdn.contentful.com` (REST), `graphql.contentful.com` (GraphQL), `preview.contentful.com`
  (often a `<link rel="preconnect">`).
- The data itself in the page: Next.js pages router puts the entries in `<script id="__NEXT_DATA__">`
  (`{"sys":{"type":"Entry","contentType":{"sys":{"linkType":"ContentType"…}}},"fields":{…}}`); the App
  Router puts props of client components in `self.__next_f.push([1,"…"])` (RSC rows, JSON-escaped).
  Rich text is a JSON tree (`{"nodeType":"document","content":[{"nodeType":"paragraph"…}]}`); over
  GraphQL it is `{json, links:{assets:{block:[…]}, entries:{…}}}` with embedded pictures referenced by id.
- Rich text rendered by `@contentful/rich-text-react-renderer` is plain `p`, `h2`, `ul > li > p`,
  `blockquote`, `table` — nothing builder-specific.

Most Contentful sites are server-rendered (SSG/SSR), so the HTML already holds the words.

## Already covered
Tested against synthetic fixtures (`tests/fixtures/site-platforms/contentful/`, a made-up pottery studio):

- Server-rendered Next.js and Gatsby pages read in order (headings, text, list items, quotes, buttons,
  pictures with their alt text); cookie bars go by the shared rule; Gatsby's base64 placeholder and
  `<noscript>` copy are skipped; the largest `data-srcset` size is taken.

## Fixed in this pass
`src/utils/site-builders/contentful.ts`, proven by `tests/site-platform-contentful.test.ts` (13 checks):

- **Full-size pictures** (`fullSizeImage`): `/_next/image`, `/_vercel/image`, `/.netlify/images` and Nuxt
  `/_ipx/…/https://…` wrappers are unwrapped to the picture inside (a wrapped picture of their own goes
  back to their own file; `javascript:` refused). Contentful Images API addresses lose their crop /
  thumbnail / radius / format parameters and ask for `?w=1600&q=85` — the original at a sensible size,
  well under the 8 MB picture cap. HEIC/TIFF/AVIF originals are asked for as `fm=jpg` (our picture copier
  accepts only jpeg/png/webp/gif); GIFs are left alone (animation); `downloads.` files lose their query.
  Before: a 600px webp, a 120px face-cropped circle, or a `/_next/image` URL on their host.
- **Client-only pages** (`prepare`): when the page shows under 40 words (what would otherwise send it to
  headless Chrome), the owner's Contentful entries the page already carries are laid out as ordinary
  elements — from `__NEXT_DATA__` (REST, links resolved) and the App Router RSC payload (GraphQL
  `{json, links}`, embedded pictures resolved by id). Rich text keeps headings, paragraphs, lists,
  quotes, tables and links (http(s), mailto, tel, their own pages only); entries give their
  headline/title (first one H1), subheadline/intro/description, pictures (with the asset's description
  as alt) and label+url call-to-action buttons. Navigation, menu, header/footer, SEO/metadata, settings
  and cookie entries are skipped, as are CMS-only fields (internalName, slug, ids, styles). All values are
  escaped — a `<script>` typed into rich text stays words. Before: 0 words on both fixtures.
  `runImport` now reads all three Next.js fixture pages with no headless browser call.
- `detect` also recognises Contentful from its API hosts and its JSON shapes (raw or escaped in RSC), so
  a site with no pictures is still found. `noise` drops "Powered by Contentful".

## Can be done (not done yet)
- **Magento's `detect` claims Contentful pages** (S, `site-builders/magento.ts`, Magento session /
  main): `/mage\//` matches the end of `image/`, so any page with `data:image/jpeg` (every Gatsby site),
  `"contentType":"image/jpeg"` (Contentful/Sanity/Strapi JSON) or `<source type="image/webp">` is read as
  Magento, and every adapter after Magento in `index.ts` never runs. Fix: `/Magento_|(?<![a-z])mage\/|requirejs-config/`.
  Told the Magento session; the page-level tests here run with that fix stubbed in (`withMagentoFixed`).
  Until it lands, the Gatsby and `__NEXT_DATA__` fixtures are read by Magento (no harm, but no Contentful help).
- **Logo through the adapter** (S, `site-extract.ts` line ~763): the logo uses the shared
  `fullSizeImageUrl(src)`; change to the `fullSize` helper already defined in `readImportPage`:
  `logo = { src: fullSize(src), … }`. Then a Next.js logo is copied from ctfassets, not `/_next/image`.
- **Unwrap `/_next/image` for every platform** (S, `site-extract.ts` `fullSizeImageUrl`): any Next.js site
  (Lovable, v0, Payload, Sanity…) has the same wrapper. Moving the `unwrap` step from this adapter into the
  shared function would help all of them.
- **Owner connects their Contentful space** (M–L, new connector + `site-import.ts` deps): the Content
  Delivery API needs the owner's space id and a delivery token. With them, the import could read every
  entry of type page/post directly — every page (not just the 8 linked from the menu), blog posts, alt
  text, and pages whose content is fetched in the browser after load (which no page data carries). Would
  touch `site-import.ts` (a `fetchEntries` dep), a connector/settings screen and the SSRF allow-list
  (`cdn.contentful.com`). Never use a token found in their JavaScript bundle without their say-so.
- **Nuxt `__NUXT_DATA__`** (S, this file): Nuxt 3 payloads use the devalue format (a flat array of
  references); a small reviver would let `prepare` read client-only Nuxt pages too. Not done — Nuxt sites
  almost always server-render, so the payload is rarely the only copy.

## Can't be done
- **Content fetched in the browser after load** (a React SPA calling `cdn.contentful.com` from JS): nothing
  is in the HTML or its data scripts. The headless browser fallback (`site-js-render.ts`) reads it as it
  does any SPA; otherwise only an owner-connected space would.
- **Drafts and preview content**: behind the Preview API token — not public, not imported.
- **Embedded entries the front end renders its own way** (cards, carousels, pricing tables): the RSC payload
  holds only what the page needs; we lay out their text fields, never the developer's design. Prices in
  such entries are still stripped later by the shared price rule.
- **Videos** (`videos.ctfassets.net`): we play no one else's player and copy pictures only.

## Suggested improvements to our import
- A shared helper that reads `__NEXT_DATA__` / RSC rows into JSON once (here `pageData`) would serve the
  Sanity, Strapi, Payload, Lovable and v0 adapters too — each repeats it otherwise.
- Make the picture copier ask the Images API for `fm=jpg` when a fetched picture comes back as AVIF
  (it is refused today by `PICTURE_TYPES`), for every CDN that negotiates format by `Accept`.

## Detection
`detect` = any of: `ctfassets.net` anywhere; `cdn.` / `preview.` / `graphql.` (`.eu`) `contentful.com`;
`"linkType":"Space|ContentType|Environment"` raw or JSON-escaped. Contentful sits after the page builders
in `index.ts`, so a WordPress or Wix site showing a ctfassets picture stays WordPress/Wix (tested).
False positive: a hand-made site that only hot-links one ctfassets picture (e.g. a partner badge) gets this
adapter — harmless: `prepare` only acts on thin pages with Contentful data, and `fullSizeImage` only
touches ctfassets and image-proxy addresses. False negative: see Magento above.
