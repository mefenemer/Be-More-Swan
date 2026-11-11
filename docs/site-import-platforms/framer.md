# Framer

## How sites on Framer are built
- **Server-rendered, then hydrated.** Every published page is full HTML (React SSR); scripts only add
  animation and interaction. The plain fetch has the words, so the headless browser is not needed
  (`rendersWithJs: false`).
- **Each breakpoint drawn separately.** Desktop, tablet and phone layouts sit side by side as
  `<div class="ssr-variant hidden-<hash> …">` copies. CSS hides them with
  `@media(<query>){.hidden-<hash>{display:none!important}}`, and the same list is on
  `#main[data-framer-hydrate-v2]` as `breakpoints: [{hash, mediaQuery}]`. Words appear two or three
  times, sometimes at different heading levels (h1 on desktop, h3 on phones), and pictures appear once
  per copy, at different `scale-down-to` sizes.
- **Words** are in `data-framer-component-type="RichTextContainer"` boxes as `h1–h6` / `p` with
  `class="framer-text"`. Links inside sentences are ordinary `<a class="framer-text">`.
- **Menu** is the page's first component (`div.framer-<id>-container` inside `#main > div`). It is often
  plain `div`s and `a`s with no `<nav>` or `<header>`, though some templates use them. Drop-down menus
  open with JavaScript, so their links are not in the page.
- **Buttons** are `<a data-framer-name="…"><div><h6 class="framer-text">Book now</h6></div></a>`.
- **Pictures** come from `framerusercontent.com/images/<id>.<ext>?scale-down-to=512|1024|2048&width=W&height=H`,
  with a `srcset` whose biggest entry has no `scale-down-to` (the original).
- **Look:** colours are `--token-<uuid>: #hex` on `body`, with a dark-mode set under
  `@media (prefers-color-scheme:dark)`. Fonts are `--framer-font-family` in
  `.framer-styles-preset-*` rules, whose selectors include `… h1`, `… p`.
- **Tell-tale markup:** `<meta name="generator" content="Framer <hash>">`, `framerusercontent.com`,
  `data-framer-*`, `#__framer-badge-container` (the "Made in Framer" badge on free plans).
- **Forms** are real `<form>`s: `<label><div><p>Name*</p></div><input name="Name"></label>`.
- **Maps component** frames `maps.google.com/maps?q=…&output=embed`. That shape comes from the
  component's source as I remember it; I haven't seen it on a live site yet.

## Already covered
(Today's import, run on the fixtures before this pass.)
- The words of the page, links inside sentences, the colours (`--token` frequency picks the brand
  colour #c2562b) and the heading font (`--framer-font-family` matches the shared `font-family` rule
  reader → Fraunces → "editorial").
- Emails, phone numbers and social links, read from the footer before it is removed.
- Ticker or marquee repeats, dropped by the shared same-words check.

## Fixed in this pass
All in `src/utils/site-builders/framer.ts`, proved by `tests/site-platform-framer.test.ts`:
- **Only the desktop copy is kept.** Breakpoints come from the hydration data, or from the CSS if that
  is missing. The page is judged at 1280px, and every `hidden-<hash>` box hidden at that width is
  removed. With no breakpoint list at all, the first of each run of copies is kept. Desktop heading
  levels survive, and pictures are no longer read twice (the fixture had 3 extra).
- **The menu is found.** A menu drawn without `<nav>` is wrapped in `<header>`, so it is read as the
  menu and its picture as the logo. Before this, the menu was empty and **only the home page was
  imported**, with the menu words and the logo read as content. One link beside a logo is enough,
  because drop-downs hide the other links.
- **Buttons:** short `a`/`button` round one heading or paragraph now read as buttons, not h6 headings.
- **Full-size pictures:** `scale-down-to` is removed, so the original is used, capped at Framer's 2048
  step when it is wider than 2048. The logo gets the same treatment.
- **Not content any more:** the footer (`data-framer-name="Footer"` → `<footer>`), the cookie banner
  component and the "Made in Framer" badge. The content root is now `#main`.
- **Form questions:** a `<select>`'s choices are no longer glued onto its question.
- **Map:** the Maps component's frame now becomes a "See us on the map" button.
- `runImport` on the fixtures now reads Home, Classes, About and Contact. Before this it read Home only.
- Checked by hand (not committed) on two public Framer templates: ferrum.framer.website and
  landio.framer.website. No repeated pictures, no `scale-down-to` left, and landio's menu and buttons
  are read.

## Can be done (not done yet)
- **Dark-mode colours as text colour (S, `site-import-theme.ts`).** `readImportedLook` takes the darkest
  colour it finds, which can be the dark-mode background in `@media (prefers-color-scheme:dark){…}`
  (#14181a in the fixture, not the real text #1f2a2e). Fix: in `readImportedLook` and `readLook`,
  strip those blocks first:
  `css.replace(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/gi, '')`.
  This helps every platform.
- **The look ignores the adapter (M, `site-import.ts` readLook + `types.ts`).** The look is read from
  the raw HTML, so `prepare` can't help it. Framer's button colours and corners live in class rules
  like `.framer-b7tn2{background-color:…;border-radius:999px}`, and the shared reader only knows
  `.btn`/`button` names, so it finds no corners and no second colour. Add an optional adapter hook
  `lookCss?(html): string` that returns extra CSS (for Framer: `.btn{background:<token>;border-radius:<r>}`
  built from the classes on the links it flattened into buttons). `readLook` would add it to `css`.
- **Logo goes through the adapter (S, `site-extract.ts` ~line 763).** Use `fullSize(src)` in place of
  `fullSizeImageUrl(src)`. Framer works around this already by rewriting `src` in `prepare`; other
  platforms can't.
- **Address in the footer (M, shared).** Framer has no `<address>` or JSON-LD, so the address in the
  footer is lost when the footer is removed.
- **Testimonials (S, adapter).** Framer has no `<blockquote>`, so a quote reads as plain text. Possible:
  text starting with “ inside a component named like "Testimonial" → `<blockquote>`.
- **Card links (S, shared).** A CMS card `<a>` (picture, title, line) keeps its words but loses where it
  pointed. A "Read more" button could be added after the card.

## Can't be done
- **Drop-down menu items:** Framer draws them with JavaScript on hover, so they aren't in the page.
  Pages only reachable from a drop-down are not followed, unless the page links to them elsewhere.
- **Framer's YouTube/Vimeo components and Embed/HTML components** that load only after a click are not
  in the page. If they are in the page as an `<iframe>`, the shared code handles them.
- **Password-protected Framer pages** (a paid plan feature) can't be read.
- **Locale versions** (`/de/…`) are separate pages; only the menu's locale is read.

## Suggested improvements to our import
- Strip `prefers-color-scheme: dark` CSS before reading the look (above). Any site with a dark mode
  benefits.
- Let adapters feed the look (`lookCss`). Most builders name button classes by hash, not "btn".
- `walk` could treat a link as a button when its only block child is a single text box. Then no
  adapter would need to flatten `a > div > h6` (Framer, Webflow and Wix Studio draw buttons like this).
- Run the shared breakpoint-duplicate check by box, not only by words, so pictures repeated at
  different sizes are caught for every builder (compare the `framerusercontent`/`wixstatic` image id
  without its query string).

## Detection
`generator` contains "framer", or the HTML has `framerusercontent.com` or `data-framer-`. All four
fixtures match, and a hand-made page doesn't. Possible false positive: a non-Framer site that hot-links
a `framerusercontent.com` picture. That's rare, and harmless, because every step in `prepare` acts
only on Framer markup. No false negatives found. A Framer site on a custom domain keeps its generator
tag.
