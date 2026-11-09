# Shopify

Adapter `src/utils/site-builders/shopify.ts` · test `tests/site-platform-shopify.test.ts` · fixtures
`tests/fixtures/site-platforms/shopify/` (synthetic: a Dawn home, collection and contact page for a made-up
candle shop, and a Debut-style "vintage" home page; modelled on Shopify's public Dawn demo shop, no real
business's words or pictures).

## How sites on Shopify are built

- **Server-rendered.** Online Store themes (Dawn and every Online Store 2.0 theme, and the older "vintage"
  themes such as Debut) are drawn from Liquid on Shopify's servers, so the words are in the plain HTML. No
  headless browser needed (`rendersWithJs: false`). Headless "Hydrogen" shops are React apps on Oxygen and
  carry none of the markers below — they would fall through to the generic reader.
- **Sections.** The page is a stack of `<section id="shopify-section-template--…__image_banner"
  class="shopify-section">` (banner, rich text, featured collection, collage, video, multicolumn,
  collapsible content, newsletter, app blocks). The header and footer are section groups
  (`shopify-section-group-header-group` / `…footer-group`). Every theme seen marks the content area
  `#MainContent` (on `<main>` in Dawn and Debut).
- **Menu.** Dawn draws it twice: a phone drawer (`<header-drawer>` › `#menu-drawer`, drop-downs as
  `details > summary + div.menu-drawer__submenu > div.menu-drawer__inner-submenu > ul`) and the desktop menu
  (`nav.header__inline-menu`, drop-downs as `header-menu > details > summary + ul.header__submenu`).
  Debut: `li.site-nav--has-dropdown > button + div.site-nav__dropdown > ul`. Header icons (search, "Log in",
  "Cart" in visually-hidden spans) sit in `.header__icons` / `.site-header__icons`.
- **Pictures.** OS 2.0: on the shop's own domain, `/cdn/shop/files|products|collections/<name>.jpg?v=…&width=533`,
  with a `srcset` up to `&width=3840`. Vintage: `cdn.shopify.com/s/files/1/<shop>/files/<name>_300x300.jpg?v=…`,
  size suffixes (`_300x`, `_x600`, `_600x600_crop_center@2x`, `_grande`, `_master`), and lazysizes
  `data-src="…_{width}x.jpg"` placeholders. Both CDNs resize on `?width=`.
- **Colours and lettering.** Inline `<style>` with colour schemes as **RGB triples**
  (`--color-button: 122,74,46;`, `--color-foreground: …`) plus a hex `--gradient-background`, and fonts as
  `--font-heading-family: Lora, serif;` / `--font-body-family`, served from `/cdn/fonts/`.
- **Products and collections.** Public JSON: `/products.json?limit=250&page=N`,
  `/collections.json`, `/collections/<handle>/products.json`, `/products/<handle>.js(on)`. Each product has
  `title`, `handle`, `body_html`, `product_type`, `vendor`, `tags`, `images[].src`, `variants[]` with
  `title`, `price` ("18.00", no currency), `compare_at_price`, `available`. The currency is in the page:
  `Shopify.currency = {"active":"GBP",…}`.
- **Tell-tales.** `Shopify.theme = {…}` / `Shopify.shop = "x.myshopify.com"` in an inline script,
  `shopify-section`, `<meta name="shopify-checkout-api-token">` / `shopify-digital-wallet`,
  `cdn.shopify.com/shopifycloud/…` scripts, `/cdn/shop/t/<n>/assets/` stylesheets. No generator tag.

## Already covered

Before this pass, on the fixtures (and the real Dawn demo, studied locally): the headings, paragraphs and
banner buttons were read in order; links inside sentences kept; the logo, emails, phone, social links and
footer address read; the contact form's questions read; cart/account/product URLs never fetched as pages
(`SKIP_PATH` in site-import.ts); the multicolumn and FAQ text read.

What was lost or wrong:
- each product card became one garbled item — *"Moorland Heather Candle Sale Moorland Heather Candle 12
  reviews Regular price£18.00 GBP Regular price£22.00 GBP Sale price£18.00 GBP Unit price/ per Choose
  options Close Sale"* — which then went whole into the report's prices list, so the product left the page;
- each card's hover picture imported as a second picture;
- "Slide left", "Slide right", "of", "Load video: …" as buttons/text; the YouTube video lost (Dawn keeps
  the player in a `<template>`, which the reader drops);
- menu: "Log in", "Cart" and pagination ("2") as menu pages; drop-down names lost (the phone drawer is
  read first and its `inner-submenu` wrapper hides the name); Debut drop-downs not grouped either;
- every page "had a form" (search, country picker, newsletter), with "Search", "Email", "Sort by:" as its
  questions;
- collection pages: "Collection: All candles" and "2 products" as headings;
- pictures at `&width=533` (product cards), `_300x300` (vintage) and broken `…_%7Bwidth%7Dx.jpg` addresses;
- the look: no heading font (Lora), no brand colour (only text/background, from `--gradient-background`).

## Fixed in this pass

All in `shopify.ts`, each proved in `tests/site-platform-shopify.test.ts`:
- **detect** on Shopify's own markers, not a bare `cdn.shopify.com` (a hand-made page hot-linking a Shopify
  picture is no longer called Shopify) — *"a page that only hot-links…"*.
- **prepare** removes the furniture: cart drawer/notification, search modal, country/language picker,
  header icons, drawer utility links; product-card prices, badges, quick add, Dawn's hidden duplicate card
  title, hover pictures, review badges (Judge.me, Loox, Yotpo, Okendo, Stamped); slider controls; collection
  count, sorting, paging; Inbox chat; privacy banner; and screen-reader-only text ("Regular price",
  "Collection:", the hidden "Contact form" heading) except where it is a link's only name. Product cards
  now read as their names, linked to the product — *"product cards become their names…"*, *"the cart
  drawer…"*, *"a collection page…"*.
- **One menu, drop-downs named**: the phone drawer goes when the desktop menu is there, else it is
  unwrapped; Debut drop-downs are unwrapped so their names are found — *"the menu is read once…"*,
  *"a phone-only drawer menu…"*.
- **Forms**: search, cart, country and newsletter (`form_type=customer`) forms are removed, so `hasForm`
  and the form's questions mean the enquiry form only — *"search, country and newsletter forms…"*.
- **Video**: Dawn's `deferred-media` template is expanded, so a YouTube/Vimeo video becomes its thumbnail
  and "Watch the video"; a Shopify-hosted video keeps its poster picture (alt without "Load video:").
- **fullSizeImage**: strips `width/height/crop/format` and the size suffixes, decodes `{width}`, and asks
  for `width=2000` (Shopify never upscales) — so one picture is one picture whatever size it was drawn at.
- **contentRoot** `#MainContent`; **noise** for Shopify's lines ("Sold out", "Tax included", "Translation
  missing: …", "Couldn't load pickup availability", …).
- **runImport** end to end with no network and no model: home, collection and contact pages read, cart and
  account never fetched, no price fragments or cart words in the draft — *"runImport reads…"*.

## Can be done (not done yet)

1. **Products & Services from Shopify's product JSON (M).** Prices stay off the site, so instead offer
   "Bring your products into Business Information ▸ Products & Services". After a Shopify import, fetch
   `/products.json?limit=250&page=1…` (cap ~4 pages / 1,000 products) through `site-fetch.ts` (same SSRF
   fence and robots), map each product to a Products & Services row: name = `title`, description =
   `body_html` → text (first ~300 chars), price = lowest available `variants[].price` with currency from
   `Shopify.currency.active` (GBP/USD/EUR/AUD/CAD are supported — `z-product-price-currency.sql`; else leave
   the price blank), "from" when variants differ, picture = `images[0].src` via `shopifyFullSize`, link =
   `/products/<handle>`, category = `product_type`. Show it as a tick-list in the import report (never
   written without the owner's yes; chat proposes, GUI and chat share one server action). Some shops block
   `/products.json` (app or password) — then fall back to the cards' names only. Files: `site-import.ts`
   (an optional `deps.fetchJson` call when `page.platform === 'shopify'`), the report UI, the Business
   Information products store and its chat route. A `BuilderAdapter.catalogue?(base): string[]` hook in
   `types.ts` would keep the URL knowledge here.
2. **The look from Dawn's tokens (S).** In `site-import-theme.ts` `readImportedLook`: read
   `--font-heading-family` / `--font-body-family` as the heading/body fonts, and RGB-triple custom
   properties (`--color-button: 122,74,46`) as colours — `--color-button` (of `:root`) as the primary,
   `--color-foreground` as text, `--color-background` as background; `--buttons-radius` (px) → radius.
   Today the Dawn fixture gives no font and no primary; the real Dawn demo gives `#334fb4`, a colour from
   Shopify's own checkout CSS, not the shop's. Exact change: before `signals.candidates`, match
   `/--color-button\s*:\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})/` in the inline CSS and use its hex when it is
   not near-black/white; `ruleFont` fallback: `/--font-heading-family\s*:\s*([^;]+)/`.
3. **Logo at full size (S).** `site-extract.ts` reads the logo with the shared `fullSizeImageUrl`, not the
   adapter's `fullSize`, so a Shopify logo arrives at `&width=180` / `_300x300`. Change line
   `logo = { src: fullSizeImageUrl(src), …}` to `logo = { src: fullSize(src), …}`.
4. **Noise on headings and buttons (S).** `adapter.noise` is only checked on text blocks; headings and
   buttons use `IMPORT_NOISE` alone. Adding `|| adapter?.noise?.test(t)` to the heading and button checks in
   `readImportPage` would let every platform drop its own heading-shaped furniture without removing
   elements.
5. **Blog posts (S–M).** Shopify blogs live at `/blogs/<blog>/<article>`; `/blogs/news` is read as a page
   today and articles are skipped by `SKIP_PATH` (`/news/…`). The Atom feed `/blogs/<blog>.atom` lists the
   articles — a feed for the blog-import session, not this adapter.
6. **Page builders inside Shopify (M).** PageFly, GemPages and Shogun pages are server-rendered HTML with
   their own class names (`__pf`, `gp-`, `shg-`); they read today through the generic walk, but their
   duplicate mobile/desktop copies are not removed. Needs real samples.

## Can't be done

- **Password-protected shops** (`/password`, `template-password`) and wholesale/B2B pages behind customer
  login: we only read public pages.
- **Checkout, cart and account** pages are Shopify's, not the owner's words — never imported.
- **Selling on the new site**: hosted sites run no scripts and frame no third parties, so no cart, Buy
  Button or Shop Pay. Product names link back to the Shopify shop instead.
- **App widgets drawn by JavaScript** (reviews carousels, Instagram feeds, Klaviyo pop-ups): their words
  are not in the HTML and are another company's content; review text belongs to the customers who wrote it.
- **Shopify-hosted videos** (`/cdn/shop/videos/…mp4`): we import no video files; the poster picture stays.
- **Headless Hydrogen shops**: no Shopify markers in the HTML; they are read by the generic reader and the
  headless browser like any React site.

## Suggested improvements to our import

- Let adapters reach the look (item 2 above) — e.g. `BuilderAdapter.look?(html): Partial<ImportedLook>`
  merged under `readImportedLook`'s result — so builders that keep tokens in odd shapes (Shopify RGB
  triples, Wix's `--color_11`) can say so without touching the shared theme code.
- Use `adapter.noise` for headings and buttons too (item 4), and the adapter's `fullSize` for the logo
  (item 3).
- `SUBMENU_CLASS` in `site-extract.ts` matches `menu-drawer__inner-submenu`, whose label is not before it
  but before its parent; when a sub-menu box has no previous sibling, look at its parent's previous sibling
  too. That would name drop-downs in many drawer menus without per-platform unwrapping.
- `SKIP_PATH` could also skip `/policies/…` (Shopify's refund and shipping policies; privacy and terms
  are already skipped), and treat `/collections/all` as a shop listing rather than a page.

## Detection

`detect` matches any of: `Shopify.theme =` / `Shopify.shop =` (the storefront's inline script),
`shopify-section`, `<meta name="shopify-checkout-api-token">` / `shopify-digital-wallet`,
`cdn.shopify.com/shopifycloud/…`, a theme asset under `cdn.shopify.com/s/files/…/t/<n>/assets/` or
`/cdn/shop/t/<n>/assets/`.

- **False positive fixed:** the old test matched a bare `cdn.shopify.com`, so any page hot-linking a
  picture from Shopify's Files counted as a shop.
- **Order:** Shopify sits after the WordPress, Wix and Squarespace adapters in `index.ts`; a WordPress page
  embedding a Shopify Buy Button loads `sdks.shopifycdn.com`, which matches nothing here anyway.
- **False negative:** Hydrogen (headless) shops — by design.
