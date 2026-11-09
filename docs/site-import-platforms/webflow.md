# Webflow

Adapter `src/utils/site-builders/webflow.ts` · test `tests/site-platform-webflow.test.ts` (17 checks) ·
fixtures `tests/fixtures/site-platforms/webflow/`: a made-up bakery (home, about, contact + one stylesheet).
They're synthetic, modelled on the markup of five public Webflow sites studied on 2026-11-08 (webflow.com,
university.webflow.com, relume.io, finsweet.com, flowbase.co). None of those sites' words or pictures are committed.

## How sites on Webflow are built

- **Server-rendered.** Every word, CMS collection item and picture is in the HTML that's served.
  `webflow.js` only adds behaviour (menus, sliders, tabs, lightboxes, interactions). The plain read is
  enough, so `rendersWithJs: false`.
- **Tell-tale markup:** `<html data-wf-page="…" data-wf-site="…" data-wf-domain="…">`,
  `<meta content="Webflow" name="generator">` (attributes in that order; some sites leave it out),
  stylesheet `…/css/<site>.webflow.shared.<hash>.min.css`, script `webflow.shared.<hash>.js`, and `w-`
  classes everywhere.
- **Menu:** `div.w-nav[role=banner]` (usually **no `<header>`**). Logo: `a.w-nav-brand img`. Links:
  `nav.w-nav-menu[role=navigation] a.w-nav-link`. Drop-downs: `.w-dropdown > .w-dropdown-toggle` (label)
  plus `nav.w-dropdown-list a.w-dropdown-link`, which is a `<nav>` inside the `<nav>`.
- **Words:** designer-named divs and sections, with no `<main>`. Rich text sits in `.w-richtext`
  (h2–h6, p, ul, `figure.w-richtext-figure-type-image`). CMS lists are
  `.w-dyn-list > .w-dyn-items > .w-dyn-item`. The empty state is `.w-dyn-empty` ("No items found."), and
  conditionally hidden copies are `.w-condition-invisible` / `.w-dyn-bind-empty`.
- **Pictures:** `cdn.prod.website-files.com` (older sites: `uploads-ssl.webflow.com`,
  `assets.website-files.com`). Responsive copies are named `<id>_<name>-p-500.jpg`, `-p-800`, `-p-1080`
  and so on, keeping the original's extension. The original is the largest `srcset` entry. Lightboxes
  (`a.w-lightbox`) keep the full picture in `<script type="application/json" class="w-json">`.
  Section backgrounds are usually CSS classes in the stylesheet, not inline styles.
- **Video:** the `.w-video` element is an embedly iframe. The YouTube or Vimeo address is URL-encoded in
  its `src=` parameter. **Map:** `.w-widget-map[data-widget-latlng]`, drawn by script with no iframe.
- **Forms:** `div.w-form > form` plus `.w-form-done` / `.w-form-fail` (the thank-you and error
  messages) beside the form, outside `<form>`.
- **Interactions (IX2):** elements start as `style="opacity:0; transform:…"` and fade in on scroll. The
  words are in the DOM regardless.
- **Colours:** Webflow "Variables" in the shared CSS (`--swatch--brand`, `--swatches--blue`,
  `--base-color-brand--…`). The same file also starts with Webflow's own base rules, including
  `.w-button{background-color:#3898ec}`, Webflow's default blue.
- **Footer:** usually `div.footer` / `.footer_component`, not `<footer>`.

## Already covered

These worked before this pass, checked against the fixtures:
- Headings, paragraphs, CMS list items, rich text (headings, lists, figures, captions) and links inside
  sentences.
- Buttons (`w-button` is in `BUTTONISH`; standalone links count too), and the menu order.
- Full-size pictures when there's a `srcset` (the largest entry is the original).
- Words faded in by interactions (`opacity:0` doesn't matter to the reader).
- Testimonial sliders (blockquote per slide), and form questions (`formFields`).
- Contact details and social links, wherever they sit on the page.
- Sites that brand-name their CSS variables: the look gets their colour and fonts.

## Fixed in this pass

Each fix is proven by `tests/site-platform-webflow.test.ts`:

| Lost before | Now | Test |
| --- | --- | --- |
| Logo (no `<header>`) | `.w-nav` gets an id the shared logo reader finds; the brand image is marked as the logo | "the logo comes from the menu's brand link" |
| Drop-down grouping (the list is a nested `<nav>`) | Rewritten as `<details><summary>label</summary>links</details>`. The label is made from the toggle's text pieces, joined with spaces | "the menu: … under its label" |
| "No items found.", words hidden by CMS conditions, empty bound fields | removed | "CMS list items are read; words hidden … are not" |
| Form thank-you and error messages read as content | removed (also in `noise`) | "the form's thank-you/error messages …" |
| Footer read as content (a div, not `<footer>`) | Marked `role=contentinfo`, so contacts and social links are read from it first and the shared reader drops it afterwards | "… the footer …" and "the footer's contact details … still found" |
| "Made in Webflow" badge, phone-menu overlay/button | removed | same |
| YouTube/Vimeo videos (embedly iframes) | The iframe `src` is unwrapped to the real player, giving a thumbnail and a "Watch the video" button | "a Webflow video …" |
| Map widget | Becomes a Google Maps embed address, which the shared reader turns into "See us on the map" (`maps?q=lat,lng`) | "a Webflow map widget …" |
| Tab labels read as loose text, apart from their panes | Each label becomes an `<h3>` above its own pane; the tab bar is dropped | "tabs: each label stands as a heading …" |
| Lightbox thumbnails (resized) | Full picture taken from the lightbox JSON | "a lightbox gives its full picture …" |
| `src`-only resized copies (`-p-1080.webp`) | `fullSizeImage` strips `-p-NNN` on Webflow hosts only | same, plus "fullSizeImage: only Webflow hosts …" |
| Phone-layout copies (`.w-hidden-main`) read twice | removed | "the phone layout's copy … is not read twice" |
| Detection without a generator tag | also `data-wf-site` and `*.webflow.shared.*.css/js` | "the generator tag, or …" |

Checked by hand (not committed) against the five real sites: they still read 300–1,000 words each, and
their logos and drop-down groups are now found where they exist.

## Can be done (not done yet)

1. **Ignore Webflow's base CSS when reading the look (S, `site-import-theme.ts`).** On
   university.webflow.com, today's `readImportedLook` picks **`#3898ec`**, Webflow's default button blue
   from the `.w-button` base rule that's in every Webflow site's stylesheet. Leaving out rules whose
   selector names a `.w-` class gives `#001535` there, and finsweet.com is unchanged. The exact change: in
   `readImportedLook`, before `harvestBrandSignals`, run
   `css = css.replace(/[^{}]*\.w-[\w-]+[^{}]*\{[^}]*\}/g, '')`. A general version would be a new optional
   adapter field `lookCss?(css: string): string` in `types.ts`, called from `site-import.ts` `readLook`.
2. **Background colour through `var()` (S, `brand-extract.ts` / `site-import-theme.ts`).** Webflow writes
   `body{background-color:var(--swatch--cream)}`. Today the fixture's background reads `#ffffff` (from
   Webflow's base `body{background-color:#fff}`) instead of their cream. Resolving one level of `var(--x)`
   against the harvested custom properties would fix it.
3. **Section background pictures from class rules (M, `site-extract.ts` + `site-import.ts`).** Hero
   pictures on Webflow are mostly `.section-hero{background-image:url(…)}` in the stylesheet, so today
   they're lost. readImportPage would need the fetched CSS, or a pass in `runImport` that maps class to
   URL for the classes on the page's top sections.
4. **Background video posters (S, `site-extract.ts`).** `.w-background-video[data-poster-url]` has a
   still. Reading `data-poster-url` like `data-bg` in `bgImage` would bring it across. (The adapter
   could copy it into `data-bg` itself, but that attribute isn't part of the adapter's contract, so this
   should be confirmed first.)
5. **CMS detail pages beyond the menu (M, `site-import.ts`).** Collection items link to `/bakes/<slug>`
   pages, which aren't in the menu and so aren't read. The import reads menu pages only, by design.
6. **Empty-list headings (S, adapter).** When a list is empty (`.w-dyn-empty`), its heading ("Workshops")
   stays with nothing under it. The adapter could drop a heading immediately followed by an empty list.
   Left alone for now: the heading is the owner's own word.

## Can't be done

- **Password-protected pages / Memberships / Logic flows:** behind a login, so not read.
- **Webflow Ecommerce prices:** left out on purpose (they belong in Business Information).
- **Interactions, Lottie animations and sliders as motion:** hosted sites run no scripts, so they become
  still content.
- **Custom-code embeds (`.w-embed`) that draw content with script** (third-party widgets, booking tools):
  hosted sites frame no third parties and run no scripts. Plain HTML text inside an embed is still read.
- **Localised versions (Webflow Localization, `w-locales`):** only the language at the URL given is read.

## Suggested improvements to our import

- An adapter hook for the look (`lookCss`, see "Can be done" 1). Every builder that bundles its own base
  CSS (Webflow, Squarespace, Wix) has the same "default colour wins" risk.
- `role="contentinfo"` turned out to be the right way for an adapter to say "this is the footer". It keeps
  contacts and social links, which a removal in `prepare` loses, because `prepare` runs before contacts
  are read. Worth saying in `types.ts` for other platform sessions.
- Make `menuGroupOf` treat a `<nav>` that is itself inside a `<nav>` as a sub-menu, not the menu's root.
  That would cover Webflow and any hand-made site that nests navs, without an adapter rewrite.
- `readImportPage`'s logo comes from `fullSizeImageUrl`, not the adapter's `fullSizeImage`. A resized
  `-p-` logo wouldn't be put back to the original (rare: logos are usually served whole).

## Detection

`gen.includes('webflow')` **or** the raw HTML has `webflow.js`/`webflow.css`, `data-wf-page`,
`data-wf-site`, or `.webflow.<…>.css|js` (the shared stylesheet/script names). All five real sites and
the three fixtures are detected. A hand-made page that mentions "Webflow" in a sentence is not.
Possible false positive: a page that copies Webflow-exported HTML onto another host. It's still Webflow
markup, so the adapter is right for it. Webflow sits after the WordPress/Wix/Squarespace/Shopify adapters
in `index.ts`, and none of those match Webflow pages.
