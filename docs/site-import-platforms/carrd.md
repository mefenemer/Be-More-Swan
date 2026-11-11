# Carrd

## How sites on Carrd are built
- **One server-rendered page.** There is no generator tag. The words, pictures and inline `<style>` are all in the HTML; no JavaScript is needed to read them.
- **Sections stand in for pages.** A section is `<section id="<name>-section">` directly under the content column. Carrd's script hides every section except the current one (`style.display='none'`, class `inactive`) and switches when `location.hash` changes. In the HTML they are **all present and visible**, so a plain read gets every "hidden" section. The first section is `home`. A link to a section is `#<name>` (the id without `-section`). Carrd also has its own link kinds (`section:next`, `scrollpoint:first`, `browser:back`…, docs → Building → URL Types). A per-section setting in the script (`sections={'done':{hideHeader:true}}`) hides the header or footer on some sections.
- **Two markups.**
  - Classic: `#wrapper > #main > .inner > (header#header, section…, footer#footer)`, with elements `h1#text01`, `p#text02`, `div#image01.image`, `ul#buttons01.buttons > li > a.button`, `ul#links01.links`, `ul#icons01.icons > li > a > svg + span.label`, `div#gallery01.gallery`, `div#container01.container.columns`.
  - Newer: `.site-wrapper > .site-main[role=main] > .inner`, with the same ids plus classes like `text-component instance-4`, `buttons-component instance-1`, `icons-component instance-2`, and `a[role=button]`.
- **Header and footer** are optional static elements inside the content column. The header usually holds the logo and a `ul.links` menu of `#section` links. The footer holds whatever the owner put there (often their address).
- **Scroll points** are `data-scroll-id="<name>"` on a container. They are anchors with no words.
- **Pictures** are under `assets/images/…?v=<hash>`. Off-screen ones are "deferred": a `data:image/svg+xml` placeholder in `src` and the real address in `data-src`. Gallery thumbnails can link to a larger copy. The share picture is always `assets/images/card.jpg`.
- **Free plan:** a `#credits` "Made with Carrd" link (`carrd.co/build?ref=auto`, sometimes carrd.com). Sites on the free plan live at `*.carrd.co`. Pro sites can use their own domain and hide the credit.
- **Email addresses** are entity- and percent-encoded inside `mailto:` links. On sites behind Cloudflare (all Carrd hosting), they become `/cdn-cgi/l/email-protection#<hex>` instead.
- **Colours and fonts** are in one inline `<style>`, keyed by element id (`#text01{color…;font-family…}`, `#buttons01 .button{background-color…}`) or by the component class.

## Already covered
Tested on `classic-home.html` before this pass, with no network and no model:
- Every section's words, including hidden sections.
- Deferred pictures, because `data-src` beats `src`.
- The logo in `header img`.
- The form's questions.
- The phone number.
- Instagram from the icon row.
- The look: `readImportedLook` found the button colour `#c2563b`, text colour `#3d3d3d` and heading font Lora from the inline style.
- `#anchor` menu links are dropped by `absolutise`, so the import never fetches them as pages.

What was lost before this pass:
- The Pro/custom-domain site (`component-home.html`) was **not recognised** (`platform: null`).
- **Buttons were read as list items.** The `ul.buttons > li` branch runs before the `<a>` branch, so "Visit our shop" lost its link.
- **Icon labels became words:** "Instagram", "Email", "Home", "Forward", "Rewind".
- **Email addresses were lost.** Percent-encoded `mailto:` fails the `@` test, and Cloudflare tokens were never decoded.
- **The footer was dropped,** taking the owner's address line with it.
- **Section-link buttons** ("Order a bouquet" → `#contact`) were read with `href: null`. They were placed nowhere and not listed in the report.

## Fixed in this pass
Each fix is proved by a check in `tests/site-platform-carrd.test.ts` (10 checks):
- **`detect`** matches any of these:
  - the generator tag;
  - the credit link;
  - an `og:url` or canonical address on `*.carrd.co` / `*.crd.co`;
  - for Pro sites, `card.jpg` as the share picture plus Carrd's page skeleton plus `-section` ids or `-component instance-N` classes.

  A page that only links to carrd.co is no longer detected (check: "a page that merely links…").
- **`contentRoot`** is `#main > .inner, .site-main > .inner`.
- **`noise`** filters "Made with Carrd".
- **`prepare`** does the following:
  - Removes `#credits` and the credit link.
  - Decodes percent-encoded `mailto:` links and Cloudflare `email-protection` / `data-cfemail` addresses.
  - Removes the `href` from Carrd-only link kinds (`section:`, `scrollpoint:`, `browser:`…).
  - Icon rows: drops entries that go to `#section` (arrows between sections), and wraps the rest in a `<footer>`. Social links and email are still read, but the labels stay out of the content.
  - Button and link rows (`ul.buttons`, `ul.links` and their component names), outside the header: unwraps each link so it is read as a **button** with its link.
  - Points in-content `#section` links at the page itself, so the button is kept and maps to `/` on the new site.
  - Renames the content column's `footer#footer` to a `div`, so the owner's footer words are read.
- **Whole import:** both fixtures import as one home page. The report says `platform: 'carrd'`, nothing else is fetched, and prices stay out.

## Can be done (not done yet)
- **Produce a one-page site** (M). Our hosted sites already support `settings.structure: 'one_page'` and a section's `look.menuLabel`. The import needs to:
  - `site-extract.ts`: add `ImportPage.anchors?: Array<{ id: string; label: string | null; firstBlock: number }>`. An adapter would fill it in `prepare` by marking each `section#x-section` (for example `data-bms-anchor="x"`). `readImportPage` would record the block index where each marked element starts. The label comes from the header's `#x` menu link text.
  - `site-import.ts` `assembleImport`: when the home page has anchors and there are no other pages, set `structure: 'one_page'` and give the first planned section from each anchor `look.menuLabel = label`. `buildImportPrompt` could also show `anchor="x" menu="About"` beside the blocks, so the model groups sections by anchor.
- **Keep the section in button links** (S, `site-import.ts` `mapHref`): `https://site/#contact` → `/#contact` rather than `/` when the target is the home page and the new site is one page. This needs the anchor ids above to exist on the hosted page (`site-render.ts`, from `menuLabel`).
- **Skip the form-confirmation section** (S, adapter only, once confirmed on more sites). A section reached only after a form is sent ("Thank you! Your message is on its way") is read as content today. Carrd stores the form's on-success target in the page script. A heuristic, such as a section whose id appears only in the form's script config, needs more real samples. Today the plan is left to call it clutter.
- **Gallery full-size pictures** (S, adapter): when a gallery `a.thumbnail[href]` points at an image file, use that address. Our walk reads the `<img>` inside, not the link, so this needs `prepare` to copy the link into the `img` `data-src`. It wasn't done because no real sample confirmed the `_original` naming.
- **Shared Cloudflare email decoding** (S, `site-extract.ts`): many non-Carrd sites behind Cloudflare have the same `/cdn-cgi/l/email-protection` links. Decoding them in `readImportPage` would help every platform. `cfDecode` in `carrd.ts` can be moved as-is.
- **Percent-encoded `mailto:`** (S, `site-extract.ts`): decode before the `@` test (`decodeURIComponent` runs after the test today).
- **`IMPORT_NOISE`** (S, `site-extract.ts`): add `made with .*` next to `created with .*`. It's harmless for every builder.

## Can't be done
- **Password-protected Carrd sites** (a Pro feature): the page is behind a password prompt.
- **Sections whose words are only pictures or embedded widgets** (Carrd "Widget" and "Embed" elements: third-party scripts or iframes): our hosted sites run no scripts and frame no third parties. Videos and maps still become buttons, as on every platform.
- **Carrd's per-section "hide header/footer" and transition effects:** no equivalent, and not needed.

## Suggested improvements to our import
- A generic **anchors** field on `ImportPage`, described above. One-page sites made with Wix, Squarespace, Webflow, Framer, Tilda and hand-made HTML all use `#anchor` menus, which the import silently discards today.
- In `readImportPage`, a `<li>` whose only content is one link should be walked as that link (a button) rather than as a list item. Many builders draw button rows as `ul > li > a`.
- List a button with no usable link (`href: null`) in `notCarried`, instead of dropping it silently.

## Detection
- Signals: the generator tag (never seen on Carrd, kept for safety); `carrd.co(m)/build?ref=` or a `#credits` block naming carrd.co; `og:url` or canonical on `*.carrd.co` / `*.crd.co`; or, for Pro sites, `og:image …/assets/images/card.jpg` plus `#wrapper > #main > .inner` or `.site-wrapper > .site-main > .inner` plus `section[id$="-section"]` or `-component instance-N`.
- False positive removed: the old test `/carrd\.co/` matched any page that links to Carrd.
- Possible false negative: a Pro site on its own domain that replaced the share picture name. Carrd always writes `card.jpg`, so none were seen on the 17 public sites studied.
- Carrd sits after the WordPress, Wix, Squarespace and other builder adapters in `index.ts`. Its signals don't overlap theirs.
