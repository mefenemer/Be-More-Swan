# Weebly (and Square Online)

Adapter `src/utils/site-builders/weebly.ts` (key `weebly`), test `tests/site-platform-weebly.test.ts`,
synthetic fixtures `tests/fixtures/site-platforms/weebly/` (a made-up bike workshop; no real business's
words or pictures). Studied 2026-11-08 from a handful of public `*.weebly.com` sites and two public
Square Online sites (markup only).

## How sites on Weebly are built

**Classic Weebly** (Square bought Weebly in 2018; classic sites still run, on `*.weebly.com` or a custom
domain behind Cloudflare) is **server-rendered**: every word is in the HTML.
- Tell-tales: CSS and scripts from `cdn*.editmysite.com`, `wsite-*` classes everywhere
  (`#wsite-content`, `wsite-elements`, `wsite-section`, `wsite-content-title`), `STYLE_PREFIX = 'wsite'`,
  the "Powered by Weebly" box `#weebly-footer-signup-container-v3`. No generator tag.
- **Menu**: `ul.wsite-menu-default > li.wsite-menu-item-wrap > a.wsite-menu-item`, in a theme div
  (`#menu`, `.nav`, `#navigation`) — **not in `<nav>` or `<header>`**, and printed two or three times
  (desktop, phone, a "dummy" copy). **Sub-pages are not in the HTML at all**: the flyouts are drawn
  from the JSON in `initPublishedFlyoutMenus([{title,url,children:[…]}], …)`.
- **Logo**: `.wsite-logo` (an `<img>` or the title words `#wsite-title`), often in a div, not `<header>`.
- **Words**: titles are `h2.wsite-content-title`; a text box is **one `div.paragraph`** split by
  `<br><br>`, sometimes with a `<ul>` inside. Columns are a **table** (`table.wsite-multicol-table` /
  `td.wsite-multicol-col`). Header sections: `.wsite-header-section` with an inline background picture.
- **Pictures**: `/uploads/1/2/3/4/<site id>/…`, with `published/` (as cropped on the page) and
  `editor/` variants and a `?1700000000` cache-buster. Weebly's default description is "Picture".
  Gallery thumbnails link to the original `name_orig.jpg` (lightbox). **Slideshows exist only in a
  script**: `wSlideshow.render({elementID, images:[{url:"1/2/3/4/…/x.jpg", caption}]})`.
- Maps frame `weebly.com/weebly/apps/generateMap.php?…&lat=…&long=…`; videos frame YouTube.
- Email addresses are often hidden by Cloudflare: `/cdn-cgi/l/email-protection#<hex>` and
  `span.__cf_email__[data-cfemail]` showing "[email protected]".
- Colours and fonts: the theme's `/files/main_style.css` plus inline `<style>` rules keyed on `.wsite-*`
  (usually empty unless the owner changed fonts in the editor).
- Blog: `.blog-post`, `.blog-title`, `.blog-date`, `.blog-content`, `.blog-sidebar` (archives, categories,
  RSS), comment counts and a share bar. Store: `.wsite-com-product-*`.

**Square Online** (the successor; `*.square.site` or a custom domain) is **JavaScript-drawn**: the
body is `<div class="loading-view">…</div><div id="app"></div>`, generator `Square Online`, scripts from
`cdn3.editmysite.com/app/website/`. But the page itself is sent in the HTML as JSON:
`window.__BOOTSTRAP_STATE__ = {…}`:
- `siteData.page.properties.contentAreas` — `banner` (title/image/button elements) and `userContent`
  (`container.cells[].content` blocks such as `text-and-image@^1.0.0`, each with `repeatables` holding
  `title`, `text`, `image.figure` and `button`). Words are **Quill ops** (`{insert, attributes}`; lists
  `{list:"bullet"}`, links `{wLink:{type:"page", link:{page:{pageID}}}}` / `external` / `email`).
  Hidden things carry `hidden: true` (theme placeholders such as "View products" stay in the JSON);
  a title element's string `label` is a stale theme default, not what shows.
- `siteData.pagesMeta` (id → name, route), `snapshot.properties.homePage`, `routeMap`.
- Menu: `autoNavLinks` (pages by id, store categories, external links, `children`).
- Logo `snapshot.properties.logo`; colours `snapshot.properties.color.primaryColor` (+ colour profiles);
  fonts `fontPair`; corners `shapes`; social profiles `social[] {icon, user, selected}`.
- Pictures `/uploads/b/<hash>/<name>.jpg`, served from the site's own host and from
  `IMAGE_HOST` (`<hash>.cdn6.editmysite.com`), sized on request (`?width=640&optimize=high&dpr=2`).

## Already covered

Before this pass (fixtures run through `readImportPage` / `runImport` with fake deps, no network, no
model), classic Weebly already gave: the header section's background picture, `h2` titles, buttons
(`a.wsite-button`), YouTube videos (thumbnail + "Watch the video"), quotes, phone numbers, social
links, `og:site_name`. `detectBuilder` already reported `builder: 'square'` for both.

What was lost: the whole menu (read as list items in the page instead; sub-pages never seen), the logo
(read as a page picture), "Cart 0", the footer's "Powered by"/"Create your own unique website…"/"Get
Started" and Weebly's advert picture, **the sentences around a list in a text box (dropped entirely)**,
an inline link turned into a button, each column collapsed into one text block ("Servicing Our
workshop stand A full strip-down…"), "Picture" kept as a real description, gallery thumbnails instead
of originals, every slideshow picture, the map, the email address ("[email protected]"), and on blog
pages dates, "0 Comments", archives, categories and "RSS Feed". **Square Online gave nothing: 0 words**
(the import then needs the headless browser, and says the site can't be read if that fails).

## Fixed in this pass

All in `weebly.ts`, each proven in `tests/site-platform-weebly.test.ts`:
- **Menu with sub-pages** from `initPublishedFlyoutMenus` (nested, so drop-downs get their group);
  without the script, the page's `ul.wsite-menu-default` is treated as the menu; copies removed from the
  content. The logo's link home no longer takes the menu's "Home" place. → "the menu is read from
  Weebly's script…", "without the script…"; `runImport` now tries the sub-pages too.
- **Logo** picked as the logo (`.wsite-logo` → header). → "the logo is the logo…"
- **Text boxes** split at `<br><br>` into paragraphs, lists kept, links stay in their sentence. → "a
  text box split by blank lines…"
- **Columns** read as columns (table → divs). → "columns keep their headings…"
- **Pictures**: "Picture"/"Image" descriptions ignored; gallery originals (`_orig`); slideshow pictures
  from the script with their captions as descriptions; cache-buster dropped. → "pictures: …"
- **Map** → a Google Maps link button (via the existing map-embed path); **Cloudflare email** decoded
  (contact + the sentence). → "Weebly's map becomes a map link…"
- **Furniture** out: Weebly footer box, search, log-in, cart, hamburger, spacers; footers retagged as
  `<footer>` like other platforms; blog dates, comment counts, share bar, sidebar. Noise lines for "0
  Comments", "RSS Feed", "Get Started", "Powered by Weebly"… → "Weebly's furniture…", "a blog page…"
- **Square Online read without a browser**: `prepare` turns `__BOOTSTRAP_STATE__` into a header (logo
  + menu from `autoNavLinks`, sub-pages grouped, store categories left out) and a `<main>` (banner and
  rows in order; Quill → paragraphs/lists/headings; page links resolved by id to routes; email links;
  original pictures with `altText`; visible buttons with a destination). Hidden elements, theme
  placeholder labels and store blocks (featured products, order online…) stay out. Picture sizes
  dropped from `editmysite.com`/`/uploads/b/` addresses. A broken bootstrap falls back to reading the
  page. → the four "Square Online" checks and "the home page imports without the headless browser".
- **Detection** tightened (see below).

## Can be done (not done yet)

- **Square Online colours, fonts and corners** from the bootstrap (`color.primaryColor`,
  `fontPair.id`, `shapes.buttonBorderRadius`) — today the look is read from CSS, which Square Online
  draws at run time, so nothing is found. Needs a hook for adapters to supply a look, e.g.
  `BuilderAdapter.look?(html: string): Partial<ImportedLook> | null` in `site-builders/types.ts`, called
  from `site-import-theme.ts readImportedLook` (or `site-import.ts`) when CSS gives nothing. **M**,
  main session (`types.ts`, `site-import-theme.ts`).
- **Square Online social profiles** (`snapshot.properties.social[]` with `selected: true`) — the profile
  links are built by the app. Could be written into the generated header as `<a href>`s by this
  adapter, but `user` is a handle whose URL shape varies per network (`facebook.com/<user>`,
  `instagram.com/<user>`, LinkedIn `in/…`), so it is guessing. **S**, own file, if the owner wants it.
- **Square Online footer contact block** (address, hours) lives in footer content areas / site
  settings not seen in the two sites studied; check on more sites. **S–M**, own file.
- **Weebly `published/` and `editor/` pictures → the uncropped original** (`…/name.jpg` or
  `name_orig.jpg`): not done because the original isn't guaranteed to exist and a wrong guess loses
  the picture. Would need a "try this, else fall back" picture copy: `fullSizeImage` returning a list of
  candidates, tried in order by `savePicture`. **M**, main session (`types.ts`, `site-import.ts`).
- **The footer's address line** ("4 Mill Lane, Brindlemoor") is dropped with the footer, as on every
  platform; `site-extract.ts` only reads `<address>`/JSON-LD. A generic "footer text that looks like an
  address" read before the footer is removed would help all platforms. **M**, main session
  (`site-extract.ts`).
- **Weebly store pages** (`.wsite-com-product-*`): product names/descriptions could be read as items;
  prices are already reported and kept off. Not studied in depth. **M**, own file.
- **Weebly blog posts** themselves (the list page gives titles and the first paragraph only): belong to
  the Blog Assistant import (another session), not the page import.

## Can't be done

- **Square Online's other pages are not in the home page's JSON** — each page's HTML carries only its
  own `contentAreas`, so each menu page must still be fetched (it is: the menu gives their routes).
- **Members-only pages** (Weebly "Members" / Square Online customer accounts) need a log-in.
- **Weebly embed boxes** (`.wcustomhtml`) and Square Online `embed-code` blocks hold arbitrary HTML,
  often third-party widgets (booking, forms) — hosted sites frame no third parties and run no scripts;
  their plain words are read where they are in the page.
- **Square Online ordering, items and prices**: store data comes from Square's catalogue API, not the
  page; prices belong in Business Information anyway.
- Weebly theme **background pictures set only in the theme's CSS** (`.wsite-header` with no inline
  style) are not page content.

## Suggested improvements to our import

- **Order in `site-builders/index.ts`**: `godaddy` (`/godaddy/i` anywhere in the HTML) and `hostinger`
  (`/zyro/i`) come before `weebly`, so a Weebly page whose words mention GoDaddy (e.g. "domain from
  GoDaddy") would be read by the GoDaddy adapter. Either tighten those tests to markup (`img1.wsimg.com`
  only) or move `weebly` above them — Weebly's `editmysite.com`/`wsite-` test is specific. **S**.
- **`readImportPage` drops a `div`'s own text when it also has block children** (`ownText && hasBlock`
  walks the children, and bare text nodes are skipped). Weebly's text box hit this; any builder that
  writes "text<ul>…</ul>text" in one div loses sentences. A generic fix in `walk`: collect consecutive
  inline/text children into a text block before descending. **S–M**, `site-extract.ts`.
- **`td` is read as one text block** even when it holds headings and pictures (layout tables, Weebly
  columns, old hand-made sites, email-style pages). Treat a `td`/`th` with block children like a `div`.
  **S**, `site-extract.ts`.
- **"Picture" as a description**: add `picture` to `realAlt`'s list of non-descriptions (Weebly's
  default; other builders use it too). **S**, `site-extract.ts`.
- **Cloudflare email protection** is on many small-business sites, not just Weebly: decode
  `data-cfemail` / `/cdn-cgi/l/email-protection#…` in `readImportPage` itself (the decoder is
  `decodeCfEmail` in `weebly.ts`, nine lines, can move). **S**, `site-extract.ts`.
- **Logo choice**: when `adapter.prepare` can't wrap a logo in `<header>`, let adapters name it —
  `BuilderAdapter.logoSelector?: string` (`.wsite-logo img`). **S**, `types.ts` + `site-extract.ts`.
- `ImportPage['builder']` still says `'square'` for classic Weebly too; with `platform` now set the
  report could word it "Weebly / Square Online". **S**, `site-import.ts` report wording.

## Detection

`detect` = generator contains `weebly` or `square online`, **or** the HTML references `editmysite.com`
or `weebly.com/`, **or** has a `class="…wsite-…"`. Every classic Weebly page loads its CSS from
`cdn*.editmysite.com` and every Square Online page its app from `cdn3.editmysite.com` (and has the
generator tag), so both are found on custom domains.
- Changed from `/editmysite\.com|weebly/i`: the bare word "weebly" matched a page that only *mentions*
  Weebly ("we moved off Weebly") — tested as a non-match now.
- Remaining false negatives: a page whose HTML mentions GoDaddy/Zyro is claimed earlier by those
  adapters (see above). A Weebly page saved without its stylesheet links and classes (unlikely) is missed.
- Square Online vs classic is decided in `prepare`: a parsable `__BOOTSTRAP_STATE__` with page content
  → Square Online path; otherwise the classic path.
