# Wix (classic editor)

Adapter `src/utils/site-builders/wix.ts` · test `tests/site-platform-wix.test.ts` · fixtures
`tests/fixtures/site-platforms/wix/` (synthetic: a made-up florist, modelled on Wix's server HTML).
Studied 2026-11-08 on public Wix template demos (wix.com/demone2/…) and one live classic site; nothing
from them is committed. Wix Studio has its own adapter and report.

## How sites on Wix are built
- **Drawn on Wix's server ("Thunderbolt").** A plain fetch gets the words, menu and pictures. The
  browser render is not needed. Desktop and phone layouts are served as separate HTML (the phone one
  goes to a phone user-agent), so a page doesn't carry two copies.
- **Layout:** `#SITE_CONTAINER` > `#masterPage` > `header#SITE_HEADER`, `main#PAGES_CONTAINER`
  (the page's own content), `footer#SITE_FOOTER`. Site-wide strips sit outside main
  (`#soapAfterPagesContainer`). Anchors `#SCROLL_TO_TOP` / `#SCROLL_TO_BOTTOM` say "top of page" /
  "bottom of page". On free plans the Wix banner is `#WIX_ADS`.
- **Words** sit in rich-text boxes: `div.wixui-rich-text[data-testid="richTextElement"]` holding `<p>`,
  `<h1>`–`<h6>` and `<ul>`, each styled by a theme class `font_0`…`font_10`. Newer sites use real
  heading tags. Older sites style titles as `<p class="font_0|2|4…">`. Links in sentences are
  ordinary `<a>` tags. Empty lines are `<span class="wixGuard">&#8203;</span>`.
- **Buttons:** `div#comp-… > a.wixui-button > span.wixui-button__label`.
- **Menu:** `<wix-dropdown-menu class="wixui-dropdown-menu">` > `nav` > `ul` > `li.wixui-dropdown-menu__item`
  > `a` > `p` label. A drop-down's sub-list is `ul.wixui-dropdown-menu__submenu` in a wrapper `div`
  inside the entry. There is also an empty "More" overflow entry and a hidden "Use tab to navigate…" line.
- **Pictures:** `div.wixui-image` > `wow-image[data-image-info]` > `img`. Addresses are
  `static.wixstatic.com/media/<file>/v1/<op>/<params>/<name>`, where op is `fill`/`fit`, can follow a
  `crop/x_,y_,w_,h_` step, and has comma-separated params (`w_490,h_288,al_c,q_80,…,enc_avif,quality_auto`).
  `srcset` has 1x/2x. Pictures below the fold may get a blurred `blur_2` placeholder, or no `src` at
  all, and then the original's file name is only in `data-image-info` JSON (`imageData.uri`). Section
  backgrounds are the same `wow-image` inside `#bgMedia_…`. The default alt is the file name.
- **Look:** the theme sits in an inline `<style>`: palette `--color_0`…`--color_45` as `r,g,b`
  triples, fonts `--font_0`…`--font_10` as CSS `font` shorthand with Wix's own web-font names
  (`avenir-lt-w01_35-light1475496`). `.font_N{font:var(--font_N);color:rgb(var(--color_M))}`. Each
  button has its own rule `#comp-…{--bg:var(--color_18);--rd:24px;…}`. Wix's interface blue `#116dff`
  appears too (banner, editor bits).
- **Embed HTML** boxes come from `<site>.filesusr.com` and are looked up in the page's data file.
  `site-embeds.ts` reads them already.
- **Script data:** `#wix-viewer-model` / `#wix-warmup-data` JSON hold app state (Stores, Bookings, Blog
  widgets). For an ordinary page the words are already in the HTML.
- **Tell-tale:** `<meta name="generator" content="Wix.com Website Builder">`, `static.wixstatic.com`,
  `wixui-*` classes, `id="SITE_CONTAINER"`.

## Already covered
(before this pass, tested against the fixtures)
- Rich-text paragraphs, list items and inline links are read. A box drawn twice is read once.
- "top of page" / "bottom of page", "©…" and "Powered by…" lines are dropped (shared `IMPORT_NOISE`).
- File-name alt text is not used as a description.
- `a.wixui-button` is a button (shared `BUTTONISH`).
- The header and footer are removed (`#SITE_HEADER`, `#SITE_FOOTER`). The email, phone and social
  links in the footer are still read.
- The form's questions (labels) are listed. A Google map becomes "See us on the map".
- Embed HTML boxes (site-embeds.ts).

## Fixed in this pass
All in `wix.ts`, each proved in `tests/site-platform-wix.test.ts`:
- **Pictures with commas in their address.** The shared srcset reader split Wix addresses at every
  comma, so the logo and every picture with a srcset became broken addresses like
  `https://<site>/quality_auto/name.jpg`. This was seen on every live/demo page studied. `prepare`
  now picks the largest srcset entry by splitting only at `, http…`. Test: "pictures come at full size…".
- **Pictures with no src yet** are read from `wow-image[data-image-info]` (same test).
- **Full size keeps the owner's crop.** The shared rewrite turned `…/v1/crop/…/fill/…/name.jpg` into
  a broken address. `fullSizeImage` now gives `…/v1/crop/<crop>/fit/w_1600,h_1600,q_85/<name>`, and
  drops blur and AVIF. Test: "full-size addresses…".
- **Menu groups.** Every entry's class `wixui-dropdown-menu__item` matched the shared sub-menu
  pattern, so each menu entry was put "under" the one before it (seen on every page studied). `prepare`
  removes those class names and moves a real sub-list straight under its entry. Now only real
  drop-downs group ("About" > Our Story, Kind Words). Test: "the menu is in order…".
- **Titles styled as paragraphs** (`p.font_0/2/3/4/5/6`, at most 120 characters, at least 4, not in a
  list, in a box with no heading) become h1–h5 with the same words. "New"/"Sale" ribbons stay text.
  Test: "their words come through…".
- **Wix furniture** removed: `#WIX_ADS` banner ("This site was designed with the Wix.com website
  builder… Start Now"), scroll anchors, the menu's "More" and hidden help line, `.wixGuard` blanks, the
  "Show more" toggle on collapsible text. Noise lines: form thank-yous, "Powered and secured by Wix",
  "Load more", "Show less". Test: "Wix's furniture is not content…".
- **Detection** now also knows `id="SITE_CONTAINER"` and `wixui-*` classes, for pages with no
  generator tag. No false positives on any other saved fixture.
- **The look: `readWixLook(html)`**, exported and tested but **not yet used by the import** (see below).
  It reads the main colour from button fills (most used), then title-style colour, then the theme's
  accent row (`color_18/23/28/33`). Text comes from the paragraph style, the background from `color_11`,
  the second colour from the second button fill, corners from the buttons' `--rd`, and fonts from
  `--font_0`/`--font_7`, with Wix's web-font names tidied (`avenir-lt-w01_35-light…` → `avenir`).
  Today's shared reader takes Wix's interface blue `#116dff` as the brand colour on every Wix site,
  and finds no font. Test: "their look from Wix's theme…". On the bread-shop demo it found the
  template's gold `#b99867`.

## Can be done (not done yet)
- **⚠️ Wix Studio's detect claims every classic Wix page (S, `site-builders/wix-studio.ts`, Wix Studio
  session).** Every Wix page ships the same monitoring script, which contains
  `"Studio"===…editorName?"wix-studio":…`, so `/wix-studio|wixstudio/` matches classic pages. Wix
  Studio is listed first, so today **none of this adapter runs on real classic sites**. Classic
  pages carry `"editorName":"Unknown"`. Studio could test `/"editorName"\s*:\s*"Studio"|[?&]editorName=Studio\b/`.
  I told the Wix Studio session and left a note in the shared notes folder. The test stands Studio
  aside until then and prints a warning.
- **Use `readWixLook` for the look (S, shared: `types.ts`, `site-import.ts`).** Add an optional field
  to `BuilderAdapter`:
  `look?(html: string): Partial<ImportedLook>;` and in `site-import.ts` `readLook`:
  ```ts
  const own = (() => { try { return adapterFor(html, cheerio.load(html))?.look?.(html) ?? null; } catch { return null; } })();
  const base = readImportedLook(html, finalUrl, css);
  return own ? { ...base, ...Object.fromEntries(Object.entries(own).filter(([, v]) => v != null)) } : base;
  ```
  Then in `wix.ts` add `look: readWixLook` to the adapter. (`ImportedLook` would have to be imported
  into `types.ts` as a type only.)
- **Fix the shared srcset reader for every builder (S, `site-extract.ts` `largestFromSrcset`).** Split on
  `/,\s+(?=\S)/` (a comma followed by a space) instead of `','`. Commas inside an address have no space
  after them, and the HTML spec separates entries with a comma plus whitespace. Wix and the Cloudinary-
  and imgix-style CDNs other builders use all put commas in addresses.
- **Logo full size (S, `site-extract.ts`).** The logo uses `fullSizeImageUrl` directly, not the adapter's
  `fullSizeImage`. A cropped Wix logo still gets a broken address. Use the `fullSize` helper there too.
- **Shared Wix rewrite with a crop (S, `site-extract.ts` `fullSizeImageUrl`).** Same bug as above, for
  pages read by other paths (Mystery Shopper). Could call `wixFullSize` or copy its regex.
- **Shared sub-menu pattern (S, `site-extract.ts` `SUBMENU_CLASS`).** `dropdown-menu` followed by `__item`
  should not count. Requiring the match not to be followed by `__item`/`-item` would help other builders
  whose menu entries are named "dropdown-menu-item".
- **Wix Stores / Bookings / Blog widgets (M, `wix.ts` only).** Their content is in `#wix-warmup-data`
  JSON and partly in the HTML. Products carry prices, which we leave off on purpose. Bookings
  services' names and descriptions could become text blocks. Wix Blog posts belong to the separate
  blog-import session.
- **Video boxes (M, `wix.ts`).** Wix's video element puts its YouTube/Vimeo address in page data, not an
  `<iframe>` in the server HTML. `prepare` could find it in the viewer-model JSON and add an `<iframe>`
  so the shared reader makes a "Watch the video" button.
- **Lightboxes (pop-ups) (S).** These are outside main and are skipped. Usually a newsletter sign-up,
  so nothing is lost.

## Can't be done
- **Members-only pages and Wix Stores checkout** are behind a login.
- **Wix Forms submissions and automations** stay in Wix. We list the questions, and our own contact
  form replaces the form.
- **Wix's Velo (custom code) pages** that build content in the browser from a Wix database. The headless
  render may catch some, but the data sits behind Wix's APIs.
- **Embedded third-party widgets** (booking, chat, Instagram feed) are not framed on hosted sites (no
  third parties, no scripts). They become buttons or are listed as not imported.

## Suggested improvements to our import
- The srcset fix above helps every builder whose CDN puts commas in addresses.
- An adapter `look` hook (above) lets each platform read its own theme variables (Squarespace, Webflow
  and Duda keep theirs in named CSS variables too), rather than guessing from colour frequency.
- Run `fullSizeImage` for the logo as well as content pictures.
- `IMPORT_NOISE` applies to buttons but adapter `noise` does not. Testing buttons against
  `adapter.noise` would let platforms drop their own toggle buttons without `prepare`.

## Detection
- Signals: generator contains `wix`, or the HTML has `static.wixstatic.com`, `wix-thunderbolt`,
  `id="SITE_CONTAINER"` or a `wixui-` class.
- No false positives on the other saved fixtures (Squarespace, Webflow, WordPress, bare HTML, SPA
  shell, and any other platform's fixtures present when the test runs).
- False negative in practice: Wix Studio's adapter, listed first, takes every classic page (above).
  A non-Wix page that hotlinks a `static.wixstatic.com` picture would read as Wix. That's harmless:
  `prepare` only touches Wix markup.
