# Elementor

## How sites on Elementor are built
- A WordPress plugin; pages are **server-rendered** by PHP, so the words are in the HTML (`rendersWithJs: false`).
  JavaScript only animates and fills in: counters (HTML says `0`, `data-to-value` holds the number), the
  video widget's player (built from `data-settings.youtube_url`), Pro gallery tiles (`data-thumbnail`,
  full size on the wrapping `<a href>`), background slideshows (`data-settings.background_slideshow_gallery`),
  lazy background images, animated headlines, carousels.
- Markup: one Elementor *document* per template — `data-elementor-type="wp-page"` (the page),
  `header` / `footer` (Pro theme builder, printed as `<header>`/`<footer>`), `popup` (printed hidden on every
  page), `loop-item`, `single-*`. Inside: legacy `elementor-section > elementor-column > elementor-widget-wrap`
  or Flexbox containers `e-con` / `e-con-inner`; every widget is
  `div.elementor-widget.elementor-widget-<name> > .elementor-widget-container`.
- Words: heading widget (`.elementor-heading-title`, tag chosen by the owner — often `div`/`span`/`p`),
  text editor (`<p>`s, sometimes bare text), button (`a.elementor-button > .elementor-button-text`), icon
  list (`li.elementor-icon-list-item`), icon/image box, testimonial (`.elementor-testimonial-content`,
  Pro `.elementor-testimonial__text`), accordion/tabs (`.elementor-tab-title`, tab titles printed twice for
  desktop and phone).
- Menu: nav-menu widget prints the menu **twice** (`nav.elementor-nav-menu--main` and a hidden
  `nav.elementor-nav-menu--dropdown` copy), drop-downs as `li > ul.sub-menu`. Mega menu (`n-menu`) keeps
  whole containers inside the drop-down.
- Pictures: `<img>` with WordPress `srcset` (resized copies named `name-800x534.jpg`), Elementor custom
  crops in `uploads/elementor/thumbs/name-<hash>.jpg`, lazy plugins (WP Rocket `data-lazy-src`), and section
  backgrounds set **in CSS by element id** (`.elementor-element-a1b2c3d{background-image:url(…)}`) — inline
  `<style>` with the "internal" CSS print method, else `uploads/elementor/css/post-<page id>.css`.
- Responsive copies: owners often build a section twice and hide one per device
  (`elementor-hidden-desktop|laptop|tablet|mobile|…`).
- Look: the **kit** (`<body class="elementor-kit-6">`, CSS `uploads/elementor/css/post-6.css`) defines
  `--e-global-color-primary|secondary|text|accent|<id>` and `--e-global-typography-<name>-font-family`.
  Defaults when never set: `#6EC1E4 / #54595F / #7A7A7A / #61CE70`, Roboto / Roboto Slab.

## Already covered
(baseline: `readImportPage` + `runImport`, no network, no model, on the fixtures)
- Headings, paragraphs, links inside sentences, buttons, icon lists, accordion text.
- Menu with drop-down groups, read once although printed twice; logo from a theme-builder header.
- Contact (tel/mailto/JSON-LD), social profiles, footer removed (Pro theme builder uses `<footer>`).
- Look, *if* the kit stylesheet is fetched: `--e-global-color-primary` ranks as a brand colour.

## Fixed in this pass
All in `prepare` / `noise` / `fullSizeImage` / `detect`, proved in `tests/site-platform-elementor.test.ts`:
- Counters read `1,200+` instead of `0` (delimiter, prefix and suffix kept).
- Phone copies (`elementor-hidden-desktop`) dropped — no doubled heading, no cropped thumbnail.
- Popups removed (they were read as content on pages without `<main>`, e.g. the Canvas template).
- Carousel clones (`swiper-slide-duplicate`) and controls ("Next slide") removed; burger toggle removed.
- Testimonials become quotes.
- Heading widgets set to `div`/`span`/`p` become headings (level 3); animated headline keeps its first
  (visible) rotating word instead of "for sourdough buns cakes".
- Pictures: WP Rocket lazy `data-lazy-src(set)`; CSS-by-id section backgrounds from inline `<style>` (hover
  and overlay rules ignored); background slideshows (first slide); Pro gallery tiles at full size with their
  aria-label as the description; WordPress `-WxH` and Jetpack `?resize=` → original.
- Video widget and WP Rocket's lazy YouTube placeholder become real iframes → thumbnail + "Watch the video";
  Google Maps widget (`maps.google.com/maps?q=…&output=embed`) → "See us on the map".
- Social icons no longer become "Instagram"/"Facebook" buttons (marked `role="contentinfo"` so the shared
  code drops them after reading the profiles — a workaround, see below). Share buttons removed.
- Canvas / free-Elementor pages with no `<header>`: the top block holding a menu widget becomes the header
  (menu + logo read, call button not page content); a last block saying © becomes the footer.
- Detection no longer claims WooCommerce's own pages (product, shop, category, basket, checkout).
- Exported, tested but **not wired in**: `readElementorKit(html, css)` (kit colours + fonts, defaults
  ignored, font pairing via `fontKeyFor`) and `elementorKitStylesheet(html, url)`.

## Can be done (not done yet)
- **Use the kit for the look (S, main session: `types.ts`, `site-import.ts`, `site-import-theme.ts`).**
  Add to `BuilderAdapter`: `lookStylesheets?(html: string, baseUrl: string): string[]` and
  `look?(html: string, css: string): Partial<ImportedLook> | null`. In `readLook`, put
  `adapter.lookStylesheets` first in `sheets` (today the kit CSS is often past `LOOK_MAX_STYLESHEETS = 4`), and
  lay `adapter.look(html, css)` over `readImportedLook`'s result (non-null fields win). Elementor:
  `lookStylesheets: (h, u) => [elementorKitStylesheet(h, u)].filter(Boolean)`,
  `look: (h, css) => { const k = readElementorKit(h, css); return { primaryColor: k.primaryColor ?? k.accentColor, secondaryColor: k.accentColor !== k.primaryColor ? k.accentColor : null, textColor: k.textColor, headingFont: k.headingFont, font: k.font }; }`.
  Without this, heading font is never found (Elementor's rules say `font-family: var(--e-global-…)`) and a kit
  left at defaults paints sites Elementor-blue `#6EC1E4`.
- **Section backgrounds from the page's own CSS file (M, main session: `site-extract.ts`, `site-import.ts`).**
  `readImportPage(html, url, css?)` passing fetched `post-<page id>.css` to `prepare($, url, css)`; this adapter's
  CSS-by-id matcher already handles it.
- **A shared "furniture" selector (S, `types.ts`, `site-extract.ts`):** `furniture?: string` removed alongside
  header/footer *after* contact and socials are read — replaces the `role="contentinfo"` workaround.
- **Combining adapters — WooCommerce shops built with Elementor (S, `index.ts`, `site-extract.ts`).** Today
  first match wins, so an Elementor-built shop home page gets only Elementor's tidying, and every WordPress
  site with Elementor installed (kit class on every page) skips the WordPress adapter. Proposal: `adapterFor`
  returns the *chain* of matches (e.g. `[elementor, woocommerce, wordpress]`); run every `prepare` in order
  (most specific first), use the first `contentRoot`, OR the `noise` patterns, and try each `fullSizeImage`
  until one returns non-null; `platform` stays the first key. Until then this adapter steps aside on
  WooCommerce's own pages, and already does WordPress's lazy-load and `-WxH` work itself.
- Mega menu (`n-menu`) drop-down groups and links inside it (S, this file): read `e-n-menu-title` as group
  labels and drop the content containers from the menu read.
- Linked headings ("Our menu →" heading that links to a page) lose the link (S, `site-extract.ts`).
- Logo uses `fullSizeImageUrl`, not the adapter's `fullSizeImage` (XS, `site-extract.ts`).
- If a `-WxH` original 404s (an owner who uploaded `hero-1920x1080.jpg`), `savePicture` should retry the
  address as found (S, `site-import.ts`).

## Can't be done
- Elementor's own crops (`uploads/elementor/thumbs/`) have no address back to the original.
- Forms (Pro form widget) — their questions are listed in the report; our own contact form replaces them
  (no third-party posting from hosted sites).
- Popups, sticky bars, motion effects, Lottie, custom HTML/JS widgets — no scripts on hosted sites.
- Members-only / logged-in content (WordPress login) isn't fetched.
- Rotating words of an animated headline beyond the first: keeping them all would invent punctuation.

## Suggested improvements to our import
- Adapter chaining (above) helps every WordPress-based platform (Elementor, WooCommerce, Divi, Beaver Builder).
- Let adapters say which stylesheets carry the look and read tokens from them (above) — Webflow, Squarespace
  and Shopify themes also keep palettes in CSS variables.
- Ignore known framework default palettes in `harvestBrandSignals` (Elementor's four defaults).
- `IMPORT_NOISE` could include carousel labels ("Previous slide", "Go to slide 3") for all platforms.

## Detection
- Signals: generator meta containing "elementor", or markup `elementor-kit|section|element|widget`,
  `/plugins/elementor/`, `/uploads/elementor/`.
- Not claimed: WooCommerce pages (`single-product`, `woocommerce-shop`, `post-type-archive-product`,
  `tax-product_cat`, `woocommerce-cart`, `woocommerce-checkout` body classes).
- No false positives on the saved Wix, Squarespace, Webflow, SPA and bare-HTML fixtures. Known over-match:
  Gutenberg pages on a site with Elementor installed (kit class on every page) — harmless, the tidying finds
  nothing, but WordPress's own adapter is skipped (see chaining).
