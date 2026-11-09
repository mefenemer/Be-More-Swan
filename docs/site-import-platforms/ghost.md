# Ghost

Adapter `src/utils/site-builders/ghost.ts` · test `tests/site-platform-ghost.test.ts` · synthetic fixtures
`tests/fixtures/site-platforms/ghost/` (Casper: home, about, classes, contact; Source: home, post), modelled on
public Ghost 6.75 demo markup (demo/casper/source.ghost.io, studied 2026-11-08) with made-up businesses.

## How sites on Ghost are built
- **Server-rendered** Handlebars themes. Every word is in the HTML; no headless browser needed.
  The official themes (Casper, Source, Edition, Headline, Solo, Dawn…) share class names.
- **Words**: a post or page body is `section.gh-content` made of Koenig editor cards (`.kg-card`):
  image, gallery, callout, toggle, button, header (v1 background-image / v2 `<picture>`), product, bookmark,
  file, video, audio, embed, signup, CTA. Title/excerpt/feature image sit in the article's own `<header>`.
- **Home** is usually a post feed (`.post-card` in Casper, `.gh-card` in Source). The home's own heading, line
  and cover picture are drawn ABOVE `<main>` (Casper `.site-header-content`, Source `.gh-header`).
- **Menu**: `ul.nav` inside `header#gh-head nav.gh-head-menu` (Casper) or `header#gh-navigation` (Source). Flat — Ghost
  has no drop-downs. A second menu (`site-footer-nav` / `gh-footer-menu`) lives in the footer.
- **Pictures**: `/content/images/YYYY/MM/x.jpg` (self-hosted or `storage.ghost.io/c/…/content/images/…`), resized copies at
  `/content/images/size/w600/format/webp/…`. Ghost resizes uploads to ≤2000px, so the original is a sensible size.
- **Colour**: `<style>:root {--ghost-accent-color: #…}</style>` in every head. Fonts (Ghost 5.x+):
  `<style>:root {--gh-font-heading: Fraunces; --gh-font-body: Inter;}</style>` and `gh-font-heading-*` body classes.
- **Members furniture**: Portal (`data-portal`, `#/portal/…` links), Sign in/Subscribe, `data-members-form` forms,
  `.kg-signup-card`, `.gh-post-upgrade-cta` ("This post is for subscribers only"), search (`data-ghost-search`),
  bylines, reading times, tags, `#/share` buttons, "Powered by Ghost".
- **Tell-tale markup**: `<meta name="generator" content="Ghost 6.x">`, `--ghost-accent-color`, Portal script from
  `cdn.jsdelivr.net/ghost/portal` with `data-api=".../ghost/api/content/"` and a public `data-key`.

## Already covered
Menu pages, inline links, headings/paragraphs/lists/quotes, gallery and image cards (with captions), toggle cards (the answer
is in the HTML), button/header/product card links, YouTube and map embeds, prices into the report, mailto/tel contact,
JSON-LD/og site name, and the accent colour (`--ghost-accent-color` is read as an accent variable). Tag/author pages are skipped by `SKIP_PATH`.

## Fixed in this pass
All in `tests/site-platform-ghost.test.ts`:
- **Home hero read**: Casper/Source draw the home heading, line and cover above `<main>`; moved into `<main>` (test "Casper home…", "Source…").
- **Full-size pictures**: `/size/wN/` and `/format/webp/` stripped, so card and feature copies of one picture dedupe.
- **Furniture removed**: Portal links/buttons, Sign in/Subscribe, sign-up cards, members-only cut, search and burger buttons,
  bylines (author name was read as a heading and the avatar as the logo), dates, reading times, tags, "Featured",
  "Paid-members only", Share, "Powered by Ghost", Koenig player controls ("Play audio", "0:00", "1×") and the toggle's
  "Expand toggle to read content" button. A sentence that only sends people to Portal goes whole.
- **Paging is not a page**: `nav.pagination` "Older Posts →" was taken as a menu page (and fetched); removed. Source "See all" too.
- **Bookmark card** (a preview of someone else's page — their description, publisher, favicon, thumbnail) → one link under its title.
- **File card** → one download link under the owner's title (not "studio-history.pdf · 412 KB").
- **Logo**: the article's own `<header>` is renamed to a `<div>`, so a feature image is no longer taken as the logo; a text-only logo link is no menu entry.
- **Detection** widened: `--ghost-accent-color`, `data-ghost-search`, `cdn.jsdelivr.net/ghost/`; generator must START with "ghost".

## Can be done (not done yet)
- **Magento's detect claims Ghost (and many other) pages — S, `site-builders/magento.ts` (Magento session) or `index.ts` (main).**
  `mage\/` matches `image/png` / `image/svg+xml`, which almost every site has in its favicon `<link type=…>`. Ghost is listed after
  Magento, so real Ghost home pages read as Magento and get none of this adapter. Fix: `/Magento_|\/static\/version\d+\/|requirejs-config|mage\/(?:cookies|bootstrap)/`.
  Safer order in `index.ts`: adapters whose evidence is the generator tag (ghost, drupal, joomla, hubspot) before the
  substring-only ones (magento, aem, sitecore, strapi, godaddy, bigcommerce). **Fixed by the Magento session** on
  `claude/laughing-blackwell-36511d` (5aea3b1c, tests 605fe980): no bare `mage/` any more, and a test asserts that image/png pages are not Magento.
  It reaches Ghost once that branch is merged. When it is, drop the favicon strip in `tests/site-platform-ghost.test.ts`.
- **Ghost fonts — S, `site-import-theme.ts`**: read `--gh-font-heading` / `--gh-font-body` from inline `<style>` (theme CSS uses
  `var(--gh-font-heading, …)`, which `firstFamily` can't resolve). Today `font` is null for Ghost.
- **Text colour read as the accent — S, `brand-extract.ts`/`site-import-theme.ts`**: with only the accent variable inline,
  `textColor` came back `#2e7d5b` (the accent). Exclude the chosen primary from `darks`.
- **Self-hosted video — S, `site-extract.ts`**: Koenig `<video src=…/content/media/…mp4>` gives only its thumbnail (from the style).
  A "Watch the video" button to the file (as `addEmbed` does for YouTube) would keep it.
- **Footer menu pages — M, `site-extract.ts`/`site-import.ts`**: Ghost's secondary navigation is the footer menu; footer `nav` links are
  read into `navLinks` only because the footer is removed after the menu read. Works today, but it is accidental; worth a test.
- **Plain address paragraph — M, shared**: "Fernhill Barn, Mill Lane, … FE1 2AB" in a `<p>` isn't found as the address (no `<address>`/JSON-LD).
- **Blog posts into the Blog Assistant — M, the blog-import session.** What it needs from Ghost:
  1. **Find them**: `<link rel="alternate" type="application/rss+xml" href="…/rss/">` in every head; `/sitemap-posts.xml` lists every public post.
  2. **RSS** `/rss/` (pages `/rss/2/`…, 15 per page): `<item>` has `title`, `link`, `guid` (post id), `dc:creator`, `pubDate`,
     `category` (tags), `media:content url` (feature image) and the **full HTML** in `content:encoded` (Koenig card markup, same as `gh-content`).
     Members-only posts carry only the public part (cut at the paywall).
  3. **Content API** (better): the Portal script tag gives `data-api` (`https://site/ghost/api/content/`) and `data-key` — a public,
     read-only key meant for browsers. `GET {api}posts/?key={key}&limit=all&include=tags,authors&formats=html` returns `title, slug,
     html, excerpt/custom_excerpt, feature_image(+_alt,_caption), published_at, tags, authors, meta_title/description, visibility`.
     Same SSRF fence applies; `/ghost/api/` should be allowed by robots on Ghost(Pro).
  4. Clean the post HTML with this adapter's `prepare` (Koenig cards, Portal) and `fullSizeImage`; keep `/slug/` → `/blog/slug` redirects.
  5. The home feed is then the blog: when posts are imported, the feed cards on the home page (`.post-feed`, `.gh-feed`) shouldn't
     also be copied as static sections, and a menu "Journal"/"Blog" pointing at `/tag/…/` or `/` should switch the blog on.

## Can't be done
- **Members-only and paid posts**: the server cuts the content for visitors; only the public part is readable.
- **Email-only content and newsletters**: never on the web.
- **Members, subscriptions, Portal, comments, search**: Ghost services; our hosted sites have no members and run no scripts.
- **Audio card files and embedded third-party players** (other than YouTube/Vimeo/maps): no scripts or third-party frames.

## Suggested improvements to our import
- Order adapters by strength of evidence (generator tag first), and add a test that each platform's fixture is detected as its own
  platform with an ordinary `<link rel="icon" type="image/png">` in the head.
- Let an adapter name "page furniture above `<main>`" it wants read (or a `contentRoot` list), instead of moving nodes in `prepare`.
- A shared "Watch the video" for self-hosted `<video>`, and a shared "Download" wording for file links, so adapters needn't invent words.

## Detection
`gen.startsWith('ghost')` (generator "Ghost 6.75") or the HTML has `ghost-portal`/`ghost-sdk`, `/ghost/api/`,
`--ghost-accent-color`, `data-ghost-search` or `cdn.jsdelivr.net/ghost/`. False negative found: Magento's `mage\/` wins on any page with
`type="image/png"` (see above). Headless Ghost (Next.js/Gatsby front end reading the Content API) has none of these and is not Ghost
markup at all — it falls to the generic reader or the JavaScript-site path.
