# GoDaddy Website Builder (Websites + Marketing)

Adapter `src/utils/site-builders/godaddy.ts` · test `tests/site-platform-godaddy.test.ts` ·
fixtures `tests/fixtures/site-platforms/godaddy/` (synthetic, fictional "Hollin Lane Pottery").
Studied 2026-11-08 on five public GoDaddy template sites (`*.godaddysites.com`). Their markup was copied into
the scratchpad only. Nothing from them is committed.

## How sites on GoDaddy Website Builder are built
- **Server-rendered React.** All the words are in the HTML, so no headless browser is needed (`rendersWithJs: false`).
  Each element carries `data-ux` (what it is: `Page`, `Widget`, `Header`, `Section`, `ContentCard`, `Tagline`,
  `ButtonPrimary`…) and often `data-aid` (which field it shows: `HEADER_TAGLINE_RENDERED`, `ABOUT_HEADLINE_RENDERED0`…).
  `data-aid` is the most stable hook.
- **No `<main>`, `<header>` or `<footer>`.** The header widget is a `div role="main"`. Each section is a
  `div data-ux="Widget" role="region"`. The footer is a `Widget role="contentinfo"`. Everything sits in `div data-ux="Page"`.
- **Menu:** `nav[data-ux="Nav"] > ul > li > a[data-ux="NavLink"]`, plus a "More" box (`data-aid="NAV_MORE"`) that
  repeats the menu for overflow. A phone drawer (`NavigationDrawer`) repeats it again. Some layouts draw the menu with
  scripts, which leaves an empty `nav`; on the sites studied those were one-page sites.
- **Pictures** come from `img1.wsimg.com/isteam/ip/<site-id>/<file>/:/<ops>`. The ops are `cr=` (crop), `rs=` (resize),
  `qt=` (quality) and `ll=` (lazy). The addresses **contain commas** (`rs=w:200,h:200,cg:true,m`). Most `<img>`s are lazy:
  `src` is a 1×1 GIF, `srcset` is `isteam/ip/static/transparent_placeholder.png`, and the real picture waits in
  `data-srclazy` / `data-srcsetlazy`.
- **Background pictures** (the hero, split sections) live in glamor `<style data-glamor>` sheets, one class per screen
  size (`@media … {.x .c1-6n{background-image:url(…rs=w:450,m)}}`), applied to a `div[data-lazybg]`.
- **Stock pictures** come from `img1.wsimg.com/isteam/stock/<id>/…` (GoDaddy's free image library).
- **Colours and lettering** are per-class glamor rules (`.x .c1-f{background-color:rgb(…)}`), not variables or element rules.
- **Duplicates:** the hero is drawn twice (desktop and phone). Headings are drawn ×4 (`data-ux="scaler"` copies used for
  text sizing). Each content card has hidden copies of the *other* cards' headings (no `data-aid`) to even out card heights.
- **Tell-tale markup:** `<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000">`
  (custom domains keep it), `data-ux=`, `data-aid="…_RENDERED"`, and scripts from `img1.wsimg.com/blobby/go/<site-id>/…`.

## Already covered
- The words, headings, buttons and inline links are server-rendered, so the core walk reads them.
- Contact details: `tel:`/`mailto:` links, the JSON-LD `LocalBusiness`, and the contact form's labels (`label[for]`).
- The footer (`role="contentinfo"`) and menus (`role="navigation"`) are removed by the core.
- Cookie banners whose id contains "cookie" are removed (GoDaddy's usually doesn't, see below).

## Fixed in this pass
What today's import lost on the fixtures, and what the adapter does now (every item is tested in `tests/site-platform-godaddy.test.ts`):
- **No pictures at all and no logo.** GoDaddy's srcset addresses contain commas, so the core's srcset split produced
  broken addresses, and lazy pictures pointed at the placeholder. `prepare` now gives every `wsimg` `<img>` one plain
  `src`: the real lazy address, or the largest srcset entry read with a comma-safe split (`goDaddySrcset`). On the real
  yoga template this took pictures read from 0 to 8, and the bakery template's image logo is now found.
- **Background pictures** (hero, ranges) are copied from the glamor rule onto the element as an inline
  `background-image`, so the core reads them, once each.
- **Full size:** `fullSizeImage` turns any `…/:/…rs=w:365…` into `…/:/rs=w:1600,m`. It keeps the owner's crop when it
  is in percentages and comes before the resize. It drops pixel crops after a resize, which are only right at that size.
- **Stock-library pictures** (`isteam/stock/`) are left out (see Can't be done).
- **Card headings in the wrong card:** the hidden equal-height copies are removed, so each card keeps its own heading.
- **Duplicate hero:** the phone copy's fields (same `data-aid` and words) are removed, so there is one "Book a class" button, not two.
- **Opening hours:** each `tr[data-aid^=CONTACT_HOURS_DAY_REND]` becomes one line ("Thu 10:00 am – 04:00 pm").
  Before, every identical "10:00 am – 04:00 pm" after the first was dropped as a repeat, leaving bare day names. The
  collapsed "Open today …" summary is removed.
- **Menu:** the "More" overflow box is removed. Any page only in it joins the menu at the end, never as a drop-down
  called "More". The logo link (text logos read "YogaYogaYogaYoga") is no longer a menu entry. Cart, account (`/m/…`),
  search and the hamburger button are removed.
- **Furniture:** the cookie banner (`data-aid*=COOKIE`, whose id has no "cookie"), the chat bubble (`MESSAGING_FAB`),
  the gallery arrows and "1/6" counter, "Powered by GoDaddy", the `filler@godaddy.com` account placeholder, and "#"
  links whose words are "#" are all removed.
- **Detect tightened** (see Detection). `contentRoot` is `[data-ux="Page"]`.
- `runImport` with fake deps (no network, `plan` → null) imports home, about and contact, reports `platform: 'godaddy'`,
  and finds 6 pictures plus the logo.

## Can be done (not done yet)
- **Their colours and lettering — S, `site-import-theme.ts` + `site-import.ts` (main session).** Today `readImportedLook`
  finds no primary colour or heading font on any GoDaddy site studied (only black text on white), because GoDaddy's
  look is in per-class rules. `readGoDaddyLook(html, $)` is already written and tested in `godaddy.ts`. It returns
  `{ primaryColor, headingFont, font }` from the main button's background (grey or white template buttons → null) and
  the Tagline/Heading font. The wiring could be an optional adapter field, exactly:
  - `types.ts`: add `look?(html: string, $: cheerio.CheerioAPI): Partial<import('../site-import-theme').ImportedLook>;`
  - `site-import-theme.ts` `readImportedLook`: after computing, `const a = adapterFor(html, cheerio.load(html)); const extra = a?.look?.(html, cheerio.load(html)) ?? {};`
    and prefer `extra.primaryColor ?? primary`, `extra.headingFont ?? headingFont`, `extra.font ?? fontKeyFor(…)`.
  - `godaddy.ts`: `look: readGoDaddyLook` (one line, which I can add once the field exists).
- **Logo at full size — S, `site-extract.ts`.** The logo uses `fullSizeImageUrl`, not the adapter's `fullSizeImage`,
  so a GoDaddy logo comes in at its srcset size (400–600 px, which is fine for a logo). Use
  `fullSize(src)` there for consistency, or leave as is.
- **Picture descriptions from the card — S, this file.** A card picture without alt is described by the *previous*
  heading, because the picture comes before its card's heading. `prepare` could move the card's image after its
  heading. I left it alone because order is the owner's layout.
- **Same picture twice with different crops — S, `site-extract.ts`.** The yoga template shows `icon-thumb4.jpg`
  cropped in one section and uncropped in another. Both are kept, since the dedupe is by full address. A
  platform-neutral "same file, different size" dedupe would need a `pictureKey?(src)` adapter field.
- **Online Store products — M.** The products on GoDaddy's "Shop" / "Featured Products" (OLS) are drawn by scripts
  from `/api/v2/…`. The import report calls them unread. Products belong in Business Information anyway (prices stay
  off sites). A reader would be a `site-embeds.ts`-style fetch, owned by the main session.
- **Category tiles and gallery slides drawn by scripts — M.** On the real yoga template, the "Featured categories"
  pictures and most gallery slides are not in the HTML. The headless browser read would get them, but it only runs
  under 40 words, and GoDaddy pages always have words. A per-adapter "always render" hint would cover it
  (`rendersWithJs: 'partial'`), and that changes `site-import.ts`.

## Can't be done
- **GoDaddy stock pictures** (`img1.wsimg.com/isteam/stock/…`) are left out on purpose. GoDaddy's free image library is
  licensed for use on GoDaddy sites, so those pictures aren't the owner's to move. Template pictures that the template
  uploaded into the site's own folder (`isteam/ip/<site>/Depositphotos_…`, `pexels-…`) can't be told apart from the
  owner's and are imported. The main session should decide whether the import report needs a line like "N stock
  pictures from GoDaddy's library weren't copied". That needs a count passed from `prepare`, which adapters can't do today.
- **Members-only pages, bookings (Appointments), the store checkout and blog comments** are behind GoDaddy's
  login or scripts.
- **Embedded videos** (`data-ux="Video"`) are filled in by scripts. The `<iframe>` isn't in the HTML, so there is no
  "Watch the video" button without the headless browser.

## Suggested improvements to our import
- **Comma-safe srcset in the core** (`site-extract.ts` `largestFromSrcset`): split on `/,\s+(?=(?:https?:)?\/\/|\/)/`
  instead of `,`. GoDaddy, Cloudinary (`w_400,h_300`) and imgix-style addresses all use commas. Today every srcset with
  them silently becomes a broken address and the picture is lost. The adapter works round it for GoDaddy only.
- **Dedupe identical buttons** (same words and href, next to each other) in the core walk, the way text already is. Builders
  that draw desktop and phone copies (GoDaddy, Wix, Duda) all double their hero button.
- **Don't drop a repeated short line inside a table row or list.** Opening hours repeat by nature. A core rule that keys
  table cells by their row would fix hours tables on every platform.
- **Treat `role="main"` on a non-`<main>` element** as a header candidate rather than ignoring it. It's harmless today,
  but some readers (screen readers, and our future "content root" guesses) take it for the page's content.

## Detection
- `gen` includes `starfield technologies` or `go daddy website builder`. This holds on `*.godaddysites.com` and
  custom domains, and on the older Website Builder 7 too.
- Without a generator tag, all three must hold: `data-ux="Page|Widget|Header|Section"`, a `data-aid="…_RENDERED…"`, and
  an `img1.wsimg.com/isteam/` or `/blobby/go/` address.
- **False positives removed:** the old test (`/godaddy/i` or any `img1.wsimg.com`) matched any page that says "domain
  registered with GoDaddy", links to godaddy.com, or hot-links a wsimg picture. Tested.
- **False negatives:** GoDaddy's legacy "Website Tonight" and its hosted WordPress ("Managed WordPress") are not this
  builder. The WordPress adapter reads those, because it is listed earlier in `index.ts`.
