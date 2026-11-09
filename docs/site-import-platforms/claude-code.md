# Claude Code

## How sites on Claude Code are built
Claude Code is a coding tool, not a host. A business that builds its own site with it usually ends
up with one of these shapes. All four are synthetic fixtures in `tests/fixtures/site-platforms/claude-code/`:

- **Static multi-page HTML with Tailwind from its CDN** (`tailwind-static/`):
  - `cdn.tailwindcss.com` plus an inline `tailwind.config = {…}` holding the palette and fonts.
  - Pages named like `about.html` and `services/x.html`.
  - Drop-downs drawn either with named classes (`nav-dropdown__head` / `__panel`) or Alpine-style
    (a `<button>` plus an unnamed `absolute` box), and a duplicate mobile menu.
  - `data-cms-*` attributes on the words.
  - Background pictures as `bg-[url(…)]` or `style="background-image"`.
  - `<details>` FAQs, a Netlify form with a honeypot, and the Be More Swan blog widget on a "Blogs" page.

  Restorative Futures is this shape.
- **A shell filled from `/content/*.json` by its own script** (`json-filled/`): the HTML has empty
  `data-cms-field="hero.title"` elements and a "Loading…" line. A `fetch('/content/home.json')` fills
  them, the cards and even the menu.
- **Decap (Netlify) CMS** (`decap/`): `/admin/index.html` loads `decap-cms.js`, and `/admin/config.yml` maps
  each page's fields to `content/pages/*.json|md`. The public page is either pre-built or, as here,
  filled by a small script from the same files. `netlify-identity-widget.js` is the tell-tale.
- **Static generators** (`eleventy/`, `astro/`): fully pre-rendered HTML. Eleventy uses `<picture>` with
  avif, webp and jpeg sources. Astro adds `data-astro-cid-*` attributes and server-rendered `<astro-island>`s.

## Already covered
Pinned by `tests/site-platform-claude-code.test.ts` (14 checks):
- Static Tailwind pages read fully and in order: hero, card headings and text, quotes, list items, team
  pictures. Tailwind `bg-[url()]` and inline background pictures are read. Card links drawn as plain `<a>`
  with utility classes become buttons.
- Classed drop-downs keep their group (the "About Us" › "Our Story" link). The duplicate mobile menu is
  de-duplicated by address.
- Logo, email, phone, social links, the address and the Netlify form's questions are read. The honeypot
  field is left out.
- The blog-widget page switches on the new site's blog under "Blogs".
- The look comes from the inline `tailwind.config`: background `sand-50`, second colour `tide-600` (from
  the buttons), heading font Fraunces, large corners.
- Eleventy reads fully, including the largest `<picture>` source and `sub-menu` groups. Astro reads fully,
  including SSR island content.
- A JSON-filled shell is honestly refused as too thin, with nothing charged. With the headless browser
  (`renderHtml`) the same page imports, script-drawn menu included. In production these sites depend on
  `site-js-render.ts`.

## Fixed in this pass
Nothing in the adapter. With no reliable signal, `detect` stays false and `prepare` never runs, so
every gain is shared work (below). This pass adds the fixtures, the tests that pin today's results and
this report.

## Can be done (not done yet)
1. **`.html` pages get ugly addresses (S).** `about.html` becomes `/about-html`, and
   `services/index.html` becomes `/index-html`. Redirects already drop `.html` (`redirectKey`), so only
   the slug is wrong. In `src/utils/site-import.ts` `assembleImport`, replace
   ```ts
   const last = new URL(p.url).pathname.split('/').filter(Boolean).pop() ?? '';
   ```
   with
   ```ts
   const last = new URL(p.url).pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '').split('/').filter(Boolean).pop() ?? '';
   ```
   and change this platform's test to pin `['', 'about', 'mediation', 'contact']`.
2. **Read `/content/*.json` for CMS-filled pages without a browser (M).** In `site-import.ts` `readPage`,
   when the plain read is thin:
   - Look for `fetch(['"](/content/[^'"]+\.json)` in inline scripts and `data-content="…json"` on script tags.
   - Fetch at most 3 same-host JSON files through `deps.fetchJson` (SSRF fence).
   - Fill each `[data-cms-field]` with the string at its dotted path, `[data-cms-src]`/`[data-cms-href]`
     with that attribute, and `[data-cms-list]` with one `<li>` per string or per `title`/`body` object.
   - Re-read the page with `readImportPage`.

   Only the site's own words are used, so nothing is made up. This is cheaper and more reliable than
   headless Chrome, and fixes both `json-filled/` and `decap/`. Files: `site-import.ts` and a new pure
   `site-cms-fill.ts`.
3. **Decap `admin/config.yml` (M).** When the page loads `netlify-identity-widget.js` or `decap-cms`,
   fetch `/admin/config.yml`. Its `files:` entries name each page's content file, so markdown bodies
   (`about.md`) can be read even when the public page fills them by script. They also give page names.
   Needs a small YAML subset reader, or `yaml` if it is already a dependency. Files: `site-import.ts` and
   a new `site-decap.ts`.
4. **Alpine-style drop-downs lose their group (S).** In `site-extract.ts` `menuGroupOf`, before the
   `SUBMENU_CLASS` test, add:
   ```ts
   const head = $n.prev();
   if (head.is('button, [aria-expanded], [aria-haspopup]')) { const t = label(head.text()); if (t) return t; }
   ```
   With that, "Services" › "Family Mediation" / "Workplace Mediation" are grouped.
5. **A background picture before its card's heading gets the previous card's description (S).** The
   `neighbours.jpg` picture is described as "Workplace mediation". In `readImportPage` `bgImage`, prefer
   the first heading in the same card (`$(node).parent().find('h1,h2,h3,h4').first().text()`) and fall
   back to `lastHeading`. `addImage` could do the same for an `<img>` that comes before its heading.
6. **The header's site-name link takes Home's place in the menu (S).** Seen on Eleventy and the JSON
   shell. In the nav loop, let a later link to the same address replace an earlier one whose text is
   the site name or the `<title>`.
7. **Site name from the title suffix (S).** Hand-built sites seldom have `og:site_name` or JSON-LD, but
   every page title ends "| Harbour Lane Mediation". When `siteName` is null, use the `|`/`–` suffix that
   all pages read share (in `runImport`, after the pages are read).
8. **Main colour from an inline Tailwind palette (S–M).** `look.primaryColor` is null for the fixture,
   although `tide-600/700` colour the headings and the main button. In `site-import-theme.ts`, when the
   brand harvest finds no candidate, take the most-used saturated palette colour among the
   `text-*`/`bg-*` classes on `h1`/`h2` and the first button.
9. **`<details>` FAQs (S).** A `summary` and its answer could become a question-and-answer pair (an
   FAQ section) instead of two plain lines of text. Files: the walk in `site-extract.ts`, and the plan prompt.

## Can't be done
- **Telling a site was built with Claude Code.** It leaves no generator tag, comment or file of its own.
  Every candidate signal (Tailwind CDN, `data-cms-*`, Netlify) also matches thousands of other
  hand-built sites, and the platform name only changes the report's wording.
- **Words kept only in the CMS's private store** (Netlify Identity / git-gateway): `/admin` content sits
  behind a login, so it is not public. We read only what the public site publishes.
- **Live behaviour** (Alpine drop-downs that open, scripts that filter cards): hosted sites run no
  scripts. The words and links are kept; the behaviour is not.

## Suggested improvements to our import
- Items 2 and 3 (reading the site's own content files) help every hand-built and CMS-filled site whose
  content sits in a public JSON or markdown file, including sites made with Cursor, Windsurf, Bolt,
  Lovable and v0. They also avoid starting a browser.
- Item 1 (`.html` slugs) affects every static site, whatever made it.
- **Cross-platform bug found.** The `magento` adapter's detect, `/Magento_|mage\/|requirejs-config/`,
  matches `image/avif`, `image/webp` and `image/png`. Any page with `<source type="image/avif">` or
  `<link rel="icon" type="image/png">` reads as Magento, and the Eleventy fixture does today. Magento
  comes before `cursor` and `claude-code` in the list, so every hand-built site is exposed. The Magento
  session has been told. Suggested fix: `(?<![a-z])mage\/`, or `/static\/(version\d+\/)?frontend\/`.
  This platform's test deliberately leaves the Eleventy page's platform unpinned.
- "Loading…" and "Loading..." could join `IMPORT_NOISE`: they are never the owner's words.

## Detection
`detect` is always false. Signals considered and rejected:
- `cdn.tailwindcss.com`: common to many hand-built and AI-built sites.
- `data-cms-*` attributes: used by any home-made CMS.
- `netlify-identity-widget`: means Decap, whatever wrote the site.
- `CLAUDE.md` / `.claude/`: never deployed, and not fetchable.

False positives: none, by design, and no adapter claims a fixture as Claude Code. Separately, the
Magento adapter wrongly claims the Eleventy fixture (see above).
