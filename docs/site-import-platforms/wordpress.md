# WordPress

Adapter: `src/utils/site-builders/wordpress.ts` · Test: `tests/site-platform-wordpress.test.ts` ·
Fixtures: `tests/fixtures/site-platforms/wordpress/` (synthetic businesses modelled on WordPress's own markup:
a block theme, a classic theme with a contact page, and a theme from before `<main>`).

## How sites on WordPress are built

- **Drawn on the server.** Every page arrives as finished HTML, so the plain read sees all the words; the
  headless browser is never needed (`rendersWithJs: false`). The exception is headless WordPress (a React
  front end that fetches from WordPress), which is not a WordPress page at all and isn't claimed.
- **Two kinds of theme.**
  - *Block themes* (Twenty Twenty-Two onwards, the Site Editor): `<div class="wp-site-blocks">` holding
    `<header class="wp-block-template-part">`, `<main class="wp-block-group">` and a footer template part.
    Content is `wp-block-*` markup: `wp-block-cover` (hero picture as an `<img>`, or a CSS background on older
    covers), `wp-block-buttons > .wp-block-button > a.wp-block-button__link`, `wp-block-columns`,
    `wp-block-media-text`, `wp-block-gallery`, `wp-block-embed` (the YouTube iframe is in the HTML),
    `wp-block-quote`, and `wp-block-query` loops of posts with dates and categories.
  - *Classic themes*: `div#page > #masthead.site-header` (often a `<div>`, not `<header>`),
    `nav.main-navigation > ul.menu > li.menu-item-has-children > ul.sub-menu`, `#content.site-content >
    #primary > main#main.site-main > article > header.entry-header h1.entry-title + div.entry-content`,
    `aside#secondary.widget-area`, `#colophon.site-footer`. Themes from before HTML5 (Twenty Ten–Twelve and
    their many copies) have no `<main>`: the content is `div#content[role="main"]`, the header `div#header`.
- **Menu.** Block themes: `nav.wp-block-navigation` with the phone menu in the same list (no duplicate copy).
  Classic: `ul.menu` with `ul.sub-menu` drop-downs.
- **Pictures.** `/wp-content/uploads/YYYY/MM/name.jpg`; WordPress makes resized copies `name-300x200.jpg`,
  `name-768x512.jpg`, `name-1024x683.jpg`, `name-1536x1024.jpg` and lists them in `srcset`. Since 5.3, uploads
  over 2560px get `name-scaled.jpg` as the "full" size while the camera original stays at `name.jpg`. Jetpack
  serves them through `i0.wp.com/…?resize=300,200` and adds `data-orig-file`; WordPress.com uses
  `site.files.wordpress.com/…?w=300`. Lazy-load plugins (WP Rocket, LiteSpeed, a3) put a blank `data:` SVG in
  `src` and the real address in `data-lazy-src` / `data-ll-src`. The classic editor often links a picture to
  its own file (`<a href="name.jpg"><img src="name-300x225.jpg">`), and older versions filled `alt` with the
  file's name.
- **Colours and fonts.** Block themes keep them in `theme.json`, printed as `<style id="global-styles-inline-css">`
  custom properties `--wp--preset--color--{slug}` and `--wp--preset--font-family--{slug}`, with
  `body{background-color:var(--wp--preset--color--base)}` style rules. WordPress core also prints its own
  12 default swatches (black, white, vivid-red, luminous-vivid-orange…) on **every** site, block or classic.
  Classic themes keep colours in `style.css` and the Customizer's inline `<style>`.
- **Furniture inside the content:** post dates, authors, categories, "Edit" links, comment boxes, "Comments
  are closed", Jetpack sharing and related posts, `.screen-reader-text` labels ("Read more *about Post
  title*", social icons' names), search boxes in the sidebar, "Proudly powered by WordPress".
- **Forms:** Contact Form 7 (`.wpcf7`, `<label>Your name<br><input></label>`), WPForms, Gravity Forms — all
  plain `<form>` with labels, which the shared reader already understands.
- **Tell-tale markup:** `<meta name="generator" content="WordPress 6.x">` (often removed by security plugins),
  `/wp-includes/`, `/wp-content/themes|plugins/`, `<link rel="https://api.w.org/">`, `id="wp-block-library-css"`,
  `id="global-styles-inline-css"`, `wp-block-*` / `wp-image-N` classes, body classes `page-id-N`, `postid-N`,
  `page-template-default`.

## Already covered

Before this pass (no adapter beyond `detect`), tested on the fixtures:
- Headings, paragraphs, list items, quotes and the block editor's buttons (`wp-block-button__link` matches
  `BUTTONISH`), in order; links inside sentences; YouTube embeds in `wp-block-embed`; the largest `srcset`
  picture; CSS-background covers; Contact Form 7 field labels; classic `ul.sub-menu` drop-downs; the H1 inside
  `article > header.entry-header` (the shared reader keeps a `<header>` that is inside the content).

## Fixed in this pass

Each line is proved by a check in `tests/site-platform-wordpress.test.ts`.
- **Detection without the generator tag**: any two WordPress-only signals; a hot-linked uploads picture, a
  link to wordpress.org, Ghost, Drupal and a headless-WordPress Next.js page are not claimed. Other
  platforms' fixtures (whatever exists under `tests/fixtures/site-platforms/`) are checked too.
- **Furniture left out**: post dates, categories, "Read more *about …*" screen-reader text, query pagination
  (was read as a **menu** entry "Next Page"), social-icon labels (were list items "Instagram", "Facebook";
  the profiles are still found), Jetpack "Share this:" / "Related", "Edit “Home”" button, "Leave a Reply /
  You must be logged in", "Comments are closed", "Posted on … by admin", sidebar Archives / Categories /
  Recent Posts / Meta, "Proudly powered by WordPress", "Theme: X by Y".
- **Menu**: the block editor's drop-down was put under the wrong entry ("Garden rooms" under "Home",
  because its `<li>` is classed `wp-block-navigation-submenu`); the site title link no longer replaces
  "Home" as the home page's menu label.
- **Classic `div` headers and footers** become `<header>`/`<footer>`, so the logo is found and the tagline
  isn't read as content. The site title becomes the site name when there is no `og:site_name`.
- **Old themes (`role="main"`)**: only the content area is read (was the whole body: site title as a button,
  tagline, sidebar widgets, search label in the form questions). `contentRoot: 'main, [role="main"], .site-main'`.
- **Search boxes** no longer make every page look like it had an enquiry form.
- **Pictures**: small resized copies (`-300x200`, under 1024px) point at the original; Jetpack CDN and
  WordPress.com resize parameters dropped; Jetpack `data-orig-file` and "linked to its own file" used as the
  exact original; WP Rocket / LiteSpeed lazy-loaded pictures read (were lost entirely); emoji pictures back
  to the character (were imported as a picture); Gravatar avatars dropped; a file name in `alt` is not a
  description (counted as undescribed, described by the nearest heading).
- **Embeds**: WP Rocket's lazy YouTube player (an empty `div.rll-youtube-player`) becomes the video's
  picture and button; a map or video iframe inside a `<p>` (the classic editor does this) is now read — it
  became the "See us on the map" button instead of nothing.
- **The whole import** (`runImport`, no network, no model) on the classic site: home and contact read, the
  logo copied, no furniture in the draft.
- **Look reader written, not wired in** (`readWordPressLook`, tested): the theme's own colours and fonts from
  `--wp--preset--*`, resolving `var()` in body/heading/button rules, ignoring WordPress's 12 default swatches.

## Can be done (not done yet)

- **Wire the WordPress look in (S, main session: `site-builders/types.ts`, `site-import-theme.ts`).** Today the
  shared look reader takes WordPress's default palette as the site's colours: on both fixtures it chose text
  `#000000` and background `#ffffff` (from the core `black`/`white` swatches) instead of the theme's
  `#1f2a24`/`#f7f4ee`, and found no heading font on the block theme (`font-family: var(--wp--preset--font-family--fraunces)`
  is skipped as `var(`). Exact change:
  1. `types.ts` — add to `BuilderAdapter`:
     `look?(html: string, css: string): Partial<{ primaryColor: string | null; secondaryColor: string | null; textColor: string | null; backgroundColor: string | null; headingFont: string | null; bodyFont: string | null }>;`
  2. `site-import-theme.ts` `readImportedLook` — after `const signals = …`:
     `const $ = cheerio.load(html); const own = (() => { try { return adapterFor(html, $)?.look?.(html, css) ?? {}; } catch { return {}; } })();`
     then prefer `own.*` before each current value: `primary = own.primaryColor ?? signals.candidates[0]?.hex ?? null`,
     `text = own.textColor ?? classColour(…) ?? signals.darks[0]`, `background = own.backgroundColor ?? …`,
     `headingFont = own.headingFont ?? firstFamily(tw…) ?? …`, `bodyFont = own.bodyFont ?? …`, and
     `secondaryColor: own.secondaryColor ?? secondColour(…)`.
  3. `wordpress.ts` — add `look: (html, css) => readWordPressLook(html, css)` to the adapter (one line, this file).
  Also worth doing for every platform: drop the 12 core `--wp--preset--color--*` swatches in
  `harvestBrandSignals` (`brand-extract.ts`), since Elementor and WooCommerce sites print them too.
- **Button corners from inline styles (S, `site-import-theme.ts`).** `buttonRadius` reads only fetched
  stylesheets, never the page's `<style>` blocks, so block themes' `.wp-element-button{border-radius:6px}` in
  `global-styles-inline-css` is missed. Pass `allCss` instead of `css`.
- **Try the original, fall back to the copy found (M, `site-import-store.ts`, `types.ts`).** The original
  of a resized picture can be over the 8 MB picture cap or, rarely, not exist (a file uploaded already named
  `banner-1200x600.jpg`). Let `fullSizeImage` return candidates (`[original, asFound]`) and `saveImportedPicture`
  try them in order. Then the 1024px threshold here could go and every picture would come in at full size.
- **Picture description from the heading after it (S, `site-extract.ts`).** In a column the heading usually
  comes after the picture, so an undescribed picture takes the previous column's heading ("Studios" for the
  home-office photo). Use the next heading when the picture is the first thing in its `wp-block-column` /
  card.
- **Sidebar text widgets (S, this file, owner's call).** A classic theme's "Opening hours" text widget sits
  outside `<main>` and isn't read. It repeats on every page, so it was left out on purpose; opening hours
  belong in Business Information. Could be read from the home page only.

## Can't be done

- **Members-only and password-protected pages** (`post-password-form`, membership plugins): behind a login.
- **Pages a security plugin blocks** (Wordfence, Cloudflare bot fight mode on WP hosts): the fetch is refused;
  the import says so.
- **Third-party widgets drawn by script** (Calendly, booking plugins drawing into an empty `div`, Instagram
  feeds, Google reviews widgets): hosted sites run no one else's scripts or frames, and the words aren't in
  the page.
- **Shop prices** (WooCommerce has its own session): prices stay out of sites on purpose.

## Suggested improvements to our import

- The `look` hook above, for every platform that keeps a palette in named variables (Webflow, Squarespace,
  Shopify themes have the same `var()` problem).
- `IMPORT_NOISE`: "Proudly powered by …" (WordPress, also other builders) only matches "powered by …" at the
  start of the line; widen to `(proudly )?powered by .*`.
- An iframe inside a `<p>` is never reached by the walk (the paragraph is read as text and only its `<img>`s
  are looked into). The shared walk could call `addEmbed` for `$(node).find('iframe')` like it does for
  pictures — it would help every platform with a rich-text editor (Ghost, Drupal, Joomla).
- `menuGroupOf`: a `<li>` whose class merely contains "submenu" (the drop-down's own entry) is taken as the
  sub-menu box. Checking `ul, ol, div` only for `SUBMENU_CLASS` would fix it for other builders that name
  the parent `has-submenu`.

## Detection

`detect` = generator tag contains "wordpress", **or** any two of: `/wp-includes/`, `/wp-content/themes|plugins/`,
`rel="https://api.w.org/"`, a `wp-block-library` / `wp-emoji-styles` / `wp-img-auto-sizes` stylesheet id,
`global-styles-inline-css`, `wp-block-*` / `wp-site-blocks` / `wp-embed-responsive` / `wp-custom-logo` /
`wp-image-N` classes, body class `page-id-N` / `postid-N` / `page-template`.

- False positives avoided: the old rule (`/wp-content/` anywhere) claimed any page showing one picture
  hot-linked from a WordPress site, and headless-WordPress front ends (Next.js pages with CMS pictures).
- Not checked against Elementor and WooCommerce: those run on WordPress and their adapters come first in
  `index.ts`. They can import `prepareWordPress($)` and `wordpressFullSizeImage(src)` from this file to get
  everything above. The Mystery Shopper's `site-pages/wordpress-strong.html` is an Elementor page and goes to
  Elementor.
- False negatives: a site that strips the generator tag **and** serves everything through a CDN rewrite with
  no `wp-` markup left (rare; some "white-label" hosts) reads as no platform, and the shared reader still
  reads it.
