# Sitecore

Adapter `src/utils/site-builders/sitecore.ts` · test `tests/site-platform-sitecore.test.ts` · synthetic
fixtures `tests/fixtures/site-platforms/sitecore/` (fictional "Fern & Field Garden Design"; markup
modelled on public Sitecore docs and two public sites studied by `curl`, no real words or pictures kept).

## How sites on Sitecore are built

Sitecore is an enterprise CMS; small businesses meet it mostly through agencies, franchises and
member organisations. Two shapes:

- **XP / XM with MVC renderings (usually SXA, the Experience Accelerator).** Server-rendered HTML.
  SXA layout: `div#wrapper > header > div#header`, `main > div#content`, `footer > div#footer`. Every
  component is `div.component.<name> > div.component-content`, its fields `field-<name>` classes
  (`.component.rich-text`, `.promo .field-promotext`, `.title .field-title`, `.page-content .field-content`,
  `.carousel`, `.image .field-imagecaption`). The menu is `.component.navigation` with nested
  `ul.clearfix > li.level1/level2` — `li.submenu` marks the item that HAS a drop-down. Cookie warning is
  `.privacy-warning` (not called "cookie"). Forms (Sitecore Forms) post to `/formbuilder` with
  `data-sc-fxb`. Themes' CSS and JS also live in the media library (`/-/media/themes/…`).
- **Headless: JSS (React/Angular/Vue) and XM Cloud (Next.js, headless SXA).** The Layout Service's JSON —
  `sitecore.context` + `sitecore.route.placeholders` → renderings `{componentName, fields, placeholders}` —
  rides in `__NEXT_DATA__` (`props.pageProps.layoutData.sitecore`) on the Pages Router, or in
  `<script id="__JSS_STATE__">` in JSS apps. Fields are `{value}` (text, rich-text HTML, `{src,alt}`
  pictures, `{href,text}` links); headless SXA components use GraphQL shapes
  (`fields.data.datasource.children.results[].field.jsonValue.value`). Headless SXA markup reuses the SXA
  class names. Newer XM Cloud / Content SDK sites on the App Router carry RSC (`self.__next_f`) instead
  (sitecore.com does) — their HTML is still server-rendered.
- **Pictures**: media library `/-/media/<path>.jpg?h=&w=&mw=&mh=&la=en&hash=…`, older `/~/media/<path>.ashx?h=&w=&as=&sc=`,
  JSS `/-/jssmedia/…`, XM Cloud Experience Edge `https://edge.sitecorecloud.io/<tenant>/media/…?h=&iar=0&w=`,
  Content Hub DAM `*.sitecorecontenthub.cloud/api/public/content/…`; on Next.js wrapped in
  `/_next/image?url=…&w=&q=`. With hash protection on (default), resize parameters without a valid hash
  are ignored and the original is served.
- **Colours**: in the SXA theme CSS (`/-/media/themes/…/styles/*.css`) or the Next.js CSS bundle — ordinary
  `<link rel="stylesheet">`, so the shared theme reader sees them.

## Already covered

Before this pass (run on the fixtures, `readImportPage` + `runImport` with fake deps, no model):
server-rendered XP/SXA and XM Cloud pages read their headings, paragraphs, inline links, buttons,
captions, quotes, background hero picture, contact details, social profiles and form questions; the
footer and header stay out.

What was lost:
- the SXA menu filed "Services" under "Home" (`li.submenu` read as a drop-down box);
- every picture came at its resized size, signed with a hash (`?h=400&w=600&hash=…`), the logo too, and
  Next.js pictures as `/_next/image?url=…` wrappers;
- a shell page (XM Cloud Next.js with client-drawn components, or a client-rendered JSS app) read
  **0 words** though every word was in the page's JSON — it would have needed the headless browser;
- SXA share buttons ("Facebook", "Share on X") came through as list items;
- `detect` matched any page containing the word "sitecore" or "/-/media/" anywhere.

## Fixed in this pass

- **Tighter detection** — generator tag, Layout Service JSON, a same-site media-library address in an
  attribute or `url()`, Experience Edge / Content Hub addresses, Sitecore Forms / analytics / Experience
  Editor markers, or SXA's component + component-content + field- classes together. *"a page that only
  mentions Sitecore … is not Sitecore"*, *"single strong signals each suffice"*.
- **Full-size pictures** — resize/crop parameters and the hash dropped, `mw=1600` asked for (ignored
  without a hash, so never worse than the original); `/_next/image` unwrapped; done in `prepare` on every
  `<img>` so the **logo** is full size too. *"media library resizes become one sensible full-size address"*,
  *"every picture … arrives full size — logo included"*.
- **SXA menu drop-downs** kept right; `.component.navigation` counted as the menu wherever it sits.
  *"the SXA menu keeps its drop-down"*.
- **Sitecore furniture removed**: privacy warning, breadcrumb, share buttons, search box, language
  selector, back-to-top, Experience Editor leftovers. *"the words come in order; breadcrumb, share buttons…"*.
- **Shell pages read from the layout JSON** (`__NEXT_DATA__` or `__JSS_STATE__`), only when the HTML has
  under 40 words: header placeholders → `<header>` (logo, menu with drop-downs from the Navigation
  component), main → `<main>`, footer → `<footer>`; text/rich text/pictures/links in editor order;
  settings, ids, metadata, dates, numbers, booleans and the dictionary skipped. Same words, menu, logo and
  pictures as the server-rendered page, with no headless browser. *"…an empty shell is read from the
  layout JSON"*, *"the layout JSON gives no settings…"*, *"a JSS shell imports without the headless browser"*.

## Can be done (not done yet)

- **S — logo through the adapter** (`site-extract.ts`): the logo uses `fullSizeImageUrl(src)` instead of
  the adapter-aware `fullSize(src)`. Change `logo = { src: fullSizeImageUrl(src), …}` to
  `logo = { src: fullSize(src), …}` in `readImportPage`. (Worked round here by rewriting `img src` in
  `prepare`; other Next.js platforms need it too.)
- **S — unwrap `/_next/image?url=` in the shared `fullSizeImageUrl`** (`site-extract.ts`): every Next.js
  platform needs it (v0, Contentful, Sanity, Sitecore XM Cloud…). See the v0 session's `unwrapNextImage`.
- **M — App Router XM Cloud sites (Content SDK, `self.__next_f`)**: their HTML is server-rendered, so the
  plain read works; closed accordions/tabs would need the shared Flight reader the v0 session proposed
  (`site-nextjs.ts`).
- **M — multilingual sites**: Sitecore sites often serve `/en/…`, `/de/…`; the menu read takes whatever
  language the home page is. A language choice would touch `site-import.ts` (`pickImportPages`).
- **S — `SXA` "Event list / Page list" components** list other pages' teasers; the planner may treat them
  as content. Fine for now; a `noise`/skip rule could follow once a real site shows the shape.

## Can't be done

- **Personalised content**: Sitecore personalises renderings per visitor (XP rules, XM Cloud Personalize);
  we see the default variant a first-time anonymous visitor sees.
- **Content behind login** (extranets, member areas) and Experience Editor/preview hosts — not public.
- **Content Hub DAM pictures** with expiring or private public-link tokens may refuse the copy; they are
  copied like any other picture and listed as failed if refused.
- **Bot protection** on large Sitecore hosts (Akamai/Cloudflare in front) can refuse our fetch — the
  shared fetcher reports it; nothing an adapter can do.

## Suggested improvements to our import

- The two "S" items above (logo via adapter; shared `/_next/image` unwrap) — both one-line changes that help
  every Next.js-based platform.
- A shared `layoutJson` hook: several headless platforms (Sitecore, Contentful, Sanity, Payload) expand JSON
  from `__NEXT_DATA__` into elements; a shared "JSON field → element" writer (text / rich text / `{src,alt}`
  / `{href,text}`, skip ids/settings/dates) would keep them consistent. Sitecore's `LayoutWriter` here is a
  starting point.
- Note for the main session: `magento.ts`'s detect (`mage\/`) matches `image/` and runs before Sitecore in
  `index.ts` (raised by the Contentful session). Sitecore pages with `type="image/webp"` or JSON content
  types would be taken by Magento until that is fixed. These fixtures pass because they contain no
  `image/` string.

## Detection

Signals (any one): `<meta name="generator">` containing "sitecore"; `"layoutData":{"sitecore"`,
`id="__JSS_STATE__"` or `"sitecore":{"context":{` (Layout Service JSON); a media-library address
(`/-/media/`, `/~/media/`, `/-/jssmedia/`) starting an attribute value, a `url()`, or a srcset entry —
i.e. on the site itself; `//edge.sitecorecloud.io/<tenant>/media/` or `*.sitecorecontenthub.cloud/api/`;
`data-sc-fxb`, `/layouts/system/VisitorIdentification`, `SC_ANALYTICS_GLOBAL_COOKIE`, `scWebEditInput`,
`/sitecore/api/(layout|graph|jss|ssc)`; or SXA's `component` + `component-content` + `field-<name>` classes
together.

False positives fixed: the old test matched the word "sitecore" anywhere (an agency's blog post, a
"we're Sitecore partners" footer) and any `/-/media/` text or link to another site. Possible remaining
false negatives: a non-SXA XP site that serves pictures from a CDN host with a rewritten path and no
other marker; an App Router XM Cloud site whose pictures come only from Content Hub *and* that has none of
the JSON markers (Content Hub covers sitecore.com itself).
