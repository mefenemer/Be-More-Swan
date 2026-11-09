# Lovable

## How sites on Lovable are built

Lovable (lovable.dev) writes a React app from a chat. Published sites live at `<name>.lovable.app` or a
custom domain connected through Lovable; some owners export to GitHub and host elsewhere (Netlify,
Vercel). There are two shapes in the wild (studied 2026-11-08 on two public `*.lovable.app` sites and
Lovable's starter template; fixtures are synthetic):

- **Classic single-page app** (most existing sites): Vite + React + Tailwind + shadcn/ui + React Router.
  The plain fetch is an empty `<div id="root"></div>` with Lovable's head defaults: title = the project's
  slug (`kiln-clover-pottery`), `description` and `og:description` "Lovable Generated Project",
  `author` "Lovable", `og:image` `lovable.dev/opengraph-image-….png`, `twitter:site` `@lovable_dev`,
  and on older projects `<script src="https://cdn.gpteng.co/gptengineer.js">`. Every route answers
  with the same shell (SPA fallback); the browser draws the route. Pages are `<div class="min-h-screen">`
  with **no `<main>`**; the site bar is `<nav class="fixed top-0 …">` holding the logo, with **no
  `<header>`**. Uploaded pictures are at `/lovable-uploads/<uuid>.png`, bundled ones at
  `/assets/<name>-<hash>.jpg`, stock ones from `images.unsplash.com/…?w=800&q=80`. The free plan adds an
  "Edit with Lovable" badge (`#lovable-badge`, link to `lovable.dev/projects/…`). Every page mounts two
  empty toast regions (`role="region" aria-label="Notifications (F8)"` and sonner's section).
- **Server-rendered** (newer TanStack Start projects): the words are in the plain fetch (`<header>`,
  `<nav>`, `<main>`, `<footer>`, streamed `$tsr` scripts). Lovable's hosting adds
  `<script src="/~flock.js" data-proxy-url="/~api/analytics">` and `/__l5e/events.<hash>.js`
  ("l5e" = l-ovabl-e) — on custom domains too. Footers often say "Built in Lovable."
- **Look:** shadcn tokens in the stylesheet. Tailwind v3 projects write bare HSL triplets
  (`--primary: 158 45% 30%`, used as `hsl(var(--primary))`); Tailwind v4 projects write `oklch(…)`
  (`--primary: oklch(55% .15 35)`). Fonts: a Google Fonts `@import`/`<link>`, then `.font-display{…}` or
  `--font-display: "Space Grotesk", …`. Components use semantic classes (`bg-primary`,
  `text-primary-foreground`, `rounded-full`), not colour names.
- **Interactive bits:** menu items and hero buttons are often `<button onClick={scrollTo…}>` with no
  address; Radix accordions (FAQs), tabs, dialogs and navigation-menu drop-downs keep closed content
  **out of the DOM**; contact forms are often shadcn `<Input>`s with a `<button onClick>` and **no
  `<form>`**.

## Already covered

Tested against `tests/fixtures/site-platforms/lovable/` (run before the adapter changed anything):

- The empty shell reads 0 words, so `runImport` asks `renderHtml` for each route; each menu route is
  fetched (same shell) and rendered on its own, so client-side routes **are** imported. 3/3 pages read.
- Words, headings, CSS-background hero (`style="background-image:url(…)"`), `<img>` pictures with
  their alts, `mailto:`/`tel:` links, Instagram link, price lines flagged for Business Information.
- `<a href="/classes"><button>See our classes</button></a>` reads as a button with its address.
- The server-rendered kind reads from the plain fetch (64 words, real `<form>` questions listed).

What was lost before this pass: platform detected as **magento** (see Detection), logo (no
`<header>`), form questions read as page words ("Your name", "Email", "Message", "Send message") and
no form noticed, "Edit with×" badge as a button linking to lovable.dev, "kiln-clover-pottery" as the
page title and "Lovable Generated Project" as the description, testimonials as plain text, Unsplash
pictures at 800 px.

## Fixed in this pass

All in `src/utils/site-builders/lovable.ts`; proved by `tests/site-platform-lovable.test.ts` (6 checks):

- **detect** — markup only Lovable leaves: `/~flock.js`, `/__l5e/`, `cdn.gpteng.co`/`gptengineer.js`,
  `data-lov-id`, `/lovable-uploads/`, `#lovable-badge`, the starter's head defaults, `*.lovable.app` in an
  address. No longer matches a page that merely says "lovable.dev" in its text. Works for the shell,
  every rendered route and the server-rendered kind (custom domains included).
- **prepare** — removes the badge and the two toast regions; drops the starter's default title (slug,
  "Lovable App") and description so they never become the new site's search text; wraps the
  `fixed top-0` nav in a `<header>` so the logo is found; wraps shadcn fields drawn without a `<form>`
  in one (smallest box with ≥2 fields and a button, never a section or one with h1/h2) so their
  questions are listed and kept out of the words; turns `<p>"…"</p>` testimonials into quotes.
- **noise** — "Edit with Lovable", "Built in/with Lovable", "Made with Lovable", "Notifications (F8)".
- **fullSizeImage** — Unsplash `?w=800` → `w=1600` (crop height dropped).
- **rendersWithJs** — true (the classic kind; the server-rendered kind needs no browser and reads fine).
- No `contentRoot`: pages have no `<main>`; the shared body fallback (minus nav/header/footer) is right.

**How the menu is found when the router draws the links:** React Router's `<Link>` and TanStack's
`<Link>` render plain `<a href="/about">` once the page is drawn, so the menu comes from the rendered
page (`readPage` keeps the rendered read's `navLinks`). Menu items that are buttons scrolling to a
section ("Gallery", `/#contact`) have no page of their own; their sections are already on the home
page, so nothing is lost. What is lost: Radix NavigationMenu drop-downs (content only exists while
hovered) and the mobile Sheet menu (only exists while open) — but the desktop bar has the same links.

**Would a sitemap help?** A little. Lovable does not generate one by default (the starter has none);
newer projects often add `public/sitemap.xml` (one studied had a sitemap listing only `/`). Where one
exists it lists routes the menu does not link (footer-only pages, service sub-pages), and since every
route answers with the shell it costs one render per page. Worth reading as a *fallback* when the
rendered menu is short — shared change, below.

## Can be done (not done yet)

1. **Read shadcn colour tokens** (S) — `brand-extract.ts parseColour` reads hex/rgb only, so the look
   came back with **no colours** for both kinds (v3 `--primary: 158 45% 30%`, v4 `--primary:
   oklch(55% .15 35)`). Add: bare HSL triplets (`/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/`
   → hsl→hex), `hsl(…)`/`hsla(…)`, and `oklch(L C H)` (→ OKLab → linear sRGB → sRGB, clamp). Then
   `--primary`, `--background`, `--foreground` give primary, canvas and ink. Also read `:root` only, not
   `.dark{…}` (the dark palette's `--primary` would otherwise compete). Touches `brand-extract.ts`.
2. **Heading font from `.font-display` / `--font-display` / `--font-heading`** (S) — v3 came back
   "Inter" (the html default) instead of Fraunces. In `site-import-theme.ts readImportedLook`, before
   `ruleFont(/\bh[12]\b/)`, try `--font-(display|heading)` and a `.font-(display|heading|serif)` rule.
3. **Read the look from the rendered page when the page was rendered** (S) — `runImport` passes
   `home.html` (the empty shell) to `readLook`, so classes on the drawn buttons (`rounded-full`) and
   `<body>` are never seen (radius came back null for the SPA). Return the rendered html from
   `readPage` as `lookHtml` and use it. Touches `site-import.ts`.
4. **Sitemap fallback for JavaScript menus** (M) — when the rendered home page has fewer than ~3 menu
   links, read `/sitemap.xml` (same host, through the fence) and offer its paths to
   `pickImportPages`. Touches `site-import.ts`, `site-fetch.ts`.
5. **The brand link labels "Home"** (S) — the logo link (`<a href="/">Kiln & Clover</a>`) comes first in
   the bar, so the home page's menu label becomes the business name. In `readImportPage`, prefer a
   later same-address link's text when the first one holds the logo or equals `siteName`. Touches
   `site-extract.ts`.
6. **Tell owners which link to paste** (S) — a `lovable.dev/projects/…` editor link needs a login and
   an `id-preview--….lovable.app` link is the unpublished preview; `cleanImportUrl` could answer
   "Paste your published address (….lovable.app or your own domain)". Touches `site-import.ts`.

## Can't be done

- **Closed accordion answers, tabs, dialogs, drop-downs** — Radix renders closed content as an empty
  `hidden` element; the words exist only in the JavaScript bundle. Reading them would mean clicking
  every trigger in the headless browser (a different, slower renderer) or parsing minified JSX — not
  safe or reliable. The FAQ questions are kept (as headings); answers must be pasted.
- **Buttons with no address** (`<button onClick={() => navigate(…)}>`, scroll buttons, "Book a class"
  opening a dialog) — the destination is in code, not markup. They are left out quietly.
- **Content behind Supabase login or fetched per visitor** — Lovable apps often use Supabase; anything
  behind sign-in or loaded from a private table is not readable (and should not be).
- **Their form's behaviour** (Supabase insert, edge function, Resend) — our hosted contact form
  replaces it; only its questions are carried.
- **Framer Motion `whileInView` sections** stay `opacity:0` in the render below the fold, but their words
  are in the DOM, so they are read; nothing to do.

## Suggested improvements to our import

- **Magento's detect claims Lovable pages** (and every adapter after it): `/Magento_|mage\/|…/` matches
  `image/x-icon` / `image/svg+xml`. Fixed on the Magento session's branch (5aea3b1c); until merged, every
  Lovable import reports `platform: 'magento'`. The Lovable test holds Magento to its fixed signals while
  it runs, so it will keep passing after the merge.
- Items 1–3 above help every Tailwind/shadcn site (Bolt, v0, Replit, Cursor, Claude Code builds too).
- A `kind: 'quote'` rule in the shared walk for `<p>` wrapped in quote marks would help every builder
  (done here for Lovable only).
- Shared "form without `<form>`" detection (the `wrapLooseForms` logic here) would help every React site.

## Detection

Signals (`LOVABLE_MARKUP`): `"/~flock.js`, `"/__l5e/`, `cdn.gpteng.co`, `gptengineer.js`, `data-lov-id=`,
`/lovable-uploads/`, `id="lovable-badge`, `lovable.dev/opengraph-image`, `content="@lovable_dev"`,
`content="Lovable Generated Project"`, `<meta name="author" content="Lovable">`, and
`href|src|content="https://<x>.lovable.app`.

- False positives avoided: the words "lovable" / "lovable.dev" in text (blog posts about Lovable on a CMS
  are claimed earlier by their CMS adapter anyway); a bare Vite shell with no Lovable markup.
- False negatives: an exported project hosted elsewhere whose owner replaced every head default and
  uploads — indistinguishable from any Vite + shadcn app (then no adapter runs; the shared import still
  renders and reads it). The server-rendered kind on Lovable hosting is always caught by `/~flock.js`.
- Order: Lovable sits after Magento in `index.ts`, so it depends on the Magento fix above.
