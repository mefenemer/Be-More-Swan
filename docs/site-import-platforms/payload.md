# Payload CMS

## How sites on Payload CMS are built
Payload 3 is a headless CMS that runs inside a Next.js app, so a "Payload site" is really a Next.js
site whose content comes from Payload. Most small sites start from Payload's **website template**
(`templates/website`); others are custom frontends.

- **Server-rendered.** Pages are React Server Components rendered to HTML, so the words are in the
  first response — the headless browser is not needed (`rendersWithJs: false`). The same content is
  repeated in the RSC payload (`self.__next_f.push(…)` scripts), which the import discards.
- **Rich text** is Lexical, drawn by `@payloadcms/richtext-lexical/react` into
  `<div class="payload-richtext …">` (the template adds Tailwind `prose`). Lexical output is plain:
  `h1–h6`, `p`, `ul.list-bullet` / `ol.list-number` / `ul.list-check` (checklist items are
  `<li role="checkbox"><input><label>…</label></li>`), `blockquote`, `a`. Empty paragraphs are `<p><br></p>`.
- **Blocks** (hero, content columns, media, call to action, form, archive) are `blocks` fields; in the
  RSC payload each block carries `"blockType"` and `"blockName"`. The HTML has no block markers.
- **Pictures** are uploads served at `/api/<collection>/file/<name>` (collection usually `media`), with
  size variants named `<name>-<w>x<h>.<ext>`. The template renders them through `next/image`, so the
  HTML shows `/_next/image?url=%2Fapi%2Fmedia%2Ffile%2F<name>%3F<updatedAt>&w=…&q=100` with a srcset
  up to 3840 wide. Sites on a storage adapter (S3, Vercel Blob…) show that host's address instead.
  Lexical's own upload converter draws `<picture><source srcset=variant>…<img src=original>`.
- **Menu**: the template's header is `<header><nav>` with the header global's links plus a
  screen-reader "Search" link; the footer's `<nav>` holds the footer global (seeded with "Admin",
  "Source Code", "Payload") and a theme picker (Auto / Light / Dark).
- **Slow parts stream**: React Suspense boundaries arrive at the end of `<body>` in
  `<div hidden id="S:0">`, with a `<template id="B:0">` and a fallback ("Loading…") in their place,
  joined by `$RC("B:0","S:0")`. Seen on payloadcms.com itself.
- **Forms** come from the form builder plugin: labels end in `<span class="required">* <span class="sr-only">(required)</span></span>`.

Fixtures are synthetic (a made-up bakery on the template; a made-up joiner on a custom CSS-Modules
frontend), modelled on the template's source on GitHub and on payloadcms.com's public markup.

## Already covered
Before this pass (tested against the fixtures with no network and no model):
- Words, headings, Lexical lists and checklists, inline links, the call-to-action button, quotes,
  contact details and the form's existence all came through, because the pages are server-rendered.
- Pictures were found, but only as next/image addresses (`…/_next/image?url=…&w=3840&q=100`).

## Fixed in this pass
All in `tests/site-platform-payload.test.ts`:
- **Detection** now uses only reliable signals: the Lexical container class `payload-richtext`, a
  Payload file address `/api/<collection>/file/<picture>` (raw or URL-encoded inside next/image), or a
  Payload blocks pair (`blockType` + `blockName`) in the page data. The loose `payloadcms` text test is
  gone (any page that mentions Payload matched). The custom frontend is now recognised; it wasn't before.
- **Streamed content goes back in place**: the Suspense content replaces its "Loading…" fallback, so
  the testimonials sit under "From our regulars" instead of after everything else.
- **Hero and call-to-action links are buttons**: the template draws them as `ul.flex > li > a`, which
  the import read as list items (losing the button). Lexical lists (`list-*` class) are untouched.
- **Pictures**: next/image addresses are unwrapped to the picture Payload holds, and the template's
  `?<updatedAt>` cache tag is dropped, so each picture has one address and is copied at full quality
  rather than as a 3840-wide re-encode.
- **Payload's own furniture** is no longer read as the business's: the template's default Payload
  logo was picked as *their* logo and copied (now removed); "Admin" (the Payload login) and the
  search page were imported as menu pages (now dropped); the archive's "Showing 1 - 2 of 2 Posts"
  and "Search produced no results." are noise.
- **Form questions** lose the plugin's "* (required)" ("Your name* (required)" → "Your name").
- **CSS-Modules header**: a Payload frontend with no `<header>` (only `Header_header__x1Y2z`) had no
  logo found; that box is now treated as the header.

## Can be done (not done yet)
- **Magento claims Payload home pages** (S, `src/utils/site-builders/magento.ts`, its own session):
  its detect `/Magento_|mage\/|requirejs-config/` matches `mage/` inside `data:image/png` and
  `type="image/jpeg"`, which every next/image page has, and Magento is listed before Payload. Exact fix:
  `detect: (html, gen) => /Magento_[A-Z]|\/static\/(?:version\d+\/)?frontend\/|requirejs-config\.js|\bmage\/(?:cookies|apply|translate)/.test(html)`
  (or at minimum `(?<![a-z])mage\/` so "image/" no longer matches). The Payload test runs the home page
  as if this were fixed and says so.
- **Strapi's loose `/strapi/i`** (S, `strapi.ts`, its session) would claim any Payload page that
  mentions Strapi (a "we moved from Strapi" post) — Strapi is listed first.
- **next/image unwrapping for every Next.js site** (S, `src/utils/site-extract.ts` `fullSizeImageUrl`):
  add, before the Wix test:
  `if (u.pathname.endsWith('/_next/image') && u.searchParams.get('url')) return fullSizeImageUrl(new URL(u.searchParams.get('url')!, u.origin).toString());`
  — helps v0, Lovable, Bolt, Cursor and other Next.js builds, not just Payload.
- **Suspense splicing for every Next.js / React streaming site** (M, `site-extract.ts`): move
  `spliceStreamedBoundaries` from `payload.ts` into `readImportPage` before scripts are removed.
- **Payload size variants → a larger size** (S, this file): a `-300x200` thumbnail could become the
  original, but the original's file type isn't known from the variant (a storage plugin may convert to
  WebP), so a guess could 404 and lose the picture. Only worth doing with a HEAD check in the copier.
- **Read rich text from the RSC payload** (L, `site-import.ts`/`site-extract.ts`): only needed if a
  Payload frontend ever draws its words client-side; none seen.

## Can't be done
- **Content behind Payload's access control** (drafts, members-only collections, `/admin`) — needs login.
- **Business details kept in globals that the frontend doesn't show** — we read pages, not the API;
  calling `/api/globals/*` would read data the owner didn't publish as a page.
- **Payload sites with no Payload trace in the HTML** (a custom frontend that doesn't use Lexical's
  React renderer, keeps pictures on another host, and renders without RSC — e.g. Astro over Payload's
  REST API) look like an ordinary site; the generic import still reads them.

## Suggested improvements to our import
- Treat `[class*="Header_header__"]` / `[class*="Footer_footer__"]` (CSS Modules) as header/footer in
  `readImportPage` for all sites — the logo lookup only checks `<header>` and `[id*=header]`.
- A list of `li > a` only, with no list class, is usually a row of buttons on Tailwind/shadcn sites
  (hero links); consider the same rule as this adapter's in the shared walk.
- Detect order: put CMS adapters with narrow signals before loose ones, or test loose regexes
  against the other platforms' fixtures in `tests/site-builders.test.ts`.

## Detection
`detect` is true when any of these is in the raw HTML:
1. `class="… payload-richtext …"` — the default class of `@payloadcms/richtext-lexical/react`'s RichText.
2. `/api/<collection>/file/<name>.(avif|webp|jpg|jpeg|png|gif)`, or the same URL-encoded
   (`%2Fapi%2F…%2Ffile%2F…`) inside a next/image address. Non-picture files (PDFs) don't count.
3. `"blockType":"…"` with `"blockName":` within 4,000 characters (escaped or not) — Payload's blocks
   field. A lone `blockType` doesn't count.

False positives checked: a page that mentions payloadcms.com; a plain Next.js page with next/image;
a script with only `blockType`. False negatives: a Payload site with media on external storage, a
custom rich-text renderer and no RSC (see "Can't be done"). Known clash: Magento's loose detect takes
Payload template home pages first (see "Can be done").
