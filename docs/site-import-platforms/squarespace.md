# Squarespace

Adapter `src/utils/site-builders/squarespace.ts` · test `tests/site-platform-squarespace.test.ts` ·
fixtures `tests/fixtures/site-platforms/squarespace/` (synthetic: fictional businesses, modelled on the
markup of Squarespace's own template demo sites, studied 2026-11-08/09).

## How sites on Squarespace are built

- **Server-rendered.** Words, menu and pictures are in the HTML; the headless browser is not needed
  (`rendersWithJs: false`). A few blocks are drawn by JavaScript from data in the page — see below.
- **Tell-tale markup.** Every page carries `<!-- This is Squarespace. -->` and a
  `Static.SQUARESPACE_CONTEXT = {…}` script. Most real sites have **no** `<meta name="generator">`
  (none of the demos did). Blocks are `div.sqs-block.<type>-block` (`html-block`, `button-block`,
  `image-block`, `form-block`, `map-block`, `video-block`, `product-block`, `accordion-block`…).
- **7.1** (current): `header#header` with `.header-nav` (desktop) and `.header-menu` (phone overlay,
  a full second copy of the menu with "Back" links); `main#page > article.sections > section.page-section`;
  blocks in `.sqs-layout` grids or Fluid Engine (`.fluid-engine > .fe-block`). List sections
  (`.user-items-list li.list-item`) hold cards. Footer is `footer#footer-sections` — real page sections
  the owner composes (address, hours, socials).
- **7.0** (older templates, still common): per template family — e.g. Brine family `.Header-nav`,
  `.Mobile` bar + overlay (second menu copy, cart), `main.Main > section.Index-page`; Bedford family
  `data-content-field="navigation"`, banner area outside `main-content`.
- **Menu drop-downs ("folders").** 7.1: `a.header-nav-folder-title` + `.header-nav-folder-content`;
  the folder title's address (`/classes-folder`) is not a page. 7.0 Brine: `.Header-nav-folder`.
- **Pictures.** `images.squarespace-cdn.com/content/v1/…` (7.1) and `static1.squarespace.com/static/…/t/…`
  (7.0). Any size of one original is `?format=100w … 2500w`; `srcset` lists them. Lazy pictures carry
  `data-src` / `data-image` (7.0 often has **no `src` at all**), plus `data-image-dimensions`.
  Section backgrounds are ordinary `<img>` inside `.section-background`. Galleries repeat each picture
  as a `?format=100w` thumbnail.
- **Drawn by JavaScript from page data:** 7.1 form blocks (fields in
  `<script type="application/json" class="sqs-form-block-context">` → `formFields[{type,title,placeholder}]`,
  no `<form>` in the HTML; many open in a pop-up from a `.lightbox-handle` button); map blocks
  (`[data-context]` / `data-block-json` → `location{addressLine1, addressLine2, mapLat, mapLng}`);
  video blocks (`.sqs-video-wrapper[data-html]` holds the `<iframe>` as escaped text,
  `data-block-json.url` the address).
- **Colours and fonts (7.1).** In the site's own stylesheet
  `static1.squarespace.com/static/versioned-site-css/…/site.css` (1.3 MB on a demo): `:root` palette as
  **HSL triples** — `--accent-hsl`, `--white-hsl` (lightest), `--black-hsl` (darkest), `--lightAccent-hsl`,
  `--darkAccent-hsl` — and fonts as `--heading-font-font-family:"Poppins"`, used everywhere through
  `var()`. 7.0: `static1.squarespace.com/static/sitecss/…/site.css`, plain compiled colours.
  The page lists ~9 Squarespace shared stylesheets **before** site.css.
- **`?format=json`.** Any page + `?format=json` returns `mainContent` (the page's block HTML, same as
  the page), `collection` (title, navigationTitle, type, fullUrl), `website` (siteTitle, logoImageUrl,
  socialAccounts, location), `websiteSettings` (contactEmail, contactPhoneNumber, storeSettings).
  Off on password-protected pages; our fetcher reads HTML, so it is not used.

## Already covered (before this pass)

Headings, paragraphs, links inside sentences (`try a taster session`), `.sqs-block-button-element`
buttons, quotes, cookie banner (`.sqs-cookie-banner-v2`), footer removal, "Powered by Squarespace",
largest `srcset` picture and `?format=1500w` for `squarespace-cdn.com`, `data-src` lazy pictures,
section-background pictures, drop-down groups in 7.1 (`folder-content`), contact facts from
`mailto:`/`tel:`/JSON-LD.

## Fixed in this pass

All in `tests/site-platform-squarespace.test.ts` (12 checks):

- **Detection without a generator tag** — the page comment, `Static.SQUARESPACE_CONTEXT`, site-css /
  universal asset paths, `sqs-block`/`sqs-layout`. A page that only hot-links a Squarespace picture is
  no longer Squarespace. ("recognised from Squarespace's own marks…")
- **Menu** — folder titles are no longer imported as pages (`/classes-folder` was fetched as a page);
  cart ("0", "Cart 0"), Login/Account, the phone overlay copy and its "Back" link removed; 7.0 Brine
  drop-downs now grouped ("Our story (About)"). ("menu: …")
- **List sections** — each card was one list item ("Tableware Speckled mugs … See the shop"); now
  heading + text + button. ("7.1 list sections…")
- **Accordions** — question + answer were one item; now heading + text. **Image cards** (card/poster/
  overlap layouts) — title, subtitle and button were one paragraph; now heading + text + button.
- **Shop controls** — "Decrease/Increase quantity by 1", "Add to cart", "Subscribe" (product), sold-out /
  sale marks removed; prices stay so the import lists them for Business Information.
- **Pictures** — `static1.squarespace.com` (7.0) now resized to `?format=1500w` (it took the camera
  original); all other query parameters dropped so gallery thumbnails fold into their picture (7.0
  gallery was read as 4 pictures, now 2). GIF/SVG left alone.
- **Video blocks** — were lost; now thumbnail + "Watch the video" via the shared embed reader.
- **Form blocks (7.1)** — `hasForm` was false and no questions; now a `<form>` is built from the JSON
  (labels only, hidden fields skipped), so the report lists "Name, Email, Phone, Which class?, Message";
  the pop-up "Sign up" button is removed.
- **Map blocks** — were lost; now the pinned address (fills the import's contact address) and a
  "See us on the map" button.
- **Whole import** (`runImport`, fake deps, plan null) reads home + contact, never asks for the folder,
  cart or "Back" addresses, and every draft word comes from their pages.

## Can be done (not done yet)

1. **Their look on 7.1 — S, needs the main session** (`site-import.ts`, `site-import-theme.ts`).
   Today the import reads **nothing** of a 7.1 site's look: it fetches the first 4 stylesheets, all
   Squarespace's shared ones; even with site.css the HSL palette and `var()` fonts aren't followed
   (on the Hester demo it guessed a wrong orange, no font). Helpers are ready and tested in
   `squarespace.ts`: `squarespaceSiteCssUrl(html, url)` and `readSquarespaceLook(css)`. Wiring, in
   `site-import.ts` `readLook`:
   ```ts
   import { readSquarespaceLook, squarespaceSiteCssUrl } from './site-builders/squarespace';
   // …
   const own = squarespaceSiteCssUrl(html, finalUrl);
   const sheets = [...(own ? [own] : []), ...harvestBrandSignals(html, finalUrl).stylesheets.filter((u) => u !== own)].slice(0, LOOK_MAX_STYLESHEETS);
   // after css is fetched:
   const look = readImportedLook(html, finalUrl, css);
   const sq = own ? readSquarespaceLook(css) : null;
   return sq ? { ...look, ...Object.fromEntries(Object.entries(sq).filter(([, v]) => v)) } : look;
   ```
   Check `PAGE_MAX_BYTES` lets a ~1.3 MB site.css through (or read only its first 50 kB — the `:root`
   palette is at the top). Better long-term: an optional `readLook?(css, html)` on `BuilderAdapter`
   (`types.ts`) so every platform can supply its own.
2. **Footer facts — S/M, main session** (`site-extract.ts`). 7.1 footers hold the address and opening
   hours as plain paragraphs; only `mailto:`/`tel:`/`<address>`/JSON-LD are read before the footer is
   removed. A per-adapter `footerFacts` hook, or reading a UK-postcode line from the footer, would fill
   the contact address.
3. **Picture alt before its heading — S, main session** (`site-extract.ts`). A picture placed before
   its card's heading gets the previous heading as its description (kiln picture → "Classes"). Look
   ahead for the next heading in the same block when the site gave no alt.
4. **`?format=json` facts — M, main session** (`site-import.ts` deps). `websiteSettings.contactEmail`,
   `contactPhoneNumber`, `website.location`, `socialAccounts`, `logoImageUrl` are exact; worth one
   `fetchJson(url + '?format=json')` when the HTML gives no contact details.
5. **Native Squarespace videos — M.** `video.squarespace-cdn.com` players have no public page to link
   to; could take the poster picture only.
6. **Blog / shop collection pages — M.** A menu "Blog" or "Shop" page is a list of posts/products; the
   import reads it as a page of summaries. Could be routed like the Blog Assistant widget (shared).

## Can't be done

- **Member areas, password-protected pages and Squarespace Commerce checkout** — behind login.
- **Scheduling (Acuity), donation, and Squarespace Email Campaign pop-ups** — third-party scripts and
  frames; our hosted sites run no scripts and frame no third parties. The words around them come
  across; the widget does not.
- **Video/background-video sections and parallax/animation effects** — the look is a closed set of
  tokens; only the video's thumbnail and link come across.
- **Announcement bar** — drawn by JavaScript from site settings, not in the HTML.

## Suggested improvements to our import

- **Look reader: put the platform's own stylesheet first** and follow `var(--x)` one level for
  `font-family` (helps Squarespace, Shopify, Webflow — all list shared sheets first and use variables).
- **Read HSL / `hsla()` custom properties** in `brand-extract.ts`, not only hex.
- **Image alt:** fall back to the next heading in the same block before the previous one.
- **`detectBuilder` in `site-extract.ts`** still says "squarespace" for any page with a
  `squarespace-cdn.com` picture; it could use `adapterFor(...)?.key` instead.
- Expose `adapter.label` in the import report ("Read as a Squarespace site").

## Detection

`gen.includes('squarespace')` **or** any of: `<!-- This is Squarespace. -->`,
`Static.SQUARESPACE_CONTEXT`, `static1.squarespace.com/static/(versioned-site-css|sitecss|vta)/`,
`assets.squarespace.com/universal/`, `class="… sqs-block|sqs-layout …"`.
False positive removed: pages that only hot-link `images.squarespace-cdn.com` / `static1…/t/` pictures
(a site moved off Squarespace keeping its picture addresses). No false negatives found on the three
template demos (Hester 7.1, Bedford and Brine 7.0) or the older `tests/fixtures/site-import/sqsp-*.html`.
Squarespace is listed after Wix and WordPress in `index.ts`, so a WordPress site hot-linking Squarespace
pictures was already safe.
