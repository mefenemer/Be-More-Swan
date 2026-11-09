# Tilda

## How sites on Tilda are built
- **Server-rendered.** Every block ("record", `div.t-rec` with `data-record-type="NNN"`) is in the HTML
  inside `div#allrecords.t-records`. Newer sites put the menu and footer in `<header id="t-header">` /
  `<footer id="t-footer">` (both also `.t-records`). Older sites keep the menu (`t228`, `t450`,
  `data-menu="yes"`), its drop-downs (`t794`, `data-tooltip-hook="#submenu:name"`) and the footer as
  ordinary records inside `#allrecords`. No `<main>`, rarely a `<nav>`. A `<meta name="generator">`
  saying Tilda is only sometimes there.
- **Words.** Standard blocks mark fields with `field="title|descr|text|li_title__N…"` and classes
  `t-title`, `t-descr`, `t-text`, `t-name`, `t-heading`, `t-uptitle`. Titles are *sometimes* real
  `h1`–`h3` and often `<div class="t-title">`; card titles are `<div class="t-name">` inside `ul > li`.
- **Zero Block (`t396`).** Free-form block: `.t396__artboard` holds `.t396__elem[data-elem-type=text|image|button|shape|…]`,
  each absolutely positioned. Position is in `data-field-top-value` / `data-field-left-value` (with
  `-res-320/480/640/960-` versions for phones) and/or in the record's own `<style>`
  (`#recN .tn-elem[data-elem-id="…"]{top:…;left:calc(50% - 600px + 20px)}`, `@media` rules for phones).
  Elements can sit inside `.t396__group` / `.tn-molecule` groups. **Source order = the order they
  were added in the editor**, not reading order. Text is a `<div class="tn-atom">` unless the owner
  picked h1–h6; size lives in `.tn-elem[data-elem-id] .tn-atom{font-size:…}`.
- **Pictures** are lazy. `<img class="t-img" src="https://thb.tildacdn.com/tildXXXX/-/empty/name.jpg"
  data-original="https://static.tildacdn.com/tildXXXX/name.jpg">`; backgrounds are
  `div.t-bgimg[data-original]` with a 20px `-/resizeb/20x/` thumbnail in `style`, or no style at all
  (galleries), described by `aria-label`. `optim.tildacdn.*` serves webp copies
  (`…/-/format/webp/name.jpg.webp`). Regional domains: `tildacdn.com`, `.net`, `.one`, …
  Zero Block pictures may have **no `src` at all**, only `data-original`.
- **Colours and fonts** are in inline `style=""` on buttons/blocks, per-record `<style>` tags and
  `tilda-blocks-page*.min.css`; default font "TildaSans".
- **Furniture:** "Made on Tilda" (`.t-tildalabel#tildacopy`, outside `#allrecords`), pop-ups
  (`.t-popup`, opened by `#popup:name` links) usually holding forms, `t-form__successbox` lines.
- **Drawn with JavaScript:** Tilda Store product grids (`t-store`) and blog feeds (`t-feed`) load from
  Tilda's API after the page opens. Everything else is in the HTML.

## Already covered
(Today's import on `tests/fixtures/site-platforms/tilda/`, before this pass.)
- Words in standard blocks, real `h2`/`h3` titles, `t-btn` buttons (the `BUTTONISH` class test), the
  newer `<header>` menu, the logo, email/phone/socials from the footer, `©` lines dropped as noise.
- `#popup:` button links already came out with no link (hash links are never kept).

## Fixed in this pass
All in `src/utils/site-builders/tilda.ts`; tests in `tests/site-platform-tilda.test.ts` (13 checks).
- **Full-size pictures:** `img[data-original]` → `src`; `.t-bgimg[data-original]` → an `<img>` (alt =
  its `aria-label`); `fullSizeImage` maps any `thb`/`optim` copy back to `static.tildacdn.<tld>/tildXXXX/name`
  (drops `/-/…` chains and the extra `.webp`). Was: 20px/empty thumbnails, and Zero Block / gallery
  pictures lost entirely. *("lazy pictures come at full size…", "background-only gallery picture…",
  "the full-size address…")*
- **Titles:** `div.t-title[field]` → h2; `div.t-name` / `div.t-heading` with a title field → h3.
- **Cards:** `ul > li` holding a title becomes plain boxes, so each card is title + words + picture,
  not one run-on list item.
- **Zero Block reading order:** elements sorted top-to-bottom (rows within 16px left-to-right), from
  `data-field-*` or the record's desktop CSS (`@media` ignored; `axisy` centre/bottom allowed for),
  taken out of groups. Text ≥36px (≤120 chars) → h2, ≥24px (≤80 chars) → h3; owner-chosen h1–h6 kept.
- **Zero Block pop-up buttons** become buttons with no link (were read as plain text).
- **Menus:** newer `t-menusub` drop-downs are read as groups; drop-down labels (`href=""`/`#submenu:`)
  are not pages; the logo link no longer renames "Home". **Older sites:** the `data-menu="yes"`
  record becomes the header (menu + logo found, menu words no longer read as the page), and `t794`
  drop-downs are moved under their menu entry.
- **Furniture removed:** `contentRoot: '#allrecords'` (so "Made on Tilda" and its badge go),
  pop-ups containing a form (their title too), Tilda's form messages as `noise`.
- **Detection** no longer fires on a page that merely hot-links a `tildacdn.com` picture.
- `runImport` with fake deps (no network, `plan` null) reads both pages and copies only full-size pictures.

## Can be done (not done yet)
- **Theme reads Tilda's colours** (S, `site-import-theme.ts`): the main colour is the `t-btn` inline
  `background-color` and Zero Block button CSS; text colour is in `.tn-atom{color}`; fonts in
  `--t-headline-font` / `--t-text-font` custom properties. An optional adapter hook
  `readLook?(html, css): Partial<ImportedLook>` in `types.ts`, called from `readImportedLook`, would let
  each platform add its own; Tilda's would read `--t-headline-font`, `--t-text-font` and the most
  common `t-btn` background.
- **Tilda Store / blog feed** (M, `site-import.ts` + new fetch): the store's product JSON
  (`store.tildaapi.com/api/getproductslist/?storepartuid=…`) and feeds (`feeds.tildaapi.com/api/getfeed/?feeduid=…`)
  are public, but a new host would need adding to the SSRF fence's allow-list and a `fetchJson`
  path like Wix's. Product words could go to Business Information (prices never to the site).
  Today the headless-browser fallback only kicks in under 40 words, so a store page with a heading
  and intro text loses its products silently.
- **Report wording** (S, `site-import.ts`): say "Your Tilda store/blog feed is drawn after the page
  loads" when `t-store`/`t-feed` is present. Needs a field such as `ImportPage.jsDrawnParts`.
- **Pop-ups without forms** (S, this file): kept as page words today. They might belong at the end
  of the page instead; that needs a way to mark a block as "hidden on the old site" for the planner (`site-extract.ts`).

## Can't be done
- **Forms:** Tilda forms post to Tilda's form service with the project key; our hosted site has its
  own contact form, so only the questions are listed (as for every platform).
- **Animations, sliders' autoplay, Zero Block hover effects, custom HTML blocks (T123) that run
  scripts:** hosted sites run no scripts and frame no third parties.
- **Members-only pages** (Tilda Members) are behind login.
- **Exact Zero Block layout:** our sections are a closed set; the free-form layout becomes ordered
  blocks. Two text columns side by side read row by row (left heading, right heading, left text,
  right text) when their tops line up. That's acceptable for cards, but not perfect.

## Suggested improvements to our import
- `addImage` could read `data-original` and `data-lazy-src` generally (Tilda, and many lazy-load
  plugins use `data-original`), and the logo read could use the adapter's `fullSizeImage` like the
  body pictures do (`site-extract.ts`, ~line 762 and 814). Small change; helps any lazy-loading site.
- `bgImage` could use a box's `aria-label`/`role="img"` as the picture's description.
- `menuGroupOf`'s `SUBMENU_CLASS` could also match `menusub` (Tilda) without needing an adapter.

## Detection
- `<meta name="generator">` containing "tilda", or Tilda's page skeleton: `id="allrecords"`,
  `data-tilda-page-id=`, `data-tilda-project-id=` (present on every published and exported Tilda
  page seen, including tilda.cc and tilda.education).
- Not `tildacdn.com` alone: any site can hot-link a Tilda-hosted picture (false positive, tested).
- False negatives: none found. A page built elsewhere that copied Tilda's exported HTML would still match,
  which is the right adapter for it anyway.
