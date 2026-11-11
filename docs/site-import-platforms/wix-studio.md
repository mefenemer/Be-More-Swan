# Wix Studio

Adapter `src/utils/site-builders/wix-studio.ts` · test `tests/site-platform-wix-studio.test.ts` ·
fixtures `tests/fixtures/site-platforms/wix-studio/` (synthetic, modelled on public Studio and classic
Wix pages studied on 2026-11-08; no real business's words or pictures).

## How sites on Wix Studio are built

- **Wix Studio is Wix.** Same Thunderbolt renderer, same `<meta name="generator" content="Wix.com Website
  Builder">`, same picture host (`static.wixstatic.com`), same theme variables (`--color_0…`, `--wst-color-*`,
  `--font_0…`). Editor X sites were moved onto Studio by Wix and have the same responsive markup.
- **Server-rendered.** The words, headings, menu, buttons and form fields are in the HTML Wix sends;
  no headless browser is needed (`rendersWithJs: false`). Galleries (Pro Gallery), video boxes,
  Lottie animations and some app widgets are finished by JavaScript.
- **Where things live:**
  - Page body: `<main id="PAGE_SECTIONS<pageId>" data-main-content-parent="true">` (classic Wix:
    `<main id="PAGES_CONTAINER" data-main-content="true">`).
  - Sections: `<section data-block-level-container="Section" class="wixui-section">` (classic:
    `"ClassicSection"`, with `mesh-container-content`).
  - Header and footer are part of each page, `<header id="comp-…">` / `<footer id="comp-…">` each holding a
    `section.wixui-header` / `.wixui-footer` (classic: `#SITE_HEADER` / `#SITE_FOOTER`). The hamburger menu
    is a separate `data-block-level-container="MenuContainer"` overlay outside `<main>`.
  - Words: `div.wixui-rich-text[data-testid="richTextElement"]` holding real `h1…h6` / `p` with `font_N` classes.
  - Buttons: `a.wixui-button[data-testid="linkElement"]` with the label in `.wixui-button__label`.
  - Pictures: `<wow-image data-image-info="{…imageData:{uri,width,height,alt,name}}">` around an `<img>`
    whose `src` is a **49–147 px blurred placeholder** (`/v1/fill/w_74,h_49,…,blur_2/…`) with that tiny size
    in `width`/`height`; the browser swaps in the right size later. Crops are chained steps:
    `/v1/crop/x_,y_,w_,h_/fill/w_,h_/name.png`.
  - Accordions (FAQ): `li.wixui-accordion__item` → `<button>` with `.wixui-accordion__title`, answer in a
    hidden `.wixui-accordion__container`.
  - Text marquees: first `marquee-unit` holds the text, the rest are empty `aria-hidden` copies, plus an
    empty `<button aria-label="Play Marquee">`.
  - Slideshows are multi-state boxes; only the first state is sent, often with a "1/6" counter.
  - Theme colours: `--color_N: r,g,b` triplets (no hex) and semantic `--wst-color-action: rgb(var(--color_18))`,
    `--wst-color-text-primary`, `--wst-color-fill-background-primary`, `--wst-button-color-fill-primary`.
- **Tell-tale markup:** the site model Wix inlines in every page says `"editorName":"Studio"` (classic pages:
  `"editorName":"Unknown"`), and a features URL carries `editorName=Studio`.

## Already covered

Tested on the fixtures and checked on five public Studio sites and two classic ones:
words and headings in order; the menu (same host, in order); `a.wixui-button` buttons; links inside
sentences; Wix Forms questions (field labels) on the contact page; email and phone; Google Maps embed →
"See us on the map"; social links in the footer; duplicate copies of a text block read once (dedupe);
marquee text once; header/footer/hamburger overlay left out; "top of page"/"bottom of page" left out.

## Fixed in this pass

- **Detection (and classic Wix):** the old test `/wix-studio|wixstudio/` matched EVERY Wix page — Wix's shared
  logging script contains `"Studio"===…editorName?"wix-studio":…` — so every classic Wix site was read as
  Studio (confirmed on 4 classic sites by the Wix session and 2 here). Now: a Wix page whose site model says
  `editorName` Studio (or EditorX); with no site model at all, `main#PAGE_SECTIONS…[data-main-content-parent]`.
  Test: "Studio pages are Wix Studio; a classic Wix page is not…", "no false positives…", "saved without its scripts".
- **Responsive pictures were dropped** as icons (placeholder `width="74" height="49"` is under the 80 px
  icon cut-off), including section background photos. `prepare` reads `data-image-info` and gives the `<img>`
  its real size, drops the mobile `<source>`, fills in the picture's own description when the `alt` is a file
  name, and uses the original if the `<img>` has no Wix address. Test: "responsive pictures…".
- **Cropped pictures got a broken address** (`/v1/fit/w_1600,…/fill/w_49,h_16,…/name.png` — the shared rule
  assumes one step). `fullSizeImage` keeps the crop and asks for one sensible size:
  `/v1/crop/x_,y_,w_,h_/fit/w_1600,h_1600,q_85/name.png`. Test: "a cropped picture keeps its crop…", "fullSizeImage…".
- **FAQ accordions:** question and answer came out as one list item (or the question as a link-less button).
  Now the question is an `h3` and the answer its own text, inline links kept. Test: "FAQ accordion…".
- **Studio's own controls:** "Play Marquee"/"Pause Marquee" buttons and a slideshow's "1/n" counter are left
  out ("24/7", "3/4" are kept); "Powered and secured by Wix" is noise. Test: "Studio's own controls…", "24/7…".
- **Delegates to classic Wix:** `prepare`, `noise` and `fullSizeImage` run the `./wix` adapter's versions too,
  so the Wix session's improvements reach Studio pages (Studio is listed first, so they otherwise wouldn't).
- `contentRoot: 'main[data-main-content-parent]'`.

## Can be done (not done yet)

1. **Fix chained Wix picture steps for everyone (S)** — `src/utils/site-extract.ts` `fullSizeImageUrl`: the crop
   bug hits classic Wix and the **logo** (which always uses the shared function, never the adapter's). Replace the
   wixstatic branch with:
   ```ts
   const m = u.pathname.match(/^\/media\/([^/]+)(?:\/v1\/(.+))?$/);
   if (m) {
       if (!m[2]) return `${u.origin}/media/${m[1]}/v1/fit/w_1600,h_1600,q_85/${m[1]}`;
       const parts = m[2].split('/'); const name = parts.pop() || m[1];
       const crop = parts.find((p, i) => parts[i - 1] === 'crop' && /^x_\d+,y_\d+,w_\d+,h_\d+$/.test(p));
       return `${u.origin}/media/${m[1]}/v1/${crop ? `crop/${crop}/` : ''}fit/w_1600,h_1600,q_85/${name}`;
   }
   ```
   and in `readImportPage` use `fullSize(src)` (the adapter-aware one) for the logo instead of `fullSizeImageUrl(src)`.
2. **Read Wix theme colours (S–M)** — `src/utils/site-import-theme.ts` `readImportedLook`: on every Wix page
   (classic and Studio) colours are `--color_N: r,g,b` triplets, so the look comes back empty or picks Wix's own UI
   blue (#116dff on a classic site whose accent is rgb(30,171,199)). Resolve
   `--wst-color-action` / `--wst-button-color-fill-primary` → primary, `--wst-color-text-primary` (else `--color_15`)
   → text, `--wst-color-fill-background-primary` (else `--color_11`) → background, by following
   `rgb(var(--color_N))` to the triplet. Fonts: `--font_0` (headings) and `--font_8` (body) end in the family
   name (`…/1.1em fraunces,serif`); custom uploads are `wfont_…` and should be ignored, not reported as a font.
   The adapter can't do this: `readImportedLook` reads raw HTML, not the prepared document. A cleaner shared
   change: an optional `BuilderAdapter.readLook?(html): Partial<ImportedLook>` in `types.ts`, called by
   `readImportedLook` before its generic harvest — then Wix and Studio can own this.
3. **`builder` field (S)** — `detectBuilder` in `site-extract.ts` still says `'wix'` for Studio pages; that is
   right for the report wording, but if the report should say "Wix Studio", read `adapter.label`.
4. **Hamburger-overlay extras (S, adapter-only once confirmed)** — words placed only in the Studio menu overlay
   (e.g. opening hours) sit outside `<main>` and are lost; usually they repeat the footer. Needs more real examples.

## Can't be done

- **Slideshow states other than the first** and **Pro Gallery items beyond the first screen**: Wix sends them only
  to the browser (data fetched by script); our import does not run their app APIs, and headless rendering shows one
  state at a time.
- **Video boxes** (`wixui-video-box`, video.wixstatic.com): hosted sites play no third-party media and we don't copy
  videos; the poster picture comes through when it is an `<img>`.
- **Visual order:** Studio places elements with CSS grid, so the HTML order can differ from what visitors see
  (e.g. an FAQ title after its items). We read HTML order; the model's planning step can reorder sections, never words.
- **Wix apps** (Bookings, Stores, Events, Members areas) are content behind Wix's own APIs or logins — not copied;
  prices are left off on purpose anyway.
- **Velo (custom code)**: words a site writes with Velo after load appear only in the headless render.

## Suggested improvements to our import

- Accordions are common (Studio, Elementor, Squarespace, Shopify): a shared rule turning a `<button
  aria-controls>` + its `role="region"` into heading + text would help every platform.
- The 80 px icon cut-off trusts `width`/`height` attributes; responsive builders write the placeholder's size there.
  Prefer the largest `srcset` width, or ignore `width`/`height` when the address itself asks for a resize.
- An empty `<button>` with only an `aria-label` (play/pause, carousel arrows) is never content; the walk could skip
  buttons whose only words come from `aria-label` unless they link somewhere.

## Detection

- Signals: a Wix page (`generator` contains "wix", or `static.wixstatic.com` / `wix-thunderbolt` / `parastorage.com`)
  **and** `editorName` = `Studio` or `EditorX` in the inline site model (JSON, escaped JSON or `editorName=` in a URL).
  Fallback when no `editorName` appears at all: `main#PAGE_SECTIONS…[data-main-content-parent]`.
- False positives found and fixed: the old bare-string test claimed all classic Wix pages. Checked negative:
  classic fixtures here and in `tests/fixtures/site-import/`, other platforms' fixtures under
  `tests/fixtures/site-platforms/`, and non-Wix pages that mention "wix-studio" / "editorName":"Studio".
- Public pages checked 2026-11-08: five Studio sites → `wix-studio`; two classic sites (`"editorName":"Unknown"`) → `wix`.
- Unverified: Studio drop-down menus (none of the sampled sites had one); the shared `menuGroupOf` should catch them
  through `wixui-…__submenu` class names, but no fixture proves it.
