# Bolt.new

Adapter `src/utils/site-builders/bolt.ts` · test `tests/site-platform-bolt.test.ts` · fixtures
`tests/fixtures/site-platforms/bolt/` (all synthetic: Fernbrook Grooming, Hartley & Moss Candles are made up).
Researched 2026-11-08 from Bolt's support pages and three public `*.bolt.host` sites (markup only, nothing copied).

## How sites on Bolt.new are built

- **What Bolt makes.** By default a Vite + React + TypeScript + Tailwind app with lucide-react icons
  (inline `<svg class="lucide …">`). It can also make Astro, Next.js and others, but the vast majority of
  small-business sites are the Vite React default. Pictures come from Bolt's prompt: Pexels stock
  (`images.pexels.com/photos/…?auto=compress&cs=tinysrgb&w=800`), sometimes Unsplash, rarely the owner's own.
- **Where it is hosted.** Bolt Cloud (the default since August 2025): `<name>-<4 chars>.bolt.host`, or a
  custom domain on Pro. Behind Cloudflare, response header `x-powered-by: Bolt.new`. Older projects, and
  owners who chose it, publish to Netlify (`*.netlify.app`); others export to GitHub and host anywhere.
- **What a plain fetch sees.** The Vite shell: `<link rel="icon" type="image/svg+xml" href="/vite.svg">`,
  the owner's `<title>` / description / og tags, `/assets/index-<hash>.js` + `.css`, and an empty
  `<div id="root"></div>`. **Zero words.** Every path (`/about`, `/sitemap.xml`, a typo) returns the same
  shell with status 200 — the SPA fallback. No server-side rendering for bots (checked with a Googlebot UA).
- **What the browser draws.** Inside `#root`: a `<header>` (often `fixed`), a **phone menu drawer as a
  fixed overlay beside the header** (`div.fixed.inset-0.md:hidden.opacity-0`) holding the site name, the
  menu links, "Close menu" and often a `tel:` link; then sections — with `<main>` on multi-page
  (React Router) sites, often **without `<main>`** on one-page sites whose menu jumps to `#services`,
  `#contact`. Hero calls to action are often `<button onClick={scrollTo…}>` with no link at all.
  Shop-style cards carry JavaScript-only buttons ("Add to basket", a wishlist heart, "Quick view").
  Cards get decorative absolute-positioned numbers ("01", "02"). A footer.
- **Bolt's own furniture.** Free plan: `<script async src="https://bolt.new/badge.js?s=<uuid>">` in the
  head, which appends a `<div>` whose "Made in Bolt" badge lives in an **open shadow root** — Puppeteer's
  `page.content()` does not serialise it, so it never reaches the import. Every Bolt Cloud plan:
  `og:image` / `twitter:image` = `https://<site>/__bolt/og-image`.
- **robots.txt** on bolt.host is Cloudflare's managed one: `User-agent: *` allowed; AI-training bots
  (ClaudeBot, GPTBot, …) disallowed. Our `bemoreswan-siteimport` token is allowed.

## Already covered

Tested against the fixtures at eb33994c with fake deps (`fetchHtml` → shell, `renderHtml` → rendered,
`plan` → null):
- The empty shell triggers the headless browser (`readPage`: under 40 words → `renderHtml`); the rendered
  page's words, headings, list items, pictures, `tel:`/`mailto:` buttons, social links and the menu (React
  Router `<a href="/about">`) are read; menu pages are rendered one by one.
- `<header>`, `<nav>`, `<footer>`, `<form>` and inline SVG icons are removed; the badge's empty `<div>` adds nothing.
- Tailwind `bg-[url(…)]` / inline `background-image` pictures are read (shared `bgImage`).
- Description and title come from the shell's meta tags.

What was lost or wrong before this pass (all on the rendered page):
1. **Every Bolt page read as `magento`** (see Detection) — so the Bolt adapter never ran.
2. One-page sites (no `<main>`): the phone drawer's site name, "Home / Services / About / Contact",
   "Close menu" and "Call 01632 960123" came out as the first blocks of the home page.
3. "01", "02", "03" card numbers read as paragraphs.
4. `href="#services"` calls to action read as plain text ("See our services" as a stray line).
5. "Add to basket", "Add to wishlist", "Quick view" read as buttons (with no link).
6. Pexels/Unsplash pictures kept at their thumbnail size (`w=600`, `w=800`, `h=650&w=940`).

## Fixed in this pass

- **`detect`**: `bolt.new/badge.js` or `/__bolt/og-image` (Bolt Cloud), or a link to `https://bolt.new`
  on a page that is a `<div id="root">` app shell. Dropped the old `stackblitz` match (a developer's page
  embedding a StackBlitz demo is not a Bolt site) and bare `bolt.new` (a blog post about Bolt).
  Tests: "Bolt Cloud pages are recognised…", "a 'Built with Bolt' link counts only…", "…StackBlitz demo…".
- **`prepare`** (rendered page only; never adds words):
  - removes phone-only (`sm|md|lg|xl:hidden`) boxes that are a fixed overlay or hold nothing but links and
    buttons — the drawer; a phone-only box with the owner's own paragraph stays. Tests: "the phone menu
    drawer…", "a phone-only box that holds the owner's own paragraph is kept"; the drawer's phone number
    is still found from the contact section/footer.
  - removes icon-only buttons and app-only buttons (basket, wishlist, quick view, menu, theme toggles)
    outside forms. Test: "basket, wishlist and quick-view buttons…".
  - removes absolute-positioned decorative numbers. Test: "decorative card numbers…".
  - turns a stand-alone `href="#…"` call to action (outside nav/header/footer, not inside a sentence)
    into a `<button>`, so it reads as a button with no link instead of a stray line. Tests: "a call to
    action that jumps down the page…", "an inline '#' link inside a sentence stays part of its paragraph".
- **`fullSizeImage`**: Pexels and Unsplash addresses ask for `w=1600` (never shrinks a larger one; drops
  `h`, `dpr` and Pexels' `fit`). Anything else → null (shared default). Tests: "Pexels stock pictures…",
  "fullSizeImage: …".
- **`noise`**: "Made in Bolt" / "Built with Bolt" in case a renderer ever serialises the shadow root.
- **`rendersWithJs: true`**. **`contentRoot`**: deliberately unset — `#root` would beat `<main>` on
  multi-page sites (cheerio's `.first()` is document order) and Bolt has no reliable content wrapper.
- Whole-import tests: a one-page and a multi-page site through `runImport` with no network and no model.

## Can be done (not done yet)

1. **Magento must stop claiming Vite pages** (S) — `magento.ts` detect `mage\/` matches `image/svg+xml`.
   Fixed on the magento session's branch (commit 5aea3b1c, claude/laughing-blackwell-36511d); my test
   neutralises it until merged. Files: `site-builders/magento.ts` (not mine).
2. **`#section` links map to the page holding that section** (M) — `site-extract.ts` `absolutise` returns
   null for `#…`, and `site-import.ts` `mapHref` sends a same-page link to `/`. Keep the hash on the
   block (`href: "<page url>#contact"`), record each block's nearest `id` ancestor, and in `assembleImport`
   map `#contact` to the new page/section that received the block under `id="contact"`. Then my
   button-conversion in `prepare` can be dropped. Also lets the hero `<button>` "Book a groom" be paired
   with a section, if the main session wants that guess (I did not make it: it would invent a link).
3. **Read the look from the rendered page** (S) — `runImport` → `readLook(home.html …)` uses the plain
   shell's HTML; on Bolt the Tailwind classes (`rounded-2xl`, `bg-emerald-600`) exist only in the
   rendered HTML. `readPage` could return the rendered html when it used it. Files: `site-import.ts`.
4. **Stock pictures in `fullSizeImageUrl`** (S) — move my Pexels/Unsplash rule into the shared
   `site-extract.ts fullSizeImageUrl` so v0, Lovable, Replit, Cursor and hand-built sites get it too; and
   tell the owner in the import report when pictures are Pexels/Unsplash stock (they are free to use, but
   they are not photos of the business). Files: `site-extract.ts`, `site-import.ts` (report).
5. **SPA 404s** (S) — every unknown path returns 200 + the shell, and the browser then draws the app's
   own "Page not found". `pickImportPages` only follows menu links, so it is rare, but a page whose only
   heading is /^(404|page not found|not found)$/i could be reported as not read. Files: `site-import.ts`.
6. **Read `x-powered-by: Bolt.new`** (S) — would detect Bolt Cloud on a custom domain even when the badge is
   off and og:image was overridden. `detect` only gets HTML; needs `site-fetch.ts` to pass response headers
   and `adapterFor` to accept them. Files: `site-fetch.ts`, `site-builders/types.ts`, `index.ts`, `site-extract.ts`.
7. **Home menu label** (S) — the header's logo link (`<a href="/">Hartley & Moss</a>`) is the first nav
   link, so the home page is titled with the business name rather than "Home". Generic; `site-extract.ts`
   could skip a header link to `/` whose text equals the site name / `<title>` prefix.

## Can't be done

- **Bolt projects not on Bolt Cloud** (Netlify, exported, self-hosted) carry no Bolt trace at all — the
  shell is any Vite + React app. They still import through the generic JavaScript path; `platform` is
  just null. Test: "known gap: …".
- **StackBlitz / WebContainer preview links** (`*.webcontainer-api.io`, `*.local-credentialless…`) run
  inside the owner's own browser tab; nothing is served to us. The owner needs to Publish first.
- **Buttons that only scroll or open things with JavaScript** (`<button onClick=…>`) have no link to
  carry; their words are kept as buttons with no link, which the assembler leaves off the page.
- **Content drawn only after interaction** (a carousel's later slides, tabs, modals, "Load more") is not
  in the rendered DOM until clicked; the renderer doesn't click (by design: no actions on their site).
- **Supabase-backed content** (Bolt's database option: testimonials, menus, products fetched from
  `*.supabase.co`) is read only if the renderer's fetches succeed within its limits (80 sub-requests,
  10 s each); content behind login stays unreadable.
- **The badge** cannot be read and doesn't need to be.

## Suggested improvements to our import

- **Generic single-page-app handling** (helps Bolt, Lovable, v0, Replit, Cursor, Windsurf, Claude Code and
  any React/Vite site), in `site-extract.ts readImportPage` rather than per adapter:
  - remove Tailwind phone-only drawers (`[class~="md:hidden"]` etc. that are `fixed` overlays or link-only)
    — my `prepare` step 1, moved to shared code;
  - drop icon-only `<button>`s (no text, only an `aria-label`) outside forms, and apply adapter `noise` to
    buttons (the magento session did this on its branch);
  - drop absolute-positioned decorative numbers;
  - keep `#section` links (Can be done 2).
- **Know the shell when we see it**: `<div id="root"></div>` / `<div id="app"></div>` empty + a module
  script ⇒ skip the 40-word wait and render straight away, and say "Your site is built as an app that draws
  its words in the browser" in the thin message instead of the generic wording.
- **Rendered page for the look** (Can be done 3) and **colour tokens**: the lovable session found shadcn
  HSL triplets / `oklch()` aren't parsed by `brand-extract.ts parseColour`; Bolt's default template uses
  plain Tailwind colour classes, but Bolt projects that add shadcn hit the same gap.
- **Testimonials**: Bolt draws quotes as `<p class="italic">"…"</p>` next to a name, not `<blockquote>`;
  a shared rule (a paragraph wholly in quotation marks followed by a short "Name, …" line ⇒ `quote`)
  would help every Tailwind builder.

## Detection

- **Signals**: `bolt.new/badge.js` (free-plan badge script, in the head both before and after rendering);
  `/__bolt/og-image` (Bolt Cloud's generated share picture, in og:image / twitter:image); a link to
  `https://bolt.new` on a page with `<div id="root">` (owners who keep a "Built with Bolt" credit).
- **False negatives**: Netlify-hosted or exported Bolt projects; a Pro custom-domain site with the badge
  hidden *and* its own og:image. The `x-powered-by: Bolt.new` header would catch the latter (Can be done 6).
- **False positives found and removed**: `stackblitz` (embedded StackBlitz demos on tutorials) and bare
  `bolt.new` (articles mentioning Bolt).
- **Collisions**: at eb33994c `magento` (before bolt in `ADAPTERS`) claims every page with
  `type="image/svg+xml"`, i.e. every Vite shell — Bolt never ran. Loose detectors earlier in the list
  (`/strapi/i`, `/sitecore/i`, `/godaddy/i`, `/zyro/i`, `/weebly/i`) would also steal a Bolt page whose
  words merely mention those names; worth tightening by their owners.
