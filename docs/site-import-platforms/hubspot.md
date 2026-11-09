# HubSpot Content Hub (CMS Hub)

Adapter `src/utils/site-builders/hubspot.ts` · test `tests/site-platform-hubspot.test.ts` · fixtures
`tests/fixtures/site-platforms/hubspot/` (synthetic pages modelled on HubSpot's markup, studied on
boilerplate.hubspotcms.com and hubspot.com in November 2026; no real business's words or pictures).

## How sites on HubSpot are built
- **Server-rendered.** Pages come from HubL templates on HubSpot's servers, so the words are in the HTML.
  No headless browser is needed for the words (`rendersWithJs` is left off).
- **Words** are in modules wrapped as `<div|span class="hs_cos_wrapper hs_cos_wrapper_type_module|rich_text|header|…">`.
  Theme pages put drag-and-drop areas in `<main id="main-content" class="body-container-wrapper">`, as
  rows `row-fluid-wrapper … dnd-section` > `dnd-module`. Older COS templates have no `<main>`. They use
  `div.header-container-wrapper`, `div.body-container-wrapper` and `div.footer-container-wrapper`.
- **Menu:** themes draw it as `<nav class="menu menu--desktop">` with `li.menu__item--has-submenu > ul.menu__submenu`,
  plus a second copy for phones (`menu--mobile`). The older menu module draws it as `div.hs-menu-wrapper`
  (sometimes with no `role`), `li.hs-item-has-children > ul.hs-menu-children-wrapper`, and the parent's
  link is often `javascript:;`. On sites with more than one language, every link carries `?hsLang=xx`.
- **Pictures** live in HubSpot's file manager. They are served from the site's own host as `/hubfs/…`
  (the original) or `/hs-fs/hubfs/…?width=&height=&name=` (HubSpot's resizer, used in every `srcset`).
  The CDN hosts are `{portal}.fs1.hubspotusercontent-{region}.net/hubfs/{portal}/…`,
  `f.hubspotusercontentNN.net` and `cdn2.hubspot.net`, plus legacy `/hs-fs/hub/{portal}/file-…`. Checked
  live: the resizer **never enlarges** (`?width=3000` on a 598px picture returns 598px), and the CDN
  ignores `?width=` and always serves the original.
- **Section backgrounds** (drag-and-drop) are not inline. They sit in a `<style>` block in `<head>`:
  `.dnd_area-row-0-background-layers { background-image: url('…') !important }`. Colours are written the
  same way, as `linear-gradient(rgba…)`.
- **Colours and fonts:** theme CSS at `/hubfs/hub_generated/template_assets/…min.css` plus
  `template_theme-overrides.min.css`, which holds the theme settings, plus the page's own `<style>` blocks.
- **Forms** are drawn by script into an empty box: `<div id="hs_form_target_…">` (form module),
  `<div class="hbspt-form">` + `hbspt.forms.create(…)` (embed code), or the newer
  `<div class="hs-form-frame" data-form-id data-portal-id>`. The page has no `<form>` and no questions.
- **Script-drawn furniture** (seen only after JavaScript runs): the cookie bar `#hs-banner-parent` /
  `#hs-eu-cookie-confirmation`, the chat `#hubspot-messages-iframe-container`, pop-ups
  `#hs-web-interactives-*`, and old "image CTAs" `.hs-cta-wrapper`. An image CTA is a picture of a button,
  with its words in the `alt` text, linking to `cta-redirect.hubspot.com`.
- **Other furniture:** "Skip to content" (`.header__skip`), the search box (`.hs-search-field`, a real
  `<form>`), the language switcher (`.lang_switcher_class`, links inside the header) and share buttons
  (`hs_cos_wrapper_type_social_sharing`).
- **Blog:** the listing is at `/blog` (body `hs-blog-listing`), with `<article class="hs-blog-post-listing__post">`
  cards. Posts are at `/blog/{slug}` (body `hs-blog-post`). The title is in `#hs_cos_wrapper_name`, the body in
  `#hs_cos_wrapper_post_body`, plus `.blog-post__meta` (author, date), `.blog-post__tags`, `.blog-comments`
  (drawn by script) and `.blog-related-posts`. Every blog has an RSS feed at `{blog}/rss.xml`, linked
  with `<link rel="alternate" type="application/rss+xml">`. It has full post HTML in `<content:encoded>`,
  plus `<pubDate>`; the boilerplate feed lists the latest 10 posts.

## Already covered
(today's shared import on the fixtures, before this pass)
- Words in order from rich-text modules, headings, lists, links inside sentences, and the theme menu with
  its drop-downs (`li > ul`). Contact email and phone are read from the footer.
- The cookie bar is removed by the shared `[id*=cookie]` rule; the chat iframe is skipped as an unknown embed.
- Pictures from `srcset`, picking the largest listed size (still a resized one).

Lost before this pass (the baseline run):
- **Older templates:** the menu, logo and footer were read as page content ("Services Bookkeeping Payroll"
  became one list item; the footer address and © line became text). There was no menu and no logo.
- `hasForm` was true on every theme page because of the **search box**, and false where a real HubSpot
  form was, since that form is drawn by script.
- The language switcher ("English", "Cymraeg") was in the menu, and `?hsLang=en` stayed on every link, so
  a menu page and the same page linked from the body counted as different addresses.
- The image CTA came in as a **picture of a button** from `no-cache.hubspot.com`.
- The hero's background picture (in `<style>`) was lost.
- Pictures stayed resized (`?width=908&height=677&name=…`); the logo was 500px wide.
- Blog posts also brought in the author link and date (as a button and text), the tags, "Read On" and
  the related posts.
- A hand-made site that only had HubSpot's **tracking code** was taken for HubSpot. So would a Drupal,
  Joomla, Ghost, AEM, Sitecore, headless or AI-built site with that code, because those adapters come after
  `hubspot` in `ADAPTERS`.
- Script-drawn "Chat with us" was read as content on a page with no `<main>`.

## Fixed in this pass
All in `hubspot.ts`. Each is proved by `tests/site-platform-hubspot.test.ts` (14 checks, the test names
say which).
- **Detection** narrowed to signs of the CMS itself: the generator tag `HubSpot`, `hs_cos_wrapper`,
  `/hs/hsstatic/`, `/_hcms/`, `/hub_generated/` or `/hs-fs/hub`. The tracking code (`hs-scripts.com`) and
  CDN file links alone no longer count. Tests: *recognised*, *tracking code … alone is not*.
- **Older templates:** `.header-container-wrapper` and `.footer-container-wrapper` are renamed to
  `<header>` / `<footer>`, and menu modules with no `role` get `role="navigation"`. The menu, drop-downs
  ("Services" › Bookkeeping, Payroll), logo and contact details now read correctly, and the footer stays
  out of the content.
- **Furniture removed:** the cookie bar, chat and its button, pop-up anchors, "Skip to content", the
  search box, the language switcher, share buttons, blog comments, related posts, subscribe, post
  listings, author/date line, tags and pagination. Removing the search box means `hasForm` now tells the truth.
- **Forms:** each script-drawn HubSpot form box becomes an empty `<form data-hubspot-form>`. `hasForm`
  and `report.hadForm` are now true, and the form's title stays as their words. No questions are made up:
  `formFields` stays empty.
- **Image CTAs** become `<a class="button">` with the alt text and the CTA's link. One with no alt text is dropped.
- **Links:** `hsLang`, `__hstc`, `__hssc`, `__hsfp`, `_hsenc`, `_hsmi`, `hsCtaTracking` and `hsutk` are
  stripped from every link.
- **Backgrounds:** `background-image: url(…)` rules in `<style>` with a simple selector (`.class`,
  `#id`, `#id .class`, which are what HubSpot writes) are copied inline onto their elements, so the shared
  background reader finds the hero picture. Gradients are skipped.
- **Full-size pictures:** `fullSizeImage` sends site-host pictures through `/hs-fs/…?width=1600` (the
  original, capped at 1600px, never enlarged). CDN pictures lose their size parameters, and theme assets,
  SVGs and GIFs are left alone. `prepare` applies the same rule to every `<img>`, so **the logo is full
  size too**; the shared logo code does not call the adapter hook.
- `contentRoot` is `.body-container-wrapper` (theme `<main>` and old template body alike). `noise` covers
  "Show submenu for …", "Chat with us", "Subscribe …", "Written by …" and "N min read".
- `runImport` end to end with fake deps (no network, `plan` null): platform `hubspot`, form reported,
  email read, and no `hsLang`, cookie text, chat, language name or CTA picture on the draft.

## Can be done (not done yet)
- **HubSpot blog → Blog Assistant (S, for the blog-import session).** HubSpot works well for this. Each
  blog's listing and post pages carry `<link rel="alternate" type="application/rss+xml" href="{blog}/rss.xml">`,
  so the feed discovery in the blog-import patch should find it with no HubSpot-specific code. The feed
  has the full body in `<content:encoded>` and a `<pubDate>`. If a fallback guess is wanted, the guess
  for kind `hubspot` is `${blogIndexUrl}/rss.xml` (the feed belongs to the blog, not the site root: a portal
  can have several blogs, e.g. `/blog` and `/news`). Listing cards are `article.hs-blog-post-listing__post`
  (themes) or `.blog-index__post`; post bodies are `#hs_cos_wrapper_post_body`. Featured images are on
  `og:image` and are file-manager pictures, so `fullSizeImage` applies. Pagination is `/blog/page/2`.
- **Resolve image-CTA links (S, shared: `site-import.ts` or `site-fetch.ts`).** `cta-redirect.hubspot.com/cta/redirect/{portal}/{guid}`
  is a tracking redirect. The import could follow it once, through the fence, and keep the final address.
  Today the button works but goes through HubSpot. The same applies to the newer
  `cta-service-cms2.hubspot.com/web-interactives/public/v1/track/redirect?…` links.
- **Form questions (M, shared: `site-import.ts`, plus a new fetch).** A form's fields are public at
  `https://forms.hsforms.com/embed/v3/form/{portalId}/{formId}/json` (HubSpot's own embed endpoint). The
  ids are in the page's `hbspt.forms.create({portalId, formId})` script, or in `data-portal-id` /
  `data-form-id` on `.hs-form-frame`. `prepare` could keep them as `data-portal-id` / `data-form-id` on
  the marker form. The import would then fetch the JSON through the fence and list the labels in
  `formFields`. This needs a shared hook (the adapter never fetches).
- **Theme colours from theme settings (M, shared: `site-import-theme.ts`).** `template_theme-overrides.min.css`
  holds the owner's chosen colours and fonts from the theme editor, which are more reliable than the main
  CSS. The theme reader could weight that file first when a `hubspot` page links it.
- **Several languages (M, shared: `site-import.ts`).** `<link rel="alternate" hreflang>` lists the other
  languages' pages. The import reads one language today; the report could say "your site is also in Welsh"
  (`cy`).
- **HubSpot video (S, shared: `site-extract.ts` `addEmbed`).** The video module embeds
  `play.hubspotvideo.com/…`. A button to the video page, like YouTube and Vimeo get, would keep it usable.

## Can't be done
- **Members-only and password-protected pages** (memberships, `hs-member-content-access`, private
  content): they need a visitor's login.
- **Smart content** (personalised per list, country or device): we see the default version only.
- **The forms themselves:** submissions go to HubSpot. Our contact form replaces theirs, and their CRM
  workflows do not come across.
- **HubSpot's chat, pop-ups, meetings scheduler and cookie bar:** they are scripts and third-party frames,
  which our hosted sites never run. Removed on purpose.
- **HubDB tables and CRM-driven pages** (dynamic pages listing rows from HubSpot's database): the rows
  that are drawn on the page are read like any page, but there is no table to bring across.
- **Prices** on pricing modules are left off the site on purpose (they belong in Business Information).

## Suggested improvements to our import
- **Logo through the adapter's `fullSizeImage`** (`site-extract.ts`, the logo block uses `fullSizeImageUrl`).
  The Magento session already did this on its branch; with it, hubspot's `<img>` rewrite in `prepare`
  would only be needed for `srcset`.
- **A search box is not a form:** `hasForm` could ignore `form[action*="search" i], form[role="search"]`
  for every platform. This was the main reason `hasForm` was wrong on HubSpot, and it is likely the same
  on WordPress themes.
- **Strip known tracking parameters shared-side** (`utm_*`, `fbclid`, `gclid`, `_hs*`, `__hs*`,
  `hsLang`, `mc_cid`) wherever links are absolutised, not per adapter.
- **Read `<style>` backgrounds for every platform:** many builders (HubSpot, Elementor's per-element CSS,
  Webflow) keep section backgrounds in a `<style>` block. The simple-selector copy in this adapter
  (`inlineStyleBackgrounds`) could move to `site-extract.ts` and run before `<style>` is removed.
- **Adapter-declared blog feed:** an optional `blogFeed?(indexUrl, $): string | null` hook on
  `BuilderAdapter` would let each platform state its feed rule (HubSpot `{blog}/rss.xml`) instead of a
  `kind === …` chain in the blog import.

## Detection
- `detect`: `gen.includes('hubspot')` **or** the HTML contains `hs_cos_wrapper`, `/hs/hsstatic/`,
  `/_hcms/`, `/hub_generated/` or `/hs-fs/hub`. Every CMS page studied had all of these. Landing pages
  and blog pages carry the same generator tag.
- **False positive fixed:** `hs-scripts.com` (the tracking code put on sites built with anything),
  `hubspotusercontent` (files linked from any site) and `hs-sites.com` (a HubSpot preview domain, often
  linked from other sites) no longer count on their own. See `tracking-only.html`.
- **Order risk:** `hubspot` comes after `magento` in `ADAPTERS`. On the base commit, Magento's `mage\/`
  matched `image/png`, so a HubSpot page could come out as `magento` (Magento session's note; fixed on
  its branch). These tests pass on the base commit, because every fixture has the generator tag and no
  `image/…` string in front of HubSpot's markers. Once that fix is merged, the order stops mattering.
- **Possible false negative:** a site served through HubSpot with a fully custom template and the
  generator tag removed would still have `/hs/hsstatic/` or `/_hcms/` (HubSpot injects them), so it is
  still found.
