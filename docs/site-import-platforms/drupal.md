# Drupal

## How sites on Drupal are built
- **Drawn on the server.** Every word is in the HTML; the headless browser is never needed (`rendersWithJs: false`).
- **Words:** a page is a node. Its body is in `.field--name-body` (Drupal 7: `.field-name-body .field-item`), inside
  `.node__content` (D7: `.node .content`). Longer pages add Paragraphs (`.paragraph--type--<name>`, each one a
  field), or Layout Builder sections (`.layout`, `.layout__region`, `.block-inline-block…`). The page title is a
  separate block (`.block-page-title-block h1`) in the `content_above` region. Lists of posts are Views (`.views-row`).
- **Menu:** a `<nav>` block (`#block-<theme>-main-menu`, `ul.menu`). Drop-downs are nested `li > ul`. Olivero uses
  `primary-nav__menu--level-2`. On **Drupal 7** (Bartik, Zen and their copies), the header and menu are plain
  `<div id="header">` and `<div id="main-menu">`, and there is no `<main>`: the content column is `#content`, the
  parent of the skip-link target `<a id="main-content">`.
- **Pictures:** the original is in `/sites/<site>/files/…`. The page shows image-style copies at
  `/sites/<site>/files/styles/<style>/public/<file>?itok=…`, usually in `<picture><source>` with an `<img>`
  fallback at the smallest size. A style that converts the format adds an extension: `photo.jpg.webp`. Private files
  are at `/system/files/styles/<style>/private/…`. Pictures placed in the text editor are at `/sites/<site>/files/inline-images/`.
- **Furniture that isn't content:** status messages (`[data-drupal-messages]`, D7 `#messages`); local-task tabs
  (View/Edit); breadcrumbs and pagers (both `<nav>`); "Submitted by … on …" (`.node__meta`, D7 `.submitted`);
  comment links ("Log in to post comments"); comments; taxonomy tags; sidebars (`.region--sidebar`,
  D7 `#sidebar-first`); the account menu; "Powered by Drupal"; the admin toolbar and contextual links; text only screen
  readers get (`.visually-hidden`, D7 `.element-invisible`), such as field labels ("Hero image") and block titles ("Main navigation").
- **Colours:** Olivero puts its brand colour on `<html style="--color--primary-hue:…;--color--primary-saturation:…;
  --color--primary-lightness:…">`, as parts rather than a hex. Bartik D7's Color module writes
  `/sites/default/files/color/bartik-<hash>/colors.css`, linked with `@import` inside `<style>`, not `<link>`. Custom
  themes use ordinary stylesheets aggregated to `/sites/default/files/css/css_<hash>.css`.
- **Tell-tale markup:** `<meta name="Generator" content="Drupal 10 (https://www.drupal.org)">`, which many sites
  remove; `<script data-drupal-selector="drupal-settings-json">`; `data-drupal-link-system-path`; `/core/misc/drupal.js`;
  D7 `Drupal.settings` and `/misc/drupal.js`; `/sites/default/files/`.

Fixtures (synthetic: a made-up pottery studio and bakery on `.example` domains, modelled on Olivero, Bartik D7 and
london.gov.uk's markup): `tests/fixtures/site-platforms/drupal/` (`olivero-home`, `olivero-about`, `olivero-contact`, `d7-bartik-home`).

## Already covered
Before this pass, with no adapter work:
- Olivero body text, Paragraphs, Layout Builder blocks, the list, the quote and the button were read in order.
- Drop-downs grouped correctly (`li > ul`).
- The webform's questions were read.
- Contact details came from JSON-LD and `tel:`/`mailto:` links.
- The logo was found.

## Fixed in this pass
Test: `tests/site-platform-drupal.test.ts`, 10 checks.
- **Furniture removed** ("Drupal's furniture is not content"): status messages, "Submitted by", hidden field labels,
  tags, comment links, view counts, comments (spam included), the sidebar, the pager, "Powered by", the admin toolbar.
- **Menu cleaned** ("the menu is the main menu only"): before this, the menu also had breadcrumbs, View/Edit tabs,
  "Log in", sidebar menus, "Next pageNext ›" and the admin link "Manage", all `<nav>`s. Now it has only the main menu, drop-downs kept.
- **Sidebar contact details kept** ("contact details in the sidebar…"): sidebars and D7 footers get
  `role="contentinfo"`, so the import reads their phone, email and social links and then drops them with the footer.
- **Full-size pictures** ("pictures are the originals…", "full-size addresses…"): `styles/<style>/public|private|s3/`
  is stripped, along with `?itok`, the added `.webp`/`.avif` extension and D6 `imagecache/<preset>/`.
- **Drupal 7** ("Drupal 7: the <div> menu is the menu…"): before this the menu was **empty**, and the content was the
  whole page: site name, slogan, "Main menu" with its links as list items, status message, "You are here",
  breadcrumbs, sidebar login block, tabs and footer. Now `#main-menu` is read as the menu, `#header` is the banner,
  `#footer` is the footer, and only the content column is read.
- **Detection** works without the generator tag: settings JSON, `data-drupal-*`, `drupal.js`, `/sites/<site>/files/…`.
- **The whole import** ("runImport reads…"): home, About and Contact are read, every word read lands on the draft,
  and no furniture does.

## Can be done (not done yet)
- **Magento claims Drupal pages. Must fix (S, `src/utils/site-builders/magento.ts`, Magento session or main).**
  Magento's detect `/Magento_|mage\/|requirejs-config/` matches "image/" (`type="image/vnd.microsoft.icon"`,
  `field/image/`, `inline-images/`, `image/webp`). Magento is listed before Drupal, so **every Drupal fixture is read
  as Magento today and this adapter never runs**. The same goes for every adapter listed after Magento (Joomla, the
  headless CMSs, the AI builders). Exact fix: replace `mage\/` with `(?<![a-z])mage\/`, or better
  `/Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config|["'\/]mage\/(?:cookies|requirejs|calendar|gallery)/`.
  My test keeps earlier adapters off Drupal pages until then (comment at the top of the test). Also left in the shared notes folder.
- **Olivero's brand colour (S, `site-import-theme.ts` or `brand-extract.ts`).** Read
  `--color--primary-hue/-saturation/-lightness` from `<html style>` (or `:root`) and turn the HSL into a hex for
  `primaryColor`. Today the look reads nothing from the Olivero fixture (all null).
- **Stylesheets in `@import` (S, `site-import.ts`, where `fetchCss` URLs are collected).** Follow `@import url(…)` inside
  `<style>`, which Drupal 7 uses for every stylesheet (Color module included), so Bartik colours are found.
- **Skip Drupal system paths in the menu (S, `site-import.ts` `SKIP_PATH`).** Add `user`, `node/add`, `admin`,
  `taxonomy/term/`, `rss.xml`, `filter/tips`. They rarely show to visitors, but custom themes sometimes link them.
- **Very large originals (M, `site-import.ts` savePicture caller).** Drupal keeps the uploaded original as is.
  Without a max-resolution setting that can be a 6000 px camera file. If the library doesn't resize on copy, fall back
  to the largest `srcset`/`<source>` style when the original is over a size limit.

## Can't be done
- **Private files** (`/system/files/…`) that need a login: the import is anonymous, so those pictures can't be copied.
- **Content behind login** (members' pages, Organic Groups) or pages that are only Views with exposed filters: we read what an anonymous visitor sees.
- **Webforms, comments, search and Commerce carts** don't come across as working features. Our contact form replaces
  the webform (its questions are listed in the report). Prices stay out on purpose.
- **Drupal 7 themes that rename everything** (no `#content`, `#main-menu`, `<a id="main-content">`): the import falls
  back to `<body>`, and the generic header/footer rules apply.

## Suggested improvements to our import
- **Read `<picture><source srcset>`** in `addImage` as well as `img[srcset]`. Drupal, WordPress and many builders put
  the large sizes in `<source>` and the smallest in `<img>`. Without a `fullSizeImage` rule, the smallest is what we copy.
- **Run the adapter's `noise` on headings too.** Today headings are checked against `IMPORT_NOISE` only, so a visually
  hidden "Main navigation" heading needs removing in `prepare`.
- **Have `adapterFor` let a generator tag win**: a page whose `<meta name="generator">` names a platform should go to
  that adapter before any loose markup regex. That would have avoided the Magento problem above.
- **Have the site-builders test check each platform's fixtures pick its own adapter through `adapterFor`**, so one
  adapter's loose regex can't quietly take over another's pages.

## Detection
`gen.includes('drupal')`, or any of: `drupal-settings-json`, `data-drupal-selector|link-system-path|messages`,
`Drupal.settings` (D7), `/core/misc/drupal.js`, `/misc/drupal.js`, `/sites/<site>/files/(styles|css|js|inline-images)/`, `/sites/default/files/`.
- **False positives:** a non-Drupal page hot-linking a picture from a Drupal site's `/sites/default/files/`. This was
  already true before this pass, and is rare.
- **False negatives:** Backdrop CMS (a Drupal 7 fork, `/core/misc/backdrop.js`) isn't detected. Its markup is close to
  D7, so adding it would be cheap. Headless Drupal (Next.js front end) has none of these signals and is read by the
  front end's adapter, which is right.
- **Order:** Magento's loose regex claims Drupal pages first (see Can be done).
