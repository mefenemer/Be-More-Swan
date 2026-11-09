# BigCommerce

Adapter `src/utils/site-builders/bigcommerce.ts` · test `tests/site-platform-bigcommerce.test.ts` · fixtures
`tests/fixtures/site-platforms/bigcommerce/` (SYNTHETIC: a fictional candle shop on `hollinfern.example`, its
markup modelled on Cornerstone, BigCommerce's reference Stencil theme; no real shop's words or pictures).
Studied 2026-11-08 against the public Cornerstone demo (`cornerstone-light-demo.mybigcommerce.com`: home,
Our Story, Contact Us, a category page) and BigCommerce's Stencil docs.

## How sites on BigCommerce are built

- **Server-rendered.** Stencil themes are Handlebars templates rendered by BigCommerce, so every word is in
  the plain HTML. The headless browser is not needed (`rendersWithJs` is left unset). Headless "Catalyst"
  (Next.js) storefronts exist too. They render on the server as well, but their markup is Next.js, not Stencil.
- **Tell-tale markup:** `<meta name='platform' content='bigcommerce.stencil'>` on every Stencil page; theme
  files at `cdn11.bigcommerce.com/s-{storehash}/stencil/{uuid}/…`; the stylesheet link carries
  `data-stencil-stylesheet`; `var BCData`, `window.stencilBootstrap(…)`; `data-content-region="…"` drop zones.
- **The page's own content** sits in `#main-content`. That is `<main class="body">` in current Cornerstone
  and `<div class="body">` in older copies. Web pages ("Our Story", "Shipping & Returns") have
  `<main class="page"><h1 class="page-heading">` plus `.page-content` from the WYSIWYG editor, often wrapped
  in nested `<p><p>`. Category pages have `h1.page-heading`, `.category-description`, `ul.productGrid` of
  `article.card`, a facet sidebar (`.page-sidebar`), a sort form (`.actionBar`) and `.pagination`.
- **The home page** has `section.heroCarousel` (slides: image, `p.heroCarousel-title`,
  `p.heroCarousel-description`, `a.heroCarousel-action`). Page Builder widgets sit in
  `data-content-region` → `data-widget-id` (text, images, HTML). The automatic product lists are featured,
  best sellers and new: `[data-product-type]` grids or `.productCarousel`, each under a theme heading such as
  "Featured Products" (from the theme's language file, not the owner's words).
- **The menu:** `nav.navPages` → `li.navPages-item` → `a.navPages-action`. Categories come first, then web
  pages (`navPages-item-page`), and sub-menus sit in `div.navPage-subMenu`, which begins with an "All {category}"
  link. Next to it, `nav.navUser` holds the shop's machinery: currency selector (`?setCurrencyId=`), Compare,
  quick search, Gift Certificates, Sign in / Register (`login.php`) and Cart (`cart.php`). The same items
  appear again in `.navPages-list--user` for phones.
- **Pictures:** `cdn11.bigcommerce.com/s-{store}/images/stencil/{size}/…` where `{size}` is `500x659`, `1280w`,
  `original`… The CDN resizes to any width on request (`1600w`, `1920w`, `2560w` all answered 200), and it
  seems not to upscale: 1600x1600, 1920w and 2560w of a 1024px original all returned the same file (pixel
  size not checked). Product cards lazy-load: `srcset` holds an 80w
  placeholder, and the real sizes are only in `data-srcset`. Pictures uploaded in the page editor live at
  `{shop}/product_images/uploaded_images/…` (full size already). Older Blueprint themes use
  `…/products/{id}/images/{img}/{name}.{stamp}.{w}.{h}.jpg`.
- **Look:** the theme's settings (colours, fonts) are compiled into one stylesheet,
  `…/css/theme-{uuid}.css`, plus Google Fonts. Both are linked with `rel="stylesheet"`, so the shared look
  reader finds them.
- **Store details** are in the footer: `article[data-section-type="storeInfo"]` holds an `<address>` with
  `<br>` between the lines, and "Call us at …" in a `<strong>` with **no `tel:` link**. There is a newsletter
  form in `[data-section-type="newsletterSubscription"]`, social icons in `.socialLinks`, and "Powered by
  BigCommerce". The cookie banner is drawn by script (consent manager), so it isn't in the HTML.

## Already covered

Tested against the fixtures before this pass (shared code, no adapter work):
- The words of web pages, Page Builder text widgets, the hero descriptions and buttons, and category
  descriptions, in order. `<address>` is read, and social links come from the footer.
- Prices never reach the draft: `numberBlocks` moves any block that states a price into the report's
  `prices`.
- The look: background, text colour, heading font (Lora) and corners come from the compiled theme stylesheet.
- The contact page's form is found, and its questions are listed.

What today's import lost (before this pass):
- **The menu was mostly shop machinery.** "British Pound" (the currency selector) came first and became the
  home page's name in the report. Compare, Gift Certificates, Sign in, Register and Cart followed, so
  `runImport` spent 4 of its 7 page slots fetching `compare`, `giftcertificates.php`, `login.php` and
  `cart.php`. `SKIP_PATH` doesn't match `.php`. "Our Story" was pushed out of an 8-page import.
- Sub-menu links were grouped under the wrong label ("Travel Tins [All Candles]"). Cornerstone's
  `navPage-subMenu-item` class reads as a sub-menu box of its own.
- Hero slide titles were read as text, not headings.
- Pictures came in small: 80w (the lazy placeholder), 640w or 1280w. The logo came in at 500x200.
- Product cards became "Quick view Compare Add to Cart The item has been added", the brand name and "£24.00".
  On a category page, each card was ONE list item holding the price, so the whole item, product name
  included, went to `prices`.
- The home page's automatic product lists and "Featured Products" were read as content.
- The quick search and newsletter forms set `hasForm` on every page, and "Search", "Email Address" and
  "Sort By:" were listed as the owner's form questions. "Required" was glued onto the contact form's labels.
- The phone number in the footer was not read, and the address lines ran together ("Fellside BarnsKendal").

## Fixed in this pass

All in `bigcommerce.ts`, proved by `tests/site-platform-bigcommerce.test.ts` (18 checks):
- **Shop machinery out** (`prepare`): navUser, the phone-menu user list, quick search, cart preview,
  breadcrumbs, facet sidebar, sort form, pagination, modals, screen-reader-only labels, the carousel's Pause
  control, and on product cards the shop buttons, prices, brand, rating and sale flag. Any cart, login,
  account, wishlist, gift-certificate, compare or currency link left in the header or menu goes too. The menu
  is now Candles, Travel Tins, Wax Melts, Our Story, Journal, Contact Us, Shipping & Returns, and `runImport`
  never fetches a shop page. Tests: "the menu is the owner's pages…", "runImport reads the owner's pages…".
- **Sub-menus** are grouped under their category ("Travel Tins" → Candles), and the "All Candles" repeat is
  dropped.
- **Hero slide titles become headings**: the tag is renamed `p` → `h2`, with no words added.
- **Full-size pictures**: every CDN `<img>` gets its largest `data-srcset`/`srcset`/`src`, rewritten to
  `/images/stencil/1600w/…`. This includes the logo, which the shared code reads without the adapter's
  `fullSizeImage`. `original` is kept. `fullSizeImage` also handles background pictures, Blueprint
  `.{w}.{h}.jpg` → `.1280.1280.jpg`, and a Catalyst `/_next/image?url=…` back to the CDN.
- **Product names kept, prices never**: a category page reads as its heading, its description, then each
  product's name with its picture. The home page's automatic product lists and their theme headings are
  left out.
- **Forms:** search and newsletter forms are removed, so `hasForm` is true only on the contact page, and its
  questions read "Email Address", not "Email Address Required".
- **Store details:** the footer's "Call us at 01632 960123" is wrapped in a `tel:` link around the same words,
  so the phone is read. `<br>` in `<address>` becomes ", " ("Unit 3, Fellside Barns, Kendal LA9 0ZZ").
- **`contentRoot: '#main-content'`**: the home page has no `<main>` in older Cornerstone copies.
- **`noise`**: Quick view, Add to Cart, Choose Options, Pre-Order Now, Out of stock, Compare, Gift
  Certificates, Sale, Sort By, View All, Shop by Price, Footer Start, Toggle menu…
- **Detection tightened** (see below). A test checks that every word read appears on the saved page.

Also checked by hand against the four real demo pages (not committed). The menu, hero, full-size pictures,
category product names, contact form questions, "(415) 555-5555" and the address all come out right.

## Can be done (not done yet)

- **Products into Business Information ▸ Products & Services — M.** The data is all in the HTML: each
  `article.card` carries `data-entity-id`, `data-name`, `data-product-price`, `data-product-category` and
  `data-product-brand`, plus its picture and link. Product pages carry `og:` tags and schema.org `Product` /
  `Offer` JSON-LD (name, description, price, priceCurrency, image). A cleaner source is
  `/{category}/?sort=…` pages, or `/rss.php?type=rss&action=newproducts`. Plan: (1) the adapter gets an
  optional `products?($, url): ImportedProduct[]` reading the cards' data attributes (S, in this file plus
  `types.ts`); (2) `ImportPage` gains `products` (`site-extract.ts`), and `runImport` collects them
  across pages into `report.products` (`site-import.ts`); (3) the import review screen offers "Add these 12
  products to Products & Services", with prices in the shop's currency, using the existing product store's
  server action (and the same action from chat), never onto the site. Files outside this platform:
  `site-builders/types.ts`, `site-extract.ts`, `site-import.ts`, and the import review UI and route. Many
  platforms (Shopify, WooCommerce, Magento, Squarespace Commerce) would share it.
- **Shop paths in `SKIP_PATH` — S** (`site-import.ts`): add `\.php$` shop scripts (`cart.php`, `login.php`,
  `account.php`, `wishlist.php`, `giftcertificates.php`, `compare`, `search.php`, `sitemap.php`). The adapter
  already removes these from the menu, but a safety net in shared code costs nothing:
  `/(cart|login|account|wishlist|giftcertificates|search|sitemap)\.php$|\/compare\/?$/i`.
- **Logo through the adapter — S** (`site-extract.ts` ~line 763): read the logo with the `fullSize` wrapper,
  not `fullSizeImageUrl`, so adapters needn't rewrite the logo `<img>` in `prepare`:
  `logo = { src: fullSize(src), … }`.
- **Thin home pages on product-led shops — S/M.** Once the automatic product lists are gone, a home page
  that is all hero + products reads under 40 words (the real Cornerstone demo: 33). `runImport` still works
  when other pages are read, but `readPage` asks the headless browser for nothing. The adapter could set a
  "server-rendered, don't render" hint (`rendersWithJs: false` already exists, but `site-import.ts` doesn't
  read it). Suggested: in `readPage`, skip `deps.renderHtml` when `adapterFor(...)?.rendersWithJs === false`.
  That would also need `rendersWithJs: false` set here (one line in this file).
- **Blog — M.** BigCommerce's own blog is at `/blog/` (post list: `article.blog`, `h2.blog-title`, `.blog-post`
  summaries). The listing reads as a page today. Post bodies at `/blog/{slug}/` are skipped by `SKIP_PATH`.
  This belongs with the blog-import session (`import-blog-posts-from-o`).
- **Brand pages, gift certificates, "Shipping & Returns" — S.** Fine as pages today. If the owner's
  shipping page states prices ("Free over £40"), those lines go to the report's prices as designed.

## Can't be done

- **Cart, checkout, accounts, currency switching, gift certificates, compare, wishlists.** The hosted site
  runs no scripts and has no shop. These are removed, not imitated.
- **Product option pickers, stock levels, reviews widgets (Yotpo etc.), quick view.** These are drawn by
  script and third-party apps. Hosted pages frame no third parties.
- **Prices on the site.** Left off on purpose. They belong in Business Information (see "Can be done").
- **Theme settings as values** (`config.json` colours such as `color-primary`) aren't public. Only the
  compiled CSS is, so colours come from what the stylesheet uses.
- **Customer-group or logged-in-only content.** Behind login, never fetched.

## Suggested improvements to our import

- **The look picked the hover colour.** With the synthetic theme CSS, `primaryColor` came out `#c27c4e`
  (`.button--primary:hover`), not the button colour `#2f4a3a`. The brand reader favours saturated colours and
  doesn't tell `:hover` rules apart. Suggestion (`brand-extract.ts` / `site-import-theme.ts`): score
  `.button--primary`, `.btn-primary` and `button` backgrounds above `:hover`/`:focus` rules, and ignore
  colours that appear only in hover states. This helps every theme-based platform.
- **`menuGroupOf` and item classes** (`site-extract.ts`): `SUBMENU_CLASS` also matches sub-menu ITEMS
  (`navPage-subMenu-item`, `sub-menu-item`, `submenu-list`). Only match the box: exclude `-item`/`-list`
  suffixes, or test `li` elements last. The adapter works around it here, but WordPress `sub-menu`
  variants may hit it too.
- **`<br>` inside `<address>`** (`site-extract.ts`): read with a separator everywhere (`$('address br')
  .replaceWith(', ')` before reading). Every platform's footer address has the same problem.
- **Phone numbers without a link** (`site-extract.ts`): many footers print "Call us at …" with no `tel:`.
  A shared fallback could scan the footer for one UK/international number when no `tel:` link exists.
- **A card's price shouldn't take its name with it** (`numberBlocks`): when a list item states a price, the
  whole item goes to `prices`. Shared code could split the price off and keep the words. The adapter avoids
  this for BigCommerce by removing price elements first.

## Detection

`detect` matches any one of these:
1. `<meta name="platform">` containing "bigcommerce" (every Stencil page: `bigcommerce.stencil`);
2. a store's own CDN path, `cdn{n}.bigcommerce.com/s-{hash}/` or `/r-{hash}/` (Stencil, Blueprint, and
   Catalyst shops whose pictures come from the CDN);
3. `data-stencil-stylesheet` or `stencil-utils`.

The old test was `/bigcommerce/i` anywhere in the HTML. It matched an agency page saying "We build
BigCommerce stores", any link to bigcommerce.com, and a CDN asset without a store path. Both cases are now
tested as negatives. False negatives: a fully custom headless storefront whose pictures are proxied through
its own domain has none of these signals. It is read as a generic site, which is still correct, just without
the full-size pictures. `index.ts` lists BigCommerce after WordPress, Shopify and the site builders, so
"BigCommerce for WordPress" plugin sites are read as WordPress.
