# Adobe Experience Manager (AEM Sites + Edge Delivery Services)

Adapter `src/utils/site-builders/aem.ts` · test `tests/site-platform-aem.test.ts` · synthetic fixtures
`tests/fixtures/site-platforms/aem/` (invented businesses, markup modelled on Adobe's public WKND demo
and aem.live).

AEM sites belong mostly to large organisations: hundreds or thousands of pages, long pages, several
languages. Our caps (20 pages, 20 sections a page, 160 blocks, 40 pictures) mean an import of a real AEM
site is always a **sample**: the home page and the first menu pages. That is fine for the small
businesses we serve, but the report should say so when the menu is longer than the cap.

## How sites on AEM are built
Two quite different products share the name:

- **AEM Sites (6.x and as a Cloud Service)** — server-rendered. Words are in the HTML.
  - Core Components: `cmp-title`, `cmp-text`, `cmp-teaser` (pretitle, title, description, action links),
    `cmp-image`, `cmp-carousel`, `cmp-tabs`, `cmp-accordion`, `cmp-list`, `cmp-download`, `cmp-embed`,
    laid out in `aem-Grid` responsive grids inside `div.root.responsivegrid`.
  - Header and footer are **Experience Fragments** (`cmp-experiencefragment--header/--footer`), sometimes
    in `<header>/<footer>`, often in plain `<div>`s.
  - Menu: `nav.cmp-navigation`, usually starting at the root page, so every entry is nested under "Home".
    A language picker (`cmp-languagenavigation`) and breadcrumb (`cmp-breadcrumb`) are also `<nav>`s.
  - Pictures: Adaptive Image servlet `…/image.coreimg.82.640.jpeg/<timestamp>/name.jpeg` with a srcset, or
    a `data-cmp-src="….coreimg{.width}.jpeg/…"` template; v2 lazy images put the `<img>` in `<noscript>`.
    Older pages use DAM renditions `/content/dam/…/x.jpg/jcr:content/renditions/cq5dam.thumbnail.319.319.png`
    and Dynamic Media `*.scene7.com/is/image/Company/name?wid=…` or `/adobe/dynamicmedia/deliver/…`.
  - Styles: `/etc.clientlibs/<site>/clientlibs/clientlib-site.lc-<hash>-lc.min.css` (older: `/etc/designs/`).
  - Tell-tales: `/etc.clientlibs/`, `data-cmp-is=`, `aem-Grid`, `.coreimg.`, `/_jcr_content/`.
- **Edge Delivery Services (“Franklin”, aem.live)** — authored in Word/Google Docs, served as plain HTML.
  - `main > div` sections; blocks as `div.<block-name>` with nested divs for rows and cells.
  - `div.metadata` and `div.section-metadata` are settings tables, not words.
  - Buttons are `<p><strong><a>` (primary) / `<p><em><a>` (secondary), turned into buttons by JS.
  - Pictures: `<picture>` with `./media_<hash>.jpeg?width=750&format=jpeg&optimize=medium`.
  - **`<header>` and `<footer>` are empty**: `scripts.js` fetches `/nav.plain.html` and `/footer.plain.html`
    (or the paths in `<meta name="nav">` / `<meta name="footer">`).
  - Styles: `/styles/styles.css` with `:root` custom properties (`--link-color`, `--background-color`,
    `--heading-font-family`…).
  - Tell-tales: `/scripts/aem.js` (older `lib-franklin.js`), `media_<hex>` pictures, `*.aem.live`/`*.hlx.page`.

## Already covered
Before this pass (run on the fixtures, no network, no model): headings, text, teaser buttons, accordion
questions/answers, YouTube embeds, mailto/tel contact and footer socials were read; the srcset picked a
640px picture.

## Fixed in this pass
All in `tests/site-platform-aem.test.ts`:
- **Detection** of both kinds; a page that only hot-links a `/content/dam/` picture is not AEM.
- **Menu**: language picker and breadcrumb removed (they filled the menu with `en-GB`, `cy-GB`); the root
  page's children lifted up so "Guided walks" is no longer read as Home's drop-down; real drop-downs kept.
- **Header/footer Experience Fragments** in `<div>`s become `<header>/<footer>`: the logo is now found and
  footer words (address, ©) no longer read as page content; contact and socials still collected.
- **Tabs**: each label becomes its panel's heading (was a list of labels, then the panels).
- **Furniture removed**: carousel Previous/Next/Pause and slide indicators, download Filename/Size/Format,
  sharing links, skip link, search.
- **Pictures**: lazy `<noscript>` images recovered; `data-cmp-src` templates built; small `.coreimg` sizes →
  the servlet's default size; DAM thumbnails → `cq5dam.web.1280.1280.jpeg`; Scene7 → `wid=1600`; Dynamic
  Media OpenAPI → `width=1600`; Edge Delivery `media_` → `width=2000` in jpeg/png (never webply).
- **Edge Delivery**: metadata/section-metadata tables and fragment blocks removed; `<strong>/<em>` links read
  as buttons; video blocks (bare YouTube/Vimeo link) become a thumbnail + "Watch the video" button instead
  of a bare address — and no longer count as a "social profile".
- A whole AEM Sites import (home + About) runs end to end on fixtures.

## Can be done (not done yet)
- **Edge Delivery menu (M, `site-import.ts` + `types.ts`)** — today an EDS import reads only the home page
  (test "known gap"). Add an optional adapter field, e.g. `menuDocument?($, url): string | null`, which for
  AEM returns `new URL(($('meta[name="nav"]').attr('content') ?? '/nav') + '.plain.html', url)`; in
  `readPage`, when `page.navLinks` is empty and the adapter gives a URL, `deps.fetchHtml` it (same SSRF
  fence) and read its links with `readImportPage('<nav>' + html + '</nav>', url).navLinks`. The same for the
  footer (`/footer.plain.html`) would give contact and socials. Fixture: `eds-nav.plain.html`.
- **Magento's detect steals AEM pages (S, `magento.ts`, Magento session)** — `/mage\//` matches `image/`
  (`type="image/webp"` on every EDS `<source>`, Scene7 `/is/image/`). Suggested:
  `/Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config/`. Until then most AEM pages read as
  Magento; the AEM test patches it for its run and records the clash.
- **Theme from CSS custom properties (M, `site-import-theme.ts`)** — on the EDS fixture the main colour came
  out as `--dark-color` and the background as white, not `--link-color` / `--background-color`. Resolving
  `var(--x)` from `:root` before harvesting (and preferring `--link-color`/`--primary*` for the main colour)
  would fix EDS and many other modern sites.
- **Logo through the adapter (S, `site-extract.ts`)** — the logo uses `fullSizeImageUrl`, not
  `adapter.fullSizeImage`; one-line change to use the `fullSize` helper already in `readImportPage`.
- **Report wording for big sites (S, `site-import.ts`)** — when the menu has more pages than
  `IMPORT_MAX_PAGES`, say "We brought in your first 20 pages" (likely on every AEM site).
- **Language versions (S)** — AEM sites live at `/content/<site>/<lang>/…` or `/<country>/<lang>/…`; menu
  pages are all one language today because we drop the picker, which is what we want.

## Can't be done
- **AEM SPA Editor / headless AEM (React/Angular + `model.json`)** — words drawn by JavaScript; only the
  headless-browser read (`site-js-render.ts`) helps, and only when the plain read is under 40 words.
- **Content behind login / closed user groups**, author instances (`author-*.adobeaemcloud.com`) — not public.
- **Experience Fragments or Content Fragments loaded client-side, personalised (Target) content** — not in
  the HTML; we get the default experience.
- **Edge Delivery fragments** (`div.fragment`) — another document JS pulls in; removed, not read (the shared
  fetch above could read them too, M).
- **PDF viewer, forms (AEM Forms), search** — embedded third-party scripts; our hosted pages run none.
- **Whole-site imports** — AEM sites are far beyond our 20-page / 20-section caps by design.

## Suggested improvements to our import
- A generic "menu document" hook (above) also suits other JS-drawn headers.
- Resolve CSS variables in the theme reader (above).
- Let adapters' `fullSizeImage` apply to the logo (above).
- Read a component's caption (`cmp-image__title`) as the picture's alt when the `alt` is empty — would need
  a shared hook ("alt from nearby text"); today the caption is kept as a text block.

## Detection
`CLASSIC`: `/etc.clientlibs/`, `/etc/designs/`, a relative `/content/dam/` address, `.coreimg.`,
`data-cmp-is=`, `aem-Grid`, `/_jcr_content/`, `/jcr:content/`. `EDS`: `/scripts/aem.js|lib-franklin.js|lib-helix.js`,
`ref--repo--owner.aem.live|hlx.page` hosts, `./media_<20+ hex>.ext` pictures.
False positives avoided: absolute `/content/dam/` hot-links. Not tested: sites that rename clientlibs
behind a CDN proxy (other signals usually still match). False negative today: Magento runs first (above).
