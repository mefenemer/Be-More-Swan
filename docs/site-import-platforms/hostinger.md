# Hostinger Website Builder

Adapter `src/utils/site-builders/hostinger.ts` (key `hostinger`), test `tests/site-platform-hostinger.test.ts`,
fixtures `tests/fixtures/site-platforms/hostinger/` (SYNTHETIC: an invented florist, modelled on real
markup studied 2026-11-08 on three public Hostinger sites; none of their words or pictures are committed).

## How sites on Hostinger Website Builder are built

- **Server-drawn.** Hostinger Website Builder (formerly Zyro, and its "AI Builder", which makes the same
  pages) publishes Astro pages with Vue islands: the words, menu and pictures are in the HTML, so a plain
  read works and the headless browser is not needed (`rendersWithJs: false`).
- **Tell-tale markup:** `<meta name="generator" content="Hostinger Website Builder">` or
  `"Hostinger AI Builder"`; `<astro-island … component-url="/_astro-…/Page.….js" props="{pageData…}">`;
  `main.page` › `div.page__blocks[data-pagefind-body]` › `section.block` › `div.layout-element` ›
  `…layout-element__component--GridTextBox | GridImage | GridButton | GridEmbed | GridSocialIcons | GridCard`.
- **Header:** `header.block-header`, but **inside `<main>`** (in `div.top-blocks`). Desktop and phone copies
  of the logo and menu; a cart button ("Shopping Bag") even on sites without a shop. Drop-downs are
  `li.block-header-item` › `label` › `div.item-content-wrapper` ("Flowers") + `div.block-header-item__dropdown-area` › `ul`.
- **Footer:** an ordinary `section.block`, also inside `<main>`: `block--footer` (older), or
  `data-pagefind-ignore="all"` (newer); the island props mark it `slot: "footer"` either way.
- **Pictures:** `assets.zyrosite.com/cdn-cgi/image/format=auto,w=768,h=557,fit=crop/<siteId>/<file>` —
  Cloudflare resizing, so **every srcset address contains commas**. Each picture is drawn twice
  (`.image-wrapper--desktop` and `.image-wrapper--mobile`). Stock pictures picked in the builder are
  Unsplash addresses cropped per layout (`w=984&h=924`). Hero backgrounds may be `<video>` with a poster.
  `/cdn-cgi/image/w=1600,fit=scale-down/<siteId>/<file>` gives a large copy (PNG stays PNG; WebP comes
  back as JPEG to a plain fetcher). Custom domains have no `/cdn-cgi/image/` (404, checked).
- **"Embed code" boxes** (`GridEmbed`): an empty `div.grid-embed#<id>` — the HTML lives only in the
  island's `pageData.elements[<id>].content`, written in by JavaScript. Owners use them for FAQs, tables,
  chat widgets, policy scripts. Props use Astro's `[type, value]` encoding (0 = value/object, 1 = array).
- **Look:** the owner's fonts are CSS variables on `main.page`'s style (`--font-primary:'Epilogue'`,
  `--font-secondary`); colours are inline variables per block/header/button (`--background-color`,
  `--nav-link-text-color`, `--grid-button-primary-background-color`) and in `pageData.styles`. Every page
  also carries **Hostinger's own UI palette** in `<style>:root{--color-meteorite…;--color-primary:#673de6;--color-primary-dark:#5025d1…}`.
- Elements hidden on a screen size carry `layout-element--desktop-element-hidden` / `--mobile-element-hidden`.

## Already covered

(Today's import on the fixtures, before this pass: `readImportPage` + `runImport` with fake deps, `plan` → null.)
- Platform detected (the old `/zyro/i` detect), headings/paragraphs/buttons in order, inline links,
  menu links (flattened), logo, email/phone/social links, form questions, JSON-LD name and phone.

What was lost or wrong before this pass:
- **Every Hostinger picture address broken**: the shared srcset reader splits on "," and turned
  `…/format=auto,w=1440,h=1044,fit=crop/<site>/<file> 1200w` into `https://<their-domain>/fit=crop/<site>/<file>` (404).
- The logo and two "Shopping Bag" buttons read as page content (header inside `<main>`).
- The footer read as content on every page (email, phone, "Instagram", "Facebook" as buttons).
- Drop-down groups lost ("Flowers" › Weddings, Workshops became flat links).
- Unsplash pictures twice (desktop and phone crops).
- Text hidden on both screen sizes read as content.
- "Embed code" boxes (an FAQ, a video) lost completely.

## Fixed in this pass

All in `tests/site-platform-hostinger.test.ts` (13 checks), which also runs a whole `runImport` with no network or model:
- **Detect tightened**: generator `Hostinger … Builder` / `Zyro`; else Hostinger's picture host *with* its
  grid/header markup; else the grid markup with `page__blocks`. A blog post saying "Zyro", or a borrowed
  zyrosite picture, no longer counts ("the bare word Zyro…" check).
- **Pictures**: srcsets read whole (no comma split) and the largest kept as `src`; `fullSizeImage` asks
  Hostinger's host for one 1600-wide copy; Unsplash crops become one uncropped 1600-wide copy; phone
  copies dropped ("pictures: one full-size copy each…").
- **Header out of `<main>`**, cart and burger removed: menu and logo still read, not content ("their words come out in order…").
- **Drop-downs keep their group**: the drop-down box is marked `sub-menu`, so the shared reader labels it ("the menu keeps its drop-down group…").
- **Footer** (`slot: "footer"`, `block--footer`, `data-pagefind-ignore="all"`) becomes a `<footer>` outside
  `<main>`: dropped as content, its email/phone/socials still read ("the footer's email, phone…").
- **Embed code boxes** filled from the island's props (no fetch), minus their `<title>`/`<meta>`/`<style>`/`<script>`;
  a script-only embed adds nothing; an embedded YouTube video becomes the usual thumbnail + button ("an Embed code box…").
- **Hidden on both sizes** removed. `contentRoot: '.page__blocks'`. `noise` for the cart/shop labels and "Made with Hostinger".
- Broken island props never stop a read ("a page with broken island props…").

Checked by hand (not committed) on three real Hostinger sites: menu groups, pictures and footer all read correctly.

## Can be done (not done yet)

1. **Hostinger's purple is imported as the owner's brand colour — on every site** (S, main session:
   `site-import-theme.ts` or `site-import.ts`). On all three real sites `readImportedLook` returned
   `primaryColor: "#5025d1"`, Hostinger's own `--color-primary-dark`. Either strip the builder palette
   before reading the look, e.g. in `readImportedLook`:
   `html = html.replace(/<style>:root\{--color-meteorite[^<]*<\/style>/g, '')`, or (better, for every
   platform) add `BuilderAdapter.lookHtml?(html: string): string` (types.ts) called from site-import.ts
   before `readImportedLook`, which this adapter would implement with that replace.
2. **Read the owner's fonts and colours** (S–M, main session: `site-import-theme.ts`, or a new adapter
   hook `look?($): Partial<ImportedLook>` in `types.ts` merged in `site-import.ts`). Fonts are on
   `main.page`'s style: `--font-primary:'Fraunces', serif;--font-secondary:'Karla', sans-serif`
   (heading, body). Colours: `header.block-header` `--background-color`, buttons
   `--grid-button-primary-background-color`, sections `--block-background-color`. Today fonts come back null.
3. **The logo is not made full size** (S, `site-extract.ts`): the logo uses `fullSizeImageUrl(src)`
   rather than the adapter's `fullSize(src)`; change `logo = { src: fullSizeImageUrl(src), …` to
   `logo = { src: fullSize(src), …` (line 763). Today Hostinger logos import at the 768-wide copy — fine, not full.
4. **Comma-safe srcset reader for everyone** (S, `site-extract.ts` `largestFromSrcset`): replace the
   `split(',')` with `srcset.matchAll(/(\S+?)\s+(\d+(?:\.\d+)?)([wx])\s*(?:,|$)/g)` (as `largestOf` in
   this adapter). Any site behind Cloudflare Image Resizing (`/cdn-cgi/image/a,b,c/`) hits the same bug.
5. **Footer address** (S, `site-extract.ts`): footers often hold the postal address as plain lines
   (no `<address>`); it is dropped with the footer. Reading the address from footer text before removal would help every platform.
6. **Hostinger blog and shop** (M): blog lists (`BlockBlogList`) and products (`BlockEcommerce…`) are
   drawn from `pageData`/`productData` and the store API; not seen on the sites studied, untested. Products
   would be prices — they belong in Business Information anyway.
7. **Background videos**: a hero `<video class="block-background__image" poster="…">` is skipped; its
   poster could be read as the hero picture (S, `site-extract.ts`: treat `video[poster]` like an image).

## Can't be done

- Embeds that are only third-party scripts (chat widgets, Termly policies, booking widgets) — hosted
  sites run no scripts and frame no third parties; their words don't exist in the page.
- Password-protected pages and members-only content.
- Shop checkout, cart and customer accounts.

## Suggested improvements to our import

- **Magento's starter detect has a false positive**: `/mage\//` matches `/cdn-cgi/image/` in any picture
  address. Harmless on real Hostinger pages (Hostinger is listed before Magento) but a hand-made page
  using Cloudflare-resized pictures is called Magento. Suggest `/\/static\/(?:version\d+\/)?frontend\/|Magento_|requirejs-config/`
  (for the Magento session / main session).
- Phones: `01632 960123` (JSON-LD) and `tel:+441632960123` are kept as two numbers; matching on the last
  10 digits (or normalising +44 → 0) would merge them, for every platform.
- Let adapters adjust the look (items 1–2 above): many builders ship their own UI palette in the page.

## Detection

- `gen` matches `/\bhostinger\b.*\bbuilder\b|^zyro\b/` ("hostinger website builder", "hostinger ai builder", "zyro").
- Or `(assets|cdn|userapp).zyrosite.com/` **and** `block-header` / `layout-element__component--Grid` in the HTML.
- Or `layout-element__component--Grid(TextBox|Image|Button)` **and** `class="page__blocks"`.
- False positives fixed: the old `/zyro/i` matched any page mentioning Zyro. WordPress sites on Hostinger
  hosting are WordPress (generator + earlier in the list). No false negatives found on the three real sites.
