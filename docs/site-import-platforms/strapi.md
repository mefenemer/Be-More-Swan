# Strapi

## How sites on Strapi are built
Strapi is a headless CMS (self-hosted, or Strapi Cloud). It never draws a page: a separate front end
does, usually Next.js (pages router with `__NEXT_DATA__`, or App Router with the `self.__next_f` RSC
payload), Nuxt (`__NUXT_DATA__`, devalue-encoded) or Gatsby (static HTML, data in `page-data.json`).
So there is no generator tag and no Strapi markup in the HTML. Most front ends are server-drawn, so
the words are in the HTML already; menus and footers are the front end's own markup.

What does give it away is the media library:
- Strapi Cloud serves uploads from `<project>.media.strapiapp.com` (strapi.io itself does).
- Every upload's file name ends in a 10-hex-digit hash, and Strapi writes resized copies beside it with
  `thumbnail_` (245px), `small_` (500), `medium_` (750) and `large_` (1000) prefixes:
  `/uploads/medium_shop_counter_0f9e8d7c6b.jpg` next to `/uploads/shop_counter_0f9e8d7c6b.jpg`.
  Self-hosted uploads are under `/uploads/` on the CMS host; S3/Cloudinary providers keep the names.
- The page's data carries Strapi media objects: `{ name, alternativeText, caption, width, height,
  formats: { thumbnail|small|medium|large: { url, size, sizeInBytes, width } }, hash, ext, mime, size
  (kB), url, provider, provider_metadata }`. In the App Router payload the quotes are escaped (`\"`).
- Rich text is Strapi 5 "Blocks" JSON (`[{type:'paragraph', children:[{type:'text', text}]}, …]`) or
  Strapi 4 Markdown; pages are often "dynamic zones" of components (`{ __component: 'sections.hero', … }`).
- Front ends wrap pictures in their own resizer: Next.js `/_next/image?url=<encoded>&w=3840`, Nuxt Image
  `/_ipx/w_750/<url or path>`.

## Already covered
Tested against the synthetic fixtures (a made-up bakery, `tests/fixtures/site-platforms/strapi/`), with
`readImportPage` and `runImport` (fake fetches, `plan` returning null) before this pass:
- Server-drawn pages (Next.js pages router and App Router, Nuxt): headings, paragraphs, list items,
  buttons, menu and logo all read correctly — the generic reader handles them.
- Pictures with a srcset straight from the media library: the largest entry was taken.

What was lost before this pass:
- **Detection**: `/strapi/i` claimed any page that mentions the word (an agency's "we build with Strapi").
  And on the base commit no Strapi page reached this adapter anyway — Magento and HubSpot claimed them
  first (see Detection).
- Next.js pictures stayed as `/_next/image?url=…&w=3840` addresses on the front end, not the picture.
- `medium_…` / `small_…` copies were imported at 750/500 px.
- A huge original (srcset lists it at 4000w; strapi.io does) would be picked even when over the
  import's 8 MB picture limit — so the copy failed and the picture was lost.
- Nuxt `/_ipx/…` addresses stayed as resizer addresses.
- A page drawn in the browser (words only in `__NEXT_DATA__`) read as one word ("Loading…").

## Fixed in this pass
All in `src/utils/site-builders/strapi.ts`, proved by `tests/site-platform-strapi.test.ts` (11 checks):
- **detect** now needs Strapi's media library: a `*.strapiapp.com` host, a resized-upload name with the
  hex hash (also inside an encoded `/_next/image` address), or `alternativeText` + `provider_metadata`
  in the page (plain or escaped). The word "Strapi", a WordPress `medium_…` picture, or a ten-digit
  "hash" (a date) are not enough. *("the word Strapi alone is not a Strapi site…")*
- **fullSizeImage** unwraps `/_next/image?url=` and `/_ipx/<size>/…` (an `/uploads/` path goes onto the
  CMS host named in the page), then turns `medium_x_<hash>.jpg` into `x_<hash>.jpg` — Strapi always
  keeps the original beside its copies. Names without the Strapi hash are left alone; a `javascript:`
  inner address is refused. *("next/image is unwrapped…", "Nuxt Image…", "fullSizeImage leaves…")*
- **prepare** reads every media object in `__NEXT_DATA__` and the App Router payload. When the original
  is over 7.5 MB (the import copies up to 8 MB), the largest resized copy that fits is used instead, so
  the picture still arrives. *("an upload too big to copy…")*
- **prepare** fills a browser-drawn page from `__NEXT_DATA__.props.pageProps` when the HTML has under 40
  words: Blocks (headings, paragraphs, lists, quotes, inline links, pictures), Markdown fields (headings,
  lists, quotes, links, `**` removed), component titles, link components as buttons. `seo`, `global`,
  `navbar`, `footer`, `localizations` branches are skipped; words go in with `.text()`, never as markup;
  only http(s)/mailto/tel/relative links. A server-drawn page is never doubled. This also saves the
  headless browser for such pages. *("a page drawn in the browser…", "words from the data go in as text…")*
- Whole import of three pages: all read, platform `strapi`, words from all three in the draft.

## Can be done (not done yet)
- **Merge the Magento and HubSpot detect fixes before this adapter can work** (S, theirs:
  `site-builders/magento.ts`, `hubspot.ts`; already fixed on their branches). Until then the test patches
  both to their fixed tests while it runs.
- **Logo through the adapter** (S, `site-extract.ts`): the logo uses `fullSizeImageUrl`, so a Next.js
  logo stays `/_next/image?…`. Change line `logo = { src: fullSizeImageUrl(src) …` to use the same
  `fullSize(src)` closure the pictures use. (Magento's branch has done this.)
- **Fall back to the resized address when the full-size copy fails** (S, `site-import.ts` /
  `site-import-store.ts`): when the page data gives no size, `medium_x` → `x` is a guess about bytes; if
  `savePicture(fullSize)` returns null, retry with the address the page showed. Needs ImportBlock to keep
  the original `src` (e.g. `srcShown`).
- **App Router words in the RSC payload** (M): only pictures are read from `self.__next_f` today; closed
  accordions/tabs hold their words only there. The v0 session wrote `readFlight` — move it to a shared
  `site-nextjs.ts` and let Strapi's prepare walk its rows like `__NEXT_DATA__`.
- **Nuxt `__NUXT_DATA__` words** (M, own file only): devalue format (keys point at array indexes);
  needs a small devalue reader before the same walk. Rare: Nuxt is usually server-drawn.
- **Gatsby** (M, shared): `gatsby-source-strapi` sites show `/static/<hash>/…` pictures with no Strapi
  trace; the words are in `/page-data/<path>/page-data.json`, a second fetch the adapter can't make
  (prepare never fetches). Would need an optional `dataUrls(html, url)` adapter hook in `types.ts` and a
  fetch in `site-import.ts` `readPage`.

## Can't be done
- **Reading the Strapi API directly** (`/api/pages?populate=*`): it is usually private (API token) or
  on another host, and the public part has no menu or page order — the front end decides those.
- **Front ends that fetch from Strapi only in the browser** with no data in the HTML (a React SPA):
  nothing to read without the headless browser, which the import already tries under 40 words.
- **Pages behind a login or preview mode** (draft content): not public.

## Suggested improvements to our import
- One shared Next.js helper (`/_next/image` unwrap, `__NEXT_DATA__` / RSC reading) used by every
  headless adapter (Strapi, Contentful, Sanity, Payload) and AI builders (v0, Lovable, Bolt), instead of
  each adapter carrying its own copy.
- Pass the picture size limit (`PICTURE_MAX_BYTES`) through `types.ts` so adapters choosing between an
  original and a resized copy don't hard-code 7.5 MB.
- An adapter test convention for detection order: a shared check that every platform's own fixtures
  come out as that platform through `adapterFor` (not just its own `detect`) would have caught the
  Magento/HubSpot false positives on day one.

## Detection
`detect` (any one):
1. `[a-z0-9-]+.(media.)strapiapp.com` — Strapi Cloud media or API host. No false positives found.
2. `/` or `%2F` + `thumbnail_|small_|medium_|large_` + name + `_` + 10 hex digits holding a letter + an
   image extension. Ten digits alone are rejected (dates, timestamps); this misses about 1% of genuine
   Strapi files whose hash happens to be all digits — another signal usually catches the page.
3. `"alternativeText":` and `"provider_metadata":` both in the page (quotes may be escaped).

False positives found: none in the fixtures (agency page about Strapi, WordPress `medium_` picture).
False negatives: Gatsby sites (pictures re-hosted under `/static/`, no data in the HTML); front ends that
re-host every picture and send no media objects to the page.

On the base commit (eb33994c), two adapters listed before Strapi claim its pages: Magento (`mage\/`
matches inside `image/jpeg` in the page data) and HubSpot (`hs-scripts.com` is HubSpot's tracking code,
which strapi.io itself carries). Both are fixed on those sessions' branches.
