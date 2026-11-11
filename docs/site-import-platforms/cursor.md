# Cursor

## How sites on Cursor are built
Cursor is an AI code editor, not a host or a builder. An owner who "built it in Cursor" has whatever the
editor wrote with them: usually one of four shapes, hosted on Vercel, Netlify, Cloudflare Pages or GitHub Pages.

| Shape | Where the words are | Pictures | Tell-tale markup |
|---|---|---|---|
| Static HTML + Tailwind (Play CDN or built CSS) | in the HTML | `/images/…`, Tailwind `bg-[url(…)]` heroes | `cdn.tailwindcss.com` + inline `tailwind.config`, `#anchor` menus |
| Next.js App Router (`create-next-app`) | server-rendered HTML; again as the RSC payload in `self.__next_f.push(…)` scripts; late Suspense parts streamed into `<div hidden id="S:0">` at the end of `<body>` | `next/image`: `/_next/image?url=%2F…&w=…&q=75` with `srcset`, `data-nimg` | `/_next/static/`, `__className_…` (next/font), shadcn/ui card classes, framer-motion `style="opacity:0"` |
| Astro | in the HTML; `client:only` islands carry theirs in the `props` attribute only | `/_astro/name.hash.webp`, `<picture>` sources, `/_image?href=…&w=…` | `<meta name="generator" content="Astro v…">`, `data-astro-cid-*`, `<astro-island>` |
| Vite + React SPA | none until JavaScript runs: empty `<div id="root">` | `/assets/name-hash.jpg` | `/assets/index-hash.js`, lucide `<svg>` icons, `onClick` buttons with no link |

There is no Cursor trace in any of them (no generator tag, no comment, no asset path).

Fixtures (all SYNTHETIC, invented businesses): `tests/fixtures/site-platforms/cursor/`
`tailwind-static.html`, `next-app-router.html`, `astro.html`, `vite-shell.html`, `vite-rendered.html`.

## Already covered
Pinned by `tests/site-platform-cursor.test.ts` (20 checks, no network, no model):
- **Static Tailwind**: headings, paragraphs, cards, list items (icon SVGs dropped), quote, inline link, the
  `bg-[url('…')]` hero picture, Google Maps iframe → "See us on the map" button, JSON-LD contact and address,
  og:site_name, header logo, Instagram link. The look reads the Tailwind config background and Fraunces from Google Fonts.
- **Next.js**: all server-rendered words, including those framer-motion starts at `opacity:0`; buttons with
  their links; menu; the RSC payload is never read as words. Imports without headless Chrome.
- **Astro**: words, `<picture>`'s fallback `<img>`, server-rendered islands (`ssr` + children), menu; the look
  reads `:root` custom properties (`--accent`).
- **Vite SPA**: the shell reads 0 words, so `runImport` asks headless Chrome; the rendered DOM imports like any
  page and every word on the draft is from the source (`draftWordsAllFromSource` empty). Without a browser
  the owner gets the plain "draws its words with JavaScript" message and nothing is made.
- Prices on a card ("£35 per person") go to the report's price list, not the site.

## Fixed in this pass
Nothing in the adapter: `detect` stays `false` (no reliable signal, see Detection), so `prepare` /
`fullSizeImage` would never run. Every improvement below belongs in shared code.

## Can be done (not done yet)
1. **Unwrap framework image optimisers** — S. In `site-extract.ts` `fullSizeImageUrl`, before the final return:
   ```ts
   // Next.js next/image and Astro astro:assets: the optimiser address → the original file.
   if (/^\/_next\/image\/?$/.test(u.pathname) && u.searchParams.get('url')) return new URL(u.searchParams.get('url')!, u.origin).toString();
   if (/^\/_image\/?$/.test(u.pathname) && u.searchParams.get('href')) return new URL(u.searchParams.get('href')!, u.origin).toString();
   ```
   Also used for the logo (it already calls `fullSizeImageUrl`). Today: `/_next/image?url=%2Fimages%2Fhero-bike.jpg&w=3840&q=75`.
   Remote `url=https://…` values still go through `savePicture`'s SSRF fence. Also covers v0, Bolt, Lovable-on-Next and any Vercel site.
2. **Read Next.js streamed Suspense content** — S/M. In `readImportPage`, after scripts are removed and before
   header/footer removal: for each `div[hidden][id^="S:"]`, find `template#B:<n>` (same number) and replace the
   fallback between `<!--$?-->` and `<!--/$-->` with the hidden div's children; otherwise move them to the end
   of `<main>`. Today the "What riders say" testimonial is lost because it sits outside `<main>`.
3. **`#anchor` call-to-action links become buttons** — S. In the walk's `a`/`button` branch, treat
   `href="#…"` (non-empty id) as standalone so "Book a workshop" is a button (href null, or the first menu
   page whose label matches). Today it is a `text` block. Same for `<a href="#services"><button>…</button></a>`
   (the inner `<button>` should inherit the parent `<a>`'s href).
4. **One-page menus** — M. When `navLinks` has ≤1 real page but the nav has `#anchor` links, keep them as
   section labels (e.g. `{ text, href: home + '#id' }` passed to the planner as hints) instead of dropping them,
   so the draft can split the one-pager or keep its section order. Touches `site-extract.ts` and `site-import.ts`.
5. **Phone de-duplication** — S. In `readImportPage`'s phone set, compare numbers with a leading `+44`/`0044`
   turned into `0` (`01632 960 418` and `+441632960418` are one number). Today both are kept.
6. **Astro `client:only` islands** — M. In a shared step, read string leaves of an empty `<astro-island>`'s
   `props` JSON (Astro's `[0, "text"]` tuples) into `text` blocks, only when the island has no children.
   Words only, never the component. Lost today: the bakery's review.
7. **Empty-alt picture description** — S. `addImage` uses `lastHeading` — the heading BEFORE the picture,
   which in a card is the previous card's ("Repotting" picture described as "Kokedama"). Prefer the first heading
   inside the same parent card when there is one.
8. **Home page label** — S. `runImport` names the home page after the first nav link to `/`, which is the
   logo link ("Spokesmith", "Quayside"); prefer "Home" when that link's text equals the site name or it wraps the logo.
9. **Brand colour from utility classes on any CTA** — S. `site-import-theme.ts` didn't take `bg-clay` (custom
   Tailwind config colour on the hero CTA) as primary, likely because the CTA isn't a "button" in its reading;
   follows from 3.

## Can't be done
- **Recognising a Cursor site**: the editor leaves nothing in the output; any signal would be the framework
  or host, which says nothing about Cursor.
- **SPAs without headless Chrome**: a Vite/CRA shell has no words; only the browser read helps (already wired).
- **Words behind interaction** (tabs, accordions filled on click, data fetched from the owner's API after load):
  a page.content() snapshot gets only what the first render shows.
- **Running their scripts or frameworks on the hosted site**: hosted sites run no scripts, so animations and
  `onClick` behaviour are not carried; their words and pictures are.

## Suggested improvements to our import
- ⚠️ **`magento.ts` detect matches `image/`** (`mage\/` in `type="image/svg+xml"`, `image/avif`, `image/x-icon`),
  so every Next.js, Astro and Vite fixture here reads as `platform: 'magento'`, and every adapter after Magento in
  `ADAPTERS` never runs on such pages. The Magento session was told; check it landed. Suggested pattern:
  `/Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config|["'\/]mage\/(?:cookies|requirejs)/`.
  Worth a shared test in `site-builders.test.ts`: a plain page with `<link rel="icon" type="image/svg+xml">` matches no adapter.
- Framework-level adapters (Next.js, Astro, Vite/React) would be a better home for items 1, 2 and 6 than
  editor-named ones (cursor, windsurf, claude-code, v0, bolt): the editors all produce the same frameworks.
  If they stay editor-named, put the framework handling in `site-extract.ts` so every one benefits.
- The report could say "made with Next.js / Astro / React" (framework, from `/_next/`, Astro generator,
  `#root` + `/assets/index-*.js`) instead of `builder: 'other'`.

## Detection
`detect` returns `false` always. Checked signals and why none qualifies:
- No generator tag, comment, asset path or meta from Cursor in any of its outputs.
- `.cursor/` or `.cursorrules` files live in the repository, never in the deployed site.
- Framework signals (`/_next/`, Astro generator, Vite `/assets/index-*.js`) are shared by v0, Bolt, Lovable,
  Windsurf, Claude Code and hand-written sites, so claiming them as Cursor would be a false positive.
Found while testing: the Magento adapter falsely claims these pages (see above).
