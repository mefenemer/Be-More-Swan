# Duda

## How sites on Duda are built
Duda is a white-label builder: agencies, hosting companies and marketing firms resell it under their own
name, so owners often don't know they are on Duda. Pages are **drawn on the server** (Duda's own SEO
page says the content is fully server-rendered), so the plain fetch has all the words; no headless
browser is needed.

- **Body**: `<body id="dmRoot" class="dmRoot dmDesktopBody …">` → `#dm` → … → `#dmFirstContainer.dmBody`
  → `#dm_content.dmContent[role="main"]` (a `div`, not `<main>`). Everything the owner wrote is in
  `#dm_content`.
- **Two layouts**: *classic* rows (`.dmRespRow > .dmRespColsWrapper > .dmRespCol`) and the newer *flex*
  layout (`[data-auto="flex-section"] > section.flex-element > .flex-element.grid/.group/.widget-wrapper`).
  Words in both are `.dmNewParagraph` boxes holding ordinary `h1–h6`/`p`/`ul`.
- **Header / footer / phone menu** are plain divs: `.dmHeaderContainer` (`#hcontainer`),
  `#hamburger-header-container`, `#hamburger-drawer` (the phone menu, which on "hamburger" layouts is the
  ONLY menu), `.dmFooterContainer` (`#fcontainer`). Menu: `nav.unifiednav[role="navigation"]`, drop-downs
  as `li > a + ul.unifiednav__container_sub-nav`.
- **Pictures**: `irp.cdn-website.com/{site}/dms3rep/multi/opt/{name}-{806h|547w|1920w}.{ext}?jxl&v=jxl`,
  with the original in `data-dm-image-path` (or `data-image-url` on gallery links). Galleries lazy-load
  (`img[data-src]`). `lirp.cdn-website.com` resizes on request and never upscales (checked: a 1600w ask on
  a smaller original returns the original). Older sites use `*.multiscreensite.com`; Duda's stock/template
  library lives under `/md/unsplash/`, `/md/pexels/`, `/md/dmtmpl/`.
- **Background pictures**: classic rows put them in `data-background-image`; flex boxes put them in the
  page's own `<style id="pagestyle">` as `#boxid{background-image:url(…)}` (ids can be CSS-escaped,
  `#\39 e9729a1`). Rotating backgrounds are base64 JSON in `data-gallery-bg` (usually stock).
- **Colours**: `--color_1…--color_N` in `<style id="cssVariables">`; widgets use `var(--color_N)`.
- **Phone copies**: boxes with `data-hidden-on-desktop` are shown on phones only (usually a shortened copy).
- **Widgets**: photo gallery (`.dmPhotoGallery`, captions `.caption-title/.caption-text`, template default
  "Photo By: John Doe" / "Image Title" / "Button"), image slider (`.dmImageSlider`, often testimonials
  over `transparent_background.png` with invisible "Button"s), FAQ accordion (`li.accordion-item`),
  contact form (`.dmform`, success/error messages OUTSIDE the `<form>`), map (`.inlineMap[data-address]`,
  drawn by script), YouTube (`iframe[data-src]`), Duda-hosted video (`video[data-src]` on
  `vid.cdn-website.com` with a `poster`), custom HTML (`.dmCustomHtml`, usually a script embed), share
  pop-up (`#dmPopup` "Share by:"), "powered by" badge (`[dmle_extension="powered_by"]`).

Researched against public Duda sites (markup only); every fixture is synthetic with invented businesses.

## Already covered
Before this pass (`readImportPage` on the fixtures, no network, no model): headings, paragraphs, the menu
including drop-downs (sub-nav groups), Duda buttons (`a.dmButtonLink`), links inside sentences, the form's
questions, JSON-LD contact details, social links, YouTube → thumbnail + "Watch the video", and the colours
(the shared theme reader already picks up `--color_N` from the inline `cssVariables` style).

What was lost or wrong: the phone drawer's email line, footer address, share pop-up "Share by:" and form
"Thank you…/Oops…" messages read as content (no `<main>`, so the whole body was read); no logo (header is a
div); every picture at its resized size (`-806h`, `-308w`, `?jxl`), gallery pictures twice (link
background + lazy img); background pictures missed (data-background-image, flex `<style>`); template
captions "Photo By: John Doe", "Image Title", "Image Description" and "Button" read as words; the slider's
transparent placeholder picture; testimonials and FAQs as run-on list items ("…catches." Ruth, Staveley
Button); phone-only copies read as a second paragraph; the map lost.

## Fixed in this pass
All in `src/utils/site-builders/duda.ts`, proved by `tests/site-platform-duda.test.ts` (10 checks):
- `contentRoot: '#dm_content'`; header, phone header/drawer → `<header>`, footer → `<footer>`, so menu,
  logo and social links still come from them but they are never content. *(content / menu tests)*
- Furniture removed: share pop-up, powered-by badge, hidden form messages, invisible slider buttons,
  switched-off captions, template caption words, transparent slider picture; `noise` catches the
  template words anywhere. *(placeholders test)*
- Phone-only boxes (`data-hidden-on-desktop`) dropped. *(phone copy test)*
- Pictures full size: `fullSizeImage` maps any Duda CDN picture to `lirp…/opt/{name}-1920w.{ext}`
  (GIFs kept as they are, query dropped); `img[data-dm-image-path]` swapped to it before reading, so the
  logo is full size too and gallery copies collapse to one. *(pictures test)*
- Background pictures from `data-background-image` and from `#id{background-image}` rules in the page's
  `<style>` (CSS-escaped ids handled) → `data-bg`. Duda's template page background is not read. *(background test)*
- FAQ accordion → question heading + answer; testimonial slider → quote + name. *(FAQ test)*
- Duda map → a Google map embed, which the reader turns into "See us on the map"; its address fills the
  contact address when the page states none. *(links/map test)*
- Whole `runImport` on a two-page Duda site with `plan` → null: both pages read, platform `duda`, no
  template words, only full-size pictures saved. *(import test)*

## Can be done (not done yet)
- **Logo through the adapter** (S, `site-extract.ts`): the logo uses `fullSizeImageUrl`, not
  `adapter.fullSizeImage`. Duda is covered by swapping `src` in `prepare`; other platforms aren't. Change
  `logo = { src: fullSizeImageUrl(src) …` to `logo = { src: fullSize(src) …`.
- **Picture description for backgrounds read before a heading** (S, `site-extract.ts`): a flex box's
  background is read before the heading inside it, so its alt is the *previous* heading. Look ahead for
  the first heading inside the node in `bgImage`.
- **Duda-hosted video** (M, `site-extract.ts` + a policy decision): `video[data-src]` on
  `vid.cdn-website.com` could become its poster picture plus a button — but the button would point at
  Duda's CDN, which stops working when they leave Duda. Today it is left out silently; at least list it in
  the import report's "not carried" list.
- **Button corners** (S, `site-import-theme.ts`): Duda button radius lives in `#dm .dmButtonLink{border-radius}`
  rules in the page `<style>`; `buttonRadius` only looks at `.btn|.button|button` selectors. Add
  `\.dmButtonLink` (or any selector containing "button", case-insensitive).
- **Second colour** (S, `site-import-theme.ts`): Duda names colours `--color_1…N`, not secondary/accent;
  `--color_2` is usually the second brand colour. A per-adapter `look` hook would let Duda say so.
- **Blog / store pages** (M): Duda blog posts (`/blog/…`) and store pages are skipped by `SKIP_PATH`
  like every platform's; Duda blog has an RSS feed (`/feed/rss2`) that the blog-post importer could use.

## Can't be done
- **Custom HTML widgets** (`.dmCustomHtml`): usually a third-party script (Paperform, booking tools).
  Hosted sites run no scripts and frame no third parties, so their contents can't be carried.
- **Rotating stock backgrounds** (`data-gallery-bg`): base64 lists of Duda's stock photos; not the
  owner's pictures and licensed through Duda, so left out on purpose.
- **Member-only / password pages and Duda "site personalisation" variants**: behind login or decided by
  script per visitor; we read what an anonymous visitor sees.
- **Prices** in Duda store widgets are left off on purpose (they belong in Business Information).

## Suggested improvements to our import
- Treat `[role="main"]` as a content root in `readImportPage` when there is no `<main>` (Duda, and many
  hand-made and agency sites use a div with that role). One line in `site-extract.ts`:
  `$('main').length ? … : $('[role="main"]').length ? $('[role="main"]').first() : $('body')`.
- Read `data-background-image` (and `data-bg-src`, `data-background`) in `bgImage` for every platform —
  a common lazy-load attribute, not Duda-only.
- Normalise picture URLs (drop `?jxl`, size suffixes) before the `seenImg` de-duplication for all
  platforms, so a thumbnail and its lazy copy are one picture.
- Accordions (`li` holding a heading and an answer) as heading + text everywhere: today an `li` with a
  heading inside reads as one run-on item on any platform.

## Detection
`detect` matches any of: `dudamobile`, `multiscreensite.com`, `irp.cdn-website.com` /
`lirp.cdn-website.com` / `static.cdn-website.com`, `<body id="dmRoot">`, or a `dmRespRow` class. Duda's
own site and the four real sites studied all match on several signals. Possible false positive: a non-Duda
page that hot-links a picture from a Duda site's CDN (rare; the adapter's changes are harmless there
because `#dm_content` won't exist and the reader falls back to `<main>`/`<body>`). No generator tag is
set by Duda, so a Duda site that serves all its pictures from a custom domain and uses only flex layout
would still match on `id="dmRoot"`.
