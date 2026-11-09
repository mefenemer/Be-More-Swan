# Adobe Commerce (Magento 2)

Adapter `src/utils/site-builders/magento.ts` · test `tests/site-platform-magento.test.ts` (20 checks) ·
fixtures `tests/fixtures/site-platforms/magento/` (all synthetic: two invented shops on `.example` domains,
modelled on the markup of the public Luma and Hyvä demo stores — no real business's words or pictures).

## How sites on Magento are built

Three front ends share one back end:

- **Luma and Luma-based themes** (most shops, including Blank children): server-rendered HTML, with
  RequireJS and Knockout adding the mini-cart and customer name afterwards. Words live in **CMS pages**
  and **CMS blocks / widgets**, today mostly written with **Page Builder**, which outputs
  `data-content-type="row|text|heading|image|banner|slider|slide|buttons|button-item|products|video|map|html|tabs"`.
  Owner content sits in widget areas either side of `<main>`: `.top-container` above, `.page-bottom` below,
  all inside `.page-wrapper`.
  - Menu: `nav.navigation > ul > li.level0 > a.level-top`, sub-categories in `ul.level0.submenu`.
    It is the **category tree** only — About us, Delivery and Contact are usually only in the footer
    (`ul.footer.links`).
  - Header furniture: `.panel.header` (welcome line, Sign In, Create an Account), `.minicart-wrapper`
    ("My Cart"), `.block-search`, compare link, `.nav-sections-item-title` tabs (Menu / Account / Settings),
    currency and language `.switcher`.
  - Pictures: catalogue pictures are served resized from `/media/catalog/product/cache/<32-hex>/a/b/file.jpg`
    (the original is `/media/catalog/product/a/b/file.jpg`; `/pub/media/…` on some hosts; Magento 1 used
    `/cache/1/small_image/240x300/<hash>/…`). CMS pictures are under `/media/wysiwyg/`, and the 2.4 media
    gallery may hand out `/media/wysiwyg/.renditions/wysiwyg/…` thumbnails. Fastly / image optimisers add
    `?width=&height=&quality=&fit=&auto=&format=`. Page Builder draws every picture twice
    (`img.pagebuilder-mobile-hidden` + `img.pagebuilder-mobile-only`) and keeps **backgrounds in a JSON
    attribute**, `data-background-images='{\"desktop_image\":\"…\",\"mobile_image\":\"…\"}'`, not in CSS.
  - Products: `li.product-item` with `.product-item-link` (name), `img.product-image-photo`, `.price-box`
    (`[data-price-type="finalPrice"]`, `.special-price`, `.old-price`), ratings, swatches, an add-to-basket
    `form[data-role="tocart-form"]` and wish-list / compare links. Category pages add `.category-description`,
    `.category-image`, `.toolbar` (sorter, pager, limiter) and layered navigation `#layered-filter-block`.
  - Colours and fonts: compiled LESS in `/static/version<n>/frontend/<Vendor>/<theme>/<locale>/css/styles-m.css`
    (+ `styles-l.css` for wide screens).
- **Hyvä** (fast-growing): server-rendered Tailwind + Alpine.js; same layout XML, same class names for
  products (`.product-item`, `.product-item-link`, `.price`), `<main id="maincontent">` inside `.page-wrapper`.
  Differences that matter: each **product card is a `<form>`** (add to basket), the header carries a
  **second, phone-only menu** (`nav[aria-label="Mobile Main Menu"]`, with "See all …" links) before the
  desktop one, an account `nav`, a cart drawer (`#cart-drawer`, `x-data="initCartDrawer()"`), a sign-in
  pop-up form, `.sr-only` labels ("Press to skip carousel", "View more about …"), and footer links in
  `<nav aria-label="Company Menu">`. Styles in one Tailwind `styles.css`.
- **PWA Studio (Venia)** and other headless front ends: the server sends a shell — `<div id="root">`,
  `data-media-backend`, `INLINED_PAGE_TYPE`, `RootCmp_*` bundles — and React draws everything from GraphQL.
  The rendered page still uses Page Builder's `data-content-type` markup for CMS content.

Tell-tale markup: `<script type="text/x-magento-init">`, `data-mage-init`, `Magento_<Module>/` asset paths,
`/static/version<n>/frontend/`, `/media/catalog/product/`. No generator tag.

## Already covered

Before this pass, on the fixtures (`readImportPage` and `runImport`, no network, `plan` null):

- The words inside `<main>` in order, headings, the YouTube embed (thumbnail + "Watch the video"),
  category description and picture, the logo, contact email/phone and the contact form's questions.
- Cookie notice and `<noscript>` banner (shared cookie/script removal).

What was lost or wrong:

- **Detection claimed non-Magento pages**: `mage\/` matched inside every `image/png`, so any unrecognised
  page with a PNG favicon was read "as Magento" (magento sits before hubspot, aem, ghost, drupal, joomla,
  contentful… in `ADAPTERS`). Hyvä pages without `Magento_` paths and PWA Studio shells were not recognised.
- Menu: Sign In, Create an Account, "store logo" (which became the **home page's menu name**), "My Cart0items",
  Compare Products first, then every sub-category. "Advanced Search", "Search Terms", "Orders and Returns"
  and "Privacy and Cookie Policy" pass `SKIP_PATH` and would have been **imported as pages**. Luma's footer
  pages (About us, Delivery, Contact) never reached the menu at all. Hyvä's phone menu named categories
  "See all Saddles".
- `.top-container` and `.page-bottom` words (a notice, a testimonial) were dropped — outside `<main>`.
- Page Builder: background pictures dropped, every picture copied twice (desktop + phone), text hidden with
  "Hide" read, banner/slide buttons had no link, maps lost entirely, "Home Page" (Magento's default home title)
  read as a heading.
- Products: "Speckled oat mug Rating: 80% 4 Reviews £28.00 Add to Wish List Add to Compare" as one line —
  dropped whole as a price line, so the **product name was lost too**. Hyvä cards (forms) **vanished**:
  1 of 16 products read on the public Hyvä demo.
- Category pages: "View as", "Grid", "Sort By", "Position", "Product Name", "per page", "Shop By",
  "Compare Products", "You have no items to compare." … read as content; Magento's placeholder picture copied.
- `hasForm` was true on every page (search, newsletter, add-to-basket, Hyvä sign-in pop-up), and the import
  report listed "Search entire store here…", "Email Address", "Password" as the owner's form questions.
- Catalogue pictures copied at the cache size (240×300 thumbnails).

## Fixed in this pass

Each line is a check in `tests/site-platform-magento.test.ts`:

- **Detection**: `MAGENTO` regex: x-magento-init, data-mage-init, `Magento_Module/`, `/static/…/frontend/`,
  `/media/catalog/(product|category)/`, PWA Studio's data-media-backend / INLINED_PAGE_TYPE / RootCmp_.
  A plain page with `image/png` is no longer Magento (*detection* checks).
- **Menu order**: top-level categories, then the footer's own pages, then sub-categories as drop-downs
  (a copy of the category tree appended last, so groups survive and the page cap goes to About us before
  "Tops > Jackets"). Account, cart, search, compare, guest-order and the sample privacy page are removed from
  header, menu and footer; the logo link's aria-label is dropped; Hyvä's phone and account menus are removed
  (*menu* checks).
- **Content root** `.page-wrapper:has(main)`: top and bottom widget areas are read (*widget areas*).
- **Page Builder**: hidden elements removed, phone-only pictures removed, backgrounds handed to the reader as
  `data-bg`, banner/slide `<button>` turned into a link to where the tile went, Luma `a.block-promo` tiles the
  same, maps turned into their name, `<address>` (becomes the page's address), opening note, phone link and a
  `maps.google.com/maps/embed?q=lat,lng` frame the reader turns into "See us on the map" (*Page Builder*,
  *banner*, *map* checks). "Home Page" title dropped on the home page only.
- **Product cards** (Luma and Hyvä): rebuilt as `<li><img alt=name><a href=product>Name</a></li>` with no
  price; ratings, swatches, stock, add-to-basket / wish-list / compare removed; placeholders skipped. The
  adapter's `products()` reads each card first — name, final price (not the crossed-out one), page,
  full-size picture — for Business Information (*product cards*, *products for Business Information*).
- **Category furniture**: toolbars, layered navigation, compare / wish-list / recently-viewed blocks,
  breadcrumbs, messages, newsletter, carousel controls, Hyvä `.sr-only` labels; a `noise` list catches the
  rest ("Add to Cart …", "View more about …", "Out of stock" …).
- **Forms**: search, newsletter, add-to-basket, wish-list and customer (sign-in) forms removed, so `hasForm`
  and the form questions are the contact form's only (*forms*).
- **Full-size pictures**: `/cache/<hash>/` (M2) and `/cache/1/<type>/<size>/<hash>/` (M1) stripped,
  `.renditions/` stripped, resize query parameters dropped (*full-size* check; whole-import check confirms
  no cache path is copied).
- **Catalogue links**: `catalogueLink()` marks the category menu, so a small page cap is spent on About,
  Delivery and Contact first (*catalogue* and *small page cap* checks).
- Whole import with fake deps: reads Home, categories, About us (from the footer) and Contact; no
  machinery page read or listed; products in `report.products`, never on the draft; look read from
  `styles-m.css` (primary `#7a4b2a` from the fixture).

### Shared changes made in the second pass (owner asked for them, 2026-11-08)

These touch shared import code, so the main session should review them when merging:

- **Products → Business Information.** `types.ts`: `ImportedProduct` and an optional
  `BuilderAdapter.products($, url)` (read before `prepare`). `site-extract.ts`: `ImportPage.products`,
  filled by the adapter **and by schema.org Product data on any platform** (`ldProduct`), one per name,
  full-size pictures, capped at 60. `site-import.ts`: `ImportReport.products` (with `imageAssetId` when the
  import already copied that picture), `importedProducts`, `productFieldsFromImport` (a plain amount becomes
  a structured price, anything else is kept as their words). `site-import-store.ts addImportedProducts` +
  `sites.ts import_products { names? }`: inserts into `org_products`, skipping names already there, picture
  from the library or fetched through the SSRF fence only when they chose to copy pictures (12 a request).
  GUI: a ticked list on the import review card. Chat: a `site_import_products` card (registry,
  chat-session handler, orchestrator prompt, snapshot line). Offered only while the import waits —
  "Use"/"Discard" deletes the import row. No SQL. Prices never reach the site.
- **Catalogue pages last.** `SiteLink.catalogue`, optional `BuilderAdapter.catalogueLink(href, el)`,
  `site-import.ts choosePages`: own pages first within the cap, returned in menu order.
- **`SKIP_PATH`** gains Magento's machinery paths (exact change below, now applied).
- **Adapter noise applies to stand-alone buttons**; the **logo** goes through the adapter's full-size rule.
  Other platforms' `noise` lists will now also drop buttons that match — worth a glance when merging theirs.
- Tests: `tests/site-import.test.ts` (7 new checks, 48 in all).

Also checked locally (not committed) against the public Luma and Hyvä demo stores: Luma menu becomes
What's New, Women, Men, Gear, Training, Sale, About us, Customer Service, Contact Us, then sub-categories;
Hyvä home goes from 1 to 16 products with full-size pictures.

## Can be done (not done yet)

- ~~Products into Business Information~~ — done in the second pass (above). Left: a product's
  description from its product page (only cards are read today), and offering the products again after
  the import is used (the report goes with the import row).
- *Original note, for the record:* **Products into Business Information (M).** The price lines are already in `report.prices` as
  "Name: £price". A shared step could offer them as products: in `site-import.ts` keep, per price line, the
  product name, price and picture block number, and in the import's accept flow (`sites.ts import_accept`,
  Business Information product store) offer "Add these N products to Business Information". Magento also
  prints `<script type="application/ld+json">` Product data on product pages on many themes — a cleaner
  source (name, price, currency, image, sku). Touches `site-import.ts`, `site-extract.ts` (an
  `ImportPage.products?: {name, price, currency, image, href}[]` field the adapter could fill in `prepare`
  by writing `data-bms-product` attributes, or a new optional `BuilderAdapter.products?($)` hook in
  `types.ts`), and the accept UI. Prices stay off the site.
- ~~Rank catalogue pages after content pages~~ — done (`choosePages`). *Original note:* **(S).** Category listings are still read as pages when the
  cap allows. A shared hint — e.g. optional `BuilderAdapter.pageKind?(url, navLink): 'content' | 'catalogue'`
  in `types.ts`, used by `pickImportPages` in `site-import.ts` to read content pages first — would let a
  shop with 30 categories keep About, Delivery and Contact. The adapter would answer from the `.html`
  category suffix and the `category-item` class.
- ~~`SKIP_PATH` additions~~ — applied. *Original note:* **(S)**, `site-import.ts`: `catalogsearch|sales/guest|search/term|wishlist|checkout|
  customer|privacy-policy-cookie-restriction-mode|catalog/product_compare`. The adapter already removes
  these links, but a link that reaches the menu by another route (a CMS block in the header) would still
  be read. Exact change:
  `export const SKIP_PATH = /\/(cart|basket|checkout|account|my-account|customer|wishlist|catalogsearch|login|log-in|signin|sign-in|register|members?|search|privacy|privacy-policy|privacy-policy-cookie-restriction-mode|cookies?|cookie-policy|terms|terms-and-conditions|legal|accessibility|sitemap|feed|tag|category|author|wp-admin|wp-login)(\/|$)|\/sales\/guest\/|\/search\/term\/|\/catalog\/product_compare\/|\/(blog|news|post|posts|product|products|shop|store|events?)\/.+/i;`
- **Stylesheet choice for the look (S)**, `site-import.ts readLook` / `site-import-theme.ts
  harvestBrandSignals`: Luma links `mage/calendar.css`, `styles-m.css`, `styles-l.css`, `print.css`, and
  often several module sheets first. With `LOOK_MAX_STYLESHEETS = 4` the theme sheet can be pushed out.
  Prefer sheets whose path contains `/css/styles` (Luma) or `/css/styles.css` (Hyvä), and skip
  `print.css`, `calendar.css`, `/mage/`, `/jquery/`.
- **Page Builder tabs (S, adapter only)**: tab headers are read as list items before their panels; pairing
  each header with its panel as a heading would read better. Not seen often enough on small shops to do now.
- **Product detail pages (M, adapter only)** — only matter once a product route exists: `.product.info.detailed`
  description tab, `.product.media` gallery (`data-gallery` JSON in `text/x-magento-init` holds every full
  picture).

## Can't be done

- **PWA Studio / headless storefronts without the browser**: the server sends an empty shell. The import's
  headless browser (`site-js-render.ts`) is the only way; Magento's GraphQL (`/graphql`, `cmsPage`,
  `products`) would give clean content but means calling the shop's API, which the import doesn't do — and
  some shops close it. Recognised, so the report can say why.
- **Customer-only content**: B2B / trade shops (Adobe Commerce B2B, "login to see prices", closed catalogues)
  hide catalogue and often CMS pages behind sign-in. We never sign in.
- **Knockout-drawn text** (the header welcome message, the mini-cart) is filled by JavaScript from
  customer data; it is furniture anyway and is removed.
- **Running the shop**: basket, checkout, accounts, stock and orders stay on Magento; hosted sites run no
  scripts and frame no third parties, so the new site can only link product names back to the shop.

## Suggested improvements to our import

- Done in the second pass: the shared **products** route (Shopify, WooCommerce and BigCommerce adapters
  can now fill `products()`; schema.org Product data already works for them), **catalogue** marks,
  **button noise**, **logo full size**.
- `menuGroupOf` stops at `NAV_ROOT`; that's what made a copied tree keep its groups — worth a comment there,
  since adapters may rely on it.

## Detection

`detect` = `MAGENTO.test(html)`:
`text/x-magento-init` · `data-mage-init=` · `Magento_<Module>/` · `/static/(version<n>/)?(frontend|_cache/merged)/` ·
`/media/catalog/(product|category)/` · `data-media-backend=` · `INLINED_PAGE_TYPE` · `/RootCmp_…`.

- **False positive fixed**: the old `mage\/` matched `image/png`, `image/jpeg` — almost every page.
- Possible false positives left: a site migrated *from* Magento that still hot-links `/media/catalog/product/`
  pictures, or another PWA built with Venia's `RootCmp_` naming. Both are Magento-shaped enough that the
  adapter's removals do no harm (they only target Magento class names and Magento machinery URLs).
- Possible false negatives: a fully headless Magento front end on Next.js / Vue Storefront that serves
  pictures through its own image CDN and none of the markers above. It would be read as an ordinary
  JavaScript site — which is what it is.
- Order: `magento` sits after Shopify and BigCommerce and before HubSpot/AEM; none of those markers appear
  on Magento pages.
