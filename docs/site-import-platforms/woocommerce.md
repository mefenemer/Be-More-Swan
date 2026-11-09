# WooCommerce

Adapter `src/utils/site-builders/woocommerce.ts` · test `tests/site-platform-woocommerce.test.ts` (17 checks) ·
fixtures `tests/fixtures/site-platforms/woocommerce/` (synthetic: an invented candle shop on Storefront, and an
invented pottery shop on a block theme). Written 2026-11-09.

## How sites on WooCommerce are built
- A free plugin for **WordPress**. Every page is a WordPress page rendered on the server: the words arrive in the
  HTML, so no JavaScript is needed to read them. The exceptions are the Cart and Checkout blocks (React; we never read
  those pages) and the old "All Products" block (React, rare now).
- **Classic themes** (Storefront, Astra, Neve, Kadence, OceanWP…): product grids are `ul.products > li.product`, and
  each card is one `a.woocommerce-LoopProduct-link` around the picture (`img.attachment-woocommerce_thumbnail`),
  the name (`h2.woocommerce-loop-product__title`) and the price (`span.price`, with `<del>`/`<ins>` for a sale and
  `.screen-reader-text` copies like "Original price was: £22.00."). Next to it is a button: `a.add_to_cart_button`
  (`?add-to-cart=ID`), "Select options" or "Read more". Category tiles are `li.product-category` with a
  `mark.count` "(6)".
- **Block themes** (Twenty Twenty-Four/Five and others): the Product Collection block (`li.wc-block-product`,
  `h3.wp-block-post-title a`, `.wc-block-components-product-price`, `.wc-block-components-product-button`), the
  Mini-Cart block (`.wp-block-woocommerce-mini-cart`), the Customer Account block, the Store Notices block.
- **Product page** (`body.single-product`): gallery `.woocommerce-product-gallery__image`. The full-size picture is in
  `img[data-large_image]` and the surrounding `<a href>`, while `src` is a 600×600 copy. Then `.summary`: title,
  price, short description, `form.cart`, `.product_meta` (SKU/Category). Then `.woocommerce-tabs` (tab labels,
  a Description panel with a "Description" heading, Additional information as a table, Reviews with a form). Then
  `section.related.products`. The page also carries schema.org `Product` JSON-LD.
- **Shop page** (`/shop/`): `.woocommerce-products-header` (the title and the owner's description), sorting form,
  "Showing 1–12 of 30 results", pagination, and a sidebar of shop widgets.
- **Menu**: an ordinary WordPress menu. Category entries carry `li.menu-item-object-product_cat`. The header holds a
  mini-cart ("£0.00 0 items"), and often "My account" and product search.
- **Pictures**: WordPress uploads, with resized copies named `-324x324.jpg` and `-scaled.jpg` for the big-image
  version. Many shops serve them through Jetpack's CDN (`i0.wp.com/…?resize=324,324`) or Optimole
  (`*.i.optimole.com/w:324/…/https://site/…`).
- **Look**: theme customiser CSS is inline (`#storefront-style-inline-css`). Block themes use
  `--wp--preset--color--*` in `#global-styles-inline-css`.
- **Telling it apart**: `<meta name="generator" content="WooCommerce x.y">`, which comes *after* WordPress's, so the
  first-generator `gen` never shows it. Also `/wp-content/plugins/woocommerce/` assets, and body class
  `woocommerce-no-js`/`-js` on **every** page of the site (content pages too). Then `wc_add_to_cart_params`, and
  `wp-block-woocommerce-*` / `wc-block-*`. Default addresses: `/shop/`, `/product/<slug>/`,
  `/product-category/<slug>/`, `/cart/` (`/basket/` in en-GB), `/checkout/`, `/my-account/`.
- Real shops (3 public theme demos I looked at, all WooCommerce 9–11) very often also use **Elementor**.

## Already covered
(Before this pass, measured on the fixtures with `readImportPage`/`runImport`, no network and no model.)
- The owner's headings, paragraphs, inline links, Gutenberg buttons, quotes and CSS background pictures, and an
  ordinary page's words. These are WordPress markup and the shared reader handles them.
- Contact details from JSON-LD, the logo, social links, and drop-downs (`ul.sub-menu`) labelled "Shop".
- Colours: Storefront's inline brand colour, and a block theme's preset palette (primary, text, background). Tested.
- Cart, checkout, account and `/product/…` pages were already skipped by `SKIP_PATH`. The product page's JSON-LD
  already gave one product with its price.

What was lost or wrong:
- **Product names were lost.** Each card became one list item ("Sale! Moorland Heather candle Rated 5.00 out of 5
  £22.00 Original price was: … Add to basket"). Because it stated a price, the whole item went to the price list.
- Menu got "£0.00 0 items", "My account", "Login" and the pagination "2".
- Pictures came in at 324×324 / 600×600, or as CDN-resized copies.
- Stray lines: "Showing 1–3 of 9 results", "View basket … has been added to your basket", category counts "(6)".
  On product pages: "Sale!", star ratings, stock, SKU/Category, tab labels, "Weight 0.4 kg", "Add a review",
  "Related products" and the related cards.
- The `detect` matched any page with the lower-case word "woocommerce", including a WordPress blog post about it.

## Fixed in this pass
- **Detection** looks only at markup WooCommerce writes: its generator tag anywhere, plugin assets, body classes,
  script settings and blocks. A WordPress post that only mentions WooCommerce stays WordPress. *Tests: "every
  WooCommerce page…", "a WordPress blog post…", "signals…"*
- **Product cards** (classic and Product Collection) are rebuilt as one list item each: the full-size picture plus the
  product name linked to its page. Price, sale badge, stars and basket/"Select options"/"Read more" buttons are gone.
  Category tiles lose their counts. *Test: "a product card becomes…"*
- **Products for Business Information** (`products` hook): name, price as shown (current price of a sale; ranges
  such as "£12.00 – £24.00" kept), product page and full-size picture, from cards and from a product page.
  `runImport` lists them in `report.products`, and no price reaches the draft. *Tests: "cards give…", "a product
  page gives…", "runImport…"*
- **Menu**: links to cart/basket/checkout/my-account/add-to-cart are removed, along with the mini-cart and account
  blocks. Shop category entries are marked `catalogueLink`, so they are read after the owner's own pages and stay
  under "Shop". *Tests: "the menu keeps…", "shop categories…"*
- **Furniture removed**: notices, store-notice "Dismiss", breadcrumbs, sorting, result counts, pagination, shop
  widgets, related/up-sell/cross-sell sections, screen-reader price copies. A `noise` list covers WooCommerce's
  own lines. *Tests: "the shop page…", "a block theme…"*
- **Product page**: gallery at `data-large_image`, and description and care notes kept. Customer reviews become
  quotes (their words plus their name). Tab labels, WooCommerce's panel headings, the attributes table, SKU, stock
  and the review form go. *Test: "a product page…"*
- **Full-size pictures**: WordPress `-WxH` copies become the original (only under `/wp-content/uploads/`, and
  `-scaled` is kept as is). Jetpack `i0.wp.com` resize parameters are dropped. Optimole addresses become the
  original address they carry. *Test: "pictures at full size…"*
- **Composes with WordPress**: the adapter runs the WordPress adapter's `prepare`, `noise`, `contentRoot` and
  `fullSizeImage` first. Whatever the WordPress session adds reaches shops too. `prepareWoo`, `readWooProducts` and
  `wooFullSizeImage` are exported so another adapter can reuse them.

## Can be done (not done yet)
- **Shops built with Elementor get the Elementor adapter, so none of this runs (S).** `index.ts` puts Elementor
  first, and Elementor's `detect` matches any `elementor-…` class. All 3 public demos I studied were
  WooCommerce + Elementor. Fix in `site-builders/elementor.ts` (Elementor session) or `index.ts` (main):

  ```ts
  // elementor.ts
  import { prepareWoo, readWooProducts } from './woocommerce';
  const isWoo = ($) => /\bwoocommerce-(no-js|js|page)\b/.test($('body').attr('class') ?? '') || $('li.product, li.wc-block-product').length > 0;
  // in prepare, after Elementor's own tidy:
  if (isWoo($)) prepareWoo($);
  // new field:
  products: ($, url) => readWooProducts($, url),   // [] on pages without WooCommerce cards
  ```

  The simpler alternative is for main to let `adapterFor` return a
  *stack* (Elementor, then WooCommerce, then WordPress) and run each `prepare`/`products` in turn. That would also
  suit WordPress + Elementor.
- **All products, not only the ones shown (M).** The public Store API needs no key:
  `GET /wp-json/wc/store/v1/products?per_page=100&page=N` returns `name`, `permalink`,
  `prices.{price, regular_price, sale_price, currency_code, currency_minor_unit}` (integers in minor units: "1800"
  with minor unit 2 → £18.00), `images[].src` (full size), `short_description` and `categories`. Plugins or
  security settings sometimes turn it off, and then it 404s or 401s. Needs:
  - a `fetchJson`-style dep through the SSRF fence (`site-import.ts` `ImportDeps`, `site-fetch.ts`);
  - an optional adapter hook such as `productsFeed?(origin: URL): string | null` in `types.ts`, used once per
    import in `runImport`, then merged by name with the page-read products (the cap is `IMPORT_LIMITS.products`).

  Older Woo versions also have `/wp-json/wc/store/products` (no `v1`). The authenticated `/wp-json/wc/v3/products`
  needs the owner's keys, so leave it out.
- **Variations (S, after the feed):** a variable product's range comes through as text. The Store API's
  `variations` + `/products/{id}` give each size's price, if Business Information wants one row per size.
- **Product descriptions into Business Information (S):** cards carry no description. Product pages do, but they are
  skipped (`SKIP_PATH` `/product/.+`). The Store API's `short_description` fills this, and would need a field on
  `ImportedProduct` in `types.ts`.
- **`/product-category/` pages are read as pages, with leftover page cap (nothing to do, or S).** With this adapter
  they read cleanly (title, the category description, product names and pictures). If the owner would rather not
  copy catalogue pages at all, add `product-category` to `SKIP_PATH` in `site-import.ts`.
- **Store notice (S, wording):** the owner's own store notice ("Free UK delivery on orders over £40") is printed
  outside `<main>`, so it is never read. It is a delivery fact that belongs in Business Information, so the import
  report could list it. That needs a field in `ImportPage`.
- **Button corners and header colour (S, shared):** Storefront's inline CSS gives
  `.button { border-radius: 4px }` and `.site-header { background-color: … }`. `readImportedLook` reads colours
  from inline styles but `radius`/`headerColor` came back null. `buttonRadius` only looks at `css` (fetched
  stylesheets), not inline `<style>`. Fix in `site-import-theme.ts`: pass inline `<style>` text into
  `buttonRadius`'s CSS too.
- **Lazy-load attributes (S, belongs in WordPress):** WP Rocket / a3 Lazy Load put the real picture in
  `data-lazy-src` / `data-lazy-srcset` with a placeholder `src`. The card rebuild here already reads
  `data-lazy-src`. The general case belongs in the WordPress adapter's `prepare` (or in `addImage` in
  `site-extract.ts`).

## Can't be done
- **Prices on the site.** Left off on purpose; they go to Business Information ▸ Products & Services via
  `report.products`.
- **A working shop.** Basket, checkout, accounts, stock and payments are WooCommerce running on their server. Hosted
  sites run no scripts and frame no one, so product names link to the product page on their existing shop instead.
- **Products behind a login or a "members only" catalogue, and wholesale prices.** Not public.
- **Cart and Checkout blocks, and the old "All Products" block.** Drawn by React from the Store API, and empty in
  the HTML. The headless browser would draw them, but the first two are never pages to copy.

## Suggested improvements to our import
- **Adapter stacking** (main, `site-builders/index.ts` + `site-extract.ts`): WordPress sites are layered (builder
  plugin + shop plugin + theme). Running every matching adapter in a fixed order (Elementor, then WooCommerce, then
  WordPress) would fix the Elementor gap above, and the same pattern would serve Wix Studio/Wix and
  BigCommerce/Magento page builders. Here it is done by hand, by calling the WordPress adapter from inside this one.
- **`noise` for headings** (`site-extract.ts` walk): adapter `noise` is applied to text but not to headings, so a
  platform's default heading ("Description", "Related products") has to be removed in `prepare`. Testing headings
  against `adapter.noise` too would make this simpler for every shop platform.
- **A safe fallback for full-size guesses** (`site-import.ts` picture copy): stripping `-1024x683` is right for
  WordPress, but an original uploaded with such a name ("banner-1200x400.jpg") 404s once stripped. If `savePicture`
  fails on an address `fullSizeImage` changed, retry the address as read. That needs the original kept beside `src`
  on the image block.
- **The generator check reads only the first tag** (`adapterFor` `gen`): WordPress, WooCommerce and Elementor each
  write one. Passing all generator tags joined would let `detect` functions use them without regexes on raw HTML.

## Detection
`/<meta[^>]+content=["']WooCommerce\b|\/wp-content\/plugins\/woocommerce\/|\bwoocommerce-(?:no-js|js|page|active|uses-block-theme)\b|\bwc_add_to_cart_params\b|\bwoocommerce_params\b|\bwp-block-woocommerce-[a-z]|\bwc-block-(?:components|product|mini-cart)/`
- All of these are on every page of a WooCommerce site, so About and Contact pages are WooCommerce too. That is
  right, since they have the mini-cart and account links to strip.
- False positive fixed: plain prose mentioning "woocommerce". Still possible: a non-WordPress page that embeds
  WooCommerce's CSS or class names (unlikely; and the tidy only removes Woo-named elements).
- False negatives: a shop whose security plugin strips the generator tag *and* serves assets from a renamed plugin
  folder. The body class still catches it unless the theme drops `body_class()`.
- Elementor is listed first in `index.ts` and wins on WooCommerce + Elementor shops (see "Can be done").
