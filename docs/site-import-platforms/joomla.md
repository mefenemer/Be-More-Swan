# Joomla

Adapter `src/utils/site-builders/joomla.ts` · test `tests/site-platform-joomla.test.ts` · fixtures
`tests/fixtures/site-platforms/joomla/` (synthetic pages modelled on Joomla's own template and layout
source, not copied from any business). Researched 2026-11-08 from the joomla-cms source
(templates/cassiopeia/index.php, com_content article/featured layouts, layouts/joomla/content/readmore.php,
HTML/Helpers/Email.php) and the public markup of joomla.org, community.joomla.org and joomshaper.com.

## How sites on Joomla are built

- **Server-rendered.** Every word is in the HTML; the headless browser is never needed.
- **Words** come from the component (`com_content`: `.item-page` for one article, `.blog-featured` /
  `.blog-item` for the home page and category blogs, `com_contact` for contact pages) and from
  **modules** in template positions. Owners put their hero and selling points in Custom modules
  (`.mod-custom` / `.custom`, Joomla 3 `.moduletable`).
- **`<main>` wraps only the component.** Cassiopeia puts `banner`, `top-a`, `top-b`, sidebars, `bottom-a`,
  `bottom-b` in `.site-grid` *around* `<main>`; Helix Ultimate has `#sp-section-*`, `#sp-bottom` and
  `aside#sp-right` around `main#sp-component`; joomla.org's hero is a module outside `main#content`.
- **Module chrome:** Cassiopeia `div.<position>.card > h3.card-header + .card-body`; Joomla 3
  `div.moduletable > h3` or `div.well`; Helix `div.sp-module > h3.sp-module-title + .sp-module-content`;
  YOOtheme `div.uk-panel` / `.uk-card`.
- **Furniture modules** (not page content): breadcrumbs, login, smart search/search, latest/most-read
  articles, archive, tags, who's online, languages, syndication.
- **Article furniture:** `dl.article-info` ("Details", "Written by", "Category", "Published", "Hits"),
  print/email icons, tag lists, previous/next (`nav.pagenavigation`), "Read more: Title" buttons.
- **Menu:** `mod_menu` → `ul.mod-menu > li.nav-item` with sub-menus in `ul.mod-menu__sub` (Joomla 3:
  `ul.nav.menu`, `li.deeper.parent`). Helix: `ul.sp-megamenu-parent` with sub-menus inside
  `div.sp-dropdown`; YOOtheme: `ul.uk-navbar-nav` with `div.uk-navbar-dropdown`, plus a mobile copy in an
  `uk-offcanvas` dialog.
- **Pictures** live under the site root's `/images/` (media manager) and `/media/` (extensions). The media
  field can leave `#joomlaImage://local-images/…?width=…&height=…` on the address; editor pictures often
  have a relative `src="images/…"`, which on a non-rewritten URL (`/index.php/about-us`) resolves wrongly.
  YOOtheme serves resized copies from `/templates/yootheme/cache/xx/name-hash.ext` and draws section
  backgrounds lazily with `data-src` + `uk-img`.
- **E-mail addresses are cloaked** by default: Joomla 4/5 `<joomla-hidden-mail first="b64(name)"
  last="b64(domain)" text="b64(words)">`, Joomla 3 a `span#cloakXXXX` plus a script that concatenates the
  address. Without JavaScript the page says "This email address is being protected from spambots…".
- **Colours:** Cassiopeia keeps them as CSS variables — the template's own
  `--cassiopeia-color-primary/-link/-hover` in `/media/templates/site/cassiopeia/css/global/colors_*.css`,
  and the owner's choices inline in `<head>` as `--template-link-color`, `--template-special-color`,
  `--template-bg-light`, `--template-text-dark`. Helix and YOOtheme compile a theme stylesheet
  (`/templates/<name>/css/…`).

## Already covered

Before this pass, on the fixtures (with `plan` returning null): the component's headings, paragraphs and
article pictures; the Cassiopeia menu with `mod-menu__sub` drop-downs (generic `li > ul` rule); the
logo; phone links. Joomla was detected by its generator tag, `/media/jui/` or `/components/com_`.

## Fixed in this pass

Each proven in `tests/site-platform-joomla.test.ts`:

- **Modules outside `<main>` are read** (Cassiopeia banner/top-a/sidebar/bottom-a, Helix hero and
  bottom): when the owner's own modules sit outside `<main>`, the page is read from `<body>` in page
  order. Home fixture 65 → 126 words; joomla.org's real home page 77 → 522 words.
- **Furniture out, with its module title:** login, search, latest/most-read, breadcrumbs, article
  details, tags, previous/next, system messages, screen-reader-only labels, to-top links, pre-loaders,
  off-canvas menus. A furniture module's chrome goes too when it holds nothing else ("Latest Articles").
- **Joomla's lines filtered** (`noise`): "Written by…", "Hits: 812", "Published: …", the cloaking
  sentence, "Joomla! is Free Software…".
- **"Read more: Our story" / "Read more …" → "Read more"**, still linking to the article.
- **Cloaked e-mails decoded** (Joomla 4/5 element and Joomla 3 script) into a `mailto:` link, so the
  address reaches the words *and* the site's details.
- **Pictures:** `#joomlaImage://…` dropped (`prepare` and `fullSizeImage`); relative `images/…` /
  `media/…` anchored to the site root (from `joomla-script-options` `system.paths.root`, else the part
  before `index.php`); YOOtheme `data-src` + `uk-img` backgrounds become CSS backgrounds the import reads.
- **Menus:** the logo's link is no longer a menu entry ("Dale End Bakery", "Back to home"); Helix
  `sp-dropdown` and UIkit `uk-navbar-dropdown` boxes are unwrapped so their items group under the parent.
- **Helix top bar:** its contact strip and social icons are moved into a footer, so the phone and social
  profiles are still read but the strip isn't page content.
- **Detection** also matches Joomla's script options, `/media/system/js/`, `/media/templates/site/`,
  `<joomla-…>` custom elements and the `com_xxx … view-` body classes — catches sites (often YOOtheme)
  that remove the generator tag.

## Can be done (not done yet)

- **Magento's detect claims Joomla pages (S, `site-builders/magento.ts`).** `/Magento_|mage\/|…/`
  matches `image/` MIME types (`type="image/webp"`, Joomla's default favicon
  `type="image/vnd.microsoft.icon"`, `og:image:type`). All six real Joomla pages fetched
  (joomla.org, magazine/community/volunteers.joomla.org, joomshaper.com) came back `magento`, because
  Magento sits before Joomla in `ADAPTERS`; so does the YOOtheme fixture (`type="image/webp"`). Fix in magento.ts,
  e.g. `/Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config|data-mage-init|x-magento-init/`.
  Sent to the Magento session; the Joomla test sets the clash aside and logs it until then.
- **Cassiopeia colours (S–M, `site-import-theme.ts` / `brand-extract.ts`).** Read the inline
  `--template-link-color` / `--template-special-color` / `--template-bg-light` / `--template-text-dark`
  (owner's choices) before `--cassiopeia-color-*` (template defaults, #112855 blue that is *not* the
  owner's brand). Not checked how `harvestBrandSignals` ranks these today.
- **YOOtheme cached pictures (M, `site-extract.ts`).** `/templates/yootheme/cache/…-hash.jpeg` is a
  resized copy whose original name can't be derived. YOOtheme's builder often also has `data-src`
  pointing at `/images/…` originals; preferring an `/images/` address over a `cache/` one when an element
  offers both would get originals.
- **`com_contact` pages (S, adapter only).** The contact's address (`.contact-street`, `.contact-suburb`,
  `.contact-postcode`) could be turned into an `<address>` so it fills the site's address; not written
  for lack of a fixture yet.
- **Joomla 3 `ul.nav.menu` without `<nav>` (S, adapter only).** Protostar menus sit in a `div.moduletable`,
  not `<nav>`; when outside `<header>` they are not read as the menu. Untested.

## Can't be done

- **Members-only articles** ("Register to read more") — behind a login.
- **Owner's own extensions' widgets** (forms from RSForm/Chronoforms, galleries, sliders drawn by JS):
  hosted sites run no scripts; their words are read when they are in the HTML, nothing more.
- **SP Page Builder / YOOtheme animated counters, sliders** — kept only as far as their HTML words go.

## Suggested improvements to our import

- **Let an adapter say "read from <body>"** (or give `contentRoot` a list of selectors to read in
  order) instead of renaming `<main>` in `prepare`. Joomla, Drupal (regions) and most CMSs wrap only the
  main component in `<main>`.
- **Read contact details after `prepare` removes nothing**: today tel/mailto/social links are collected
  after `prepare`, so an adapter that removes a contact strip loses them; collecting those from the
  untouched page would make adapters safer.
- **Lazy backgrounds:** recognise `data-src` on a non-`<img>` element (UIkit, lazysizes `data-bg`) in
  `bgImage`, for every platform.
- **Menu groups:** `menuGroupOf` returns null when a sub-menu box has no previous sibling; continuing up to
  the parent `li` would cover Helix/UIkit/mega-menus without each adapter unwrapping them.

## Detection

`gen.includes('joomla')` (Joomla 3–6 print "Joomla! - Open Source Content Management" unless removed), or
the raw HTML has `/media/jui/` (Joomla 3), `/components/com_`, `/media/system/js/`,
`/media/templates/site/` (Joomla 4+), `class="joomla-script-options`, a `<joomla-…>` custom element, or a
`<body>` class pair `com_xxx … view-`. Claims none of the 13 saved pages in `tests/fixtures/site-import/` and `site-pages/`; a
plain page with `/images/` is not claimed (tested). False negative: a Joomla site that strips the
generator and serves every asset from a CDN with no `/media/` path. False positive risk: none known —
but see Magento above, which wins first on Joomla pages until its pattern is anchored.
