# Website import — platform summary (2026-11-09)

One session per platform improved that platform's adapter (`src/utils/site-builders/<key>.ts`) on its own
branch, with a test, synthetic fixtures and a report (`docs/site-import-platforms/<key>.md`). This page pulls
the 34 reports together. **All 34 adapters are merged into staging** (2026-11-09; Magento's adapter only —
its shared changes were re-applied after review), and every platform test passes with all of them together.

## Where each platform stands

**How it reads today** (with its adapter merged):
✅ reads well: words, menu, full-size pictures, buttons and links. 🟡 reads well once one or more of the
shared fixes below land (mostly the look). 🔵 headless or AI-built: reads when the page or its framework data
holds the words; nothing to detect, so generic framework handling does the work.

| Platform | Reads | Branch | What the adapter does / what's left |
| --- | --- | --- | --- |
| WordPress | 🟡 | `claude/cool-brahmagupta-457ead` | detects without the generator tag; drops post furniture; full-size uploads. Left: theme.json colours (look hook) |
| Elementor | 🟡 | `claude/laughing-northcutt-f2e776` | drops phone copies; counters read right. Left: kit colours (look hook), backgrounds in its CSS file, WooCommerce-on-Elementor |
| WooCommerce | 🟡 | `claude/gifted-kapitsa-805e56` | product cards rebuilt, prices kept off. Left: shops built with Elementor get Elementor's adapter |
| Wix | ✅ merged | `claude/youthful-panini-fd38fb` | Left: Wix theme colours (look hook); `srcset` with commas |
| Wix Studio | ✅ merged | `claude/clever-kilby-26fb62` | told apart from classic Wix (tested). Grid order can differ from visual order |
| Squarespace | 🟡 | `claude/objective-hypatia-f6ae06` | detection without generator; folder titles no longer imported as pages. Left: 7.1 look, footer facts |
| Shopify | 🟡 | `claude/affectionate-meninsky-b574fc` | detection on Shopify's own markers; cart/currency furniture out. Left: products JSON → Business Information; Dawn colours |
| Webflow | 🟡 | `claude/kind-bhaskara-f706cd` | Left: ignore Webflow's base CSS for the look; `var()` backgrounds; section backgrounds from class rules |
| Framer | 🟡 | `claude/stoic-dewdney-a09475` | keeps only the desktop copy; finds the menu. Can't: hover drop-downs drawn by script. Left: dark-mode colours |
| Lovable | 🔵 | `claude/relaxed-bartik-829201` | rendered page works. Left: shadcn colour tokens; look from the rendered page |
| Bolt.new | 🔵 | `claude/jolly-nightingale-195a11` | Bolt Cloud detected; elsewhere no trace |
| v0 | 🔵 | `claude/compassionate-kirch-633389` | RSC payload read; streamed content spliced. Can't: words only in JS bundles |
| Replit | 🔵 | `claude/vibrant-edison-b99c26` | Left: say why a sleeping or private app couldn't be read |
| Cursor | 🔵 | `claude/gallant-babbage-fe0de4` | no trace possible; pins what we read from static, Next.js, Astro and Vite shapes |
| Claude Code | 🔵 | `claude/determined-albattani-7ee070` | no trace possible. Left: `.html` page addresses, CMS-filled pages from `/content/*.json` |
| Windsurf | 🔵 | `claude/unruffled-solomon-0a3fd2` | detection tightened; Next.js pictures full size. Left: give detect the page address |
| Duda | ✅ | `claude/nice-kepler-016a75` | content root, furniture out. Can't: custom HTML widgets, rotating stock backgrounds |
| Tilda | ✅ | `claude/keen-tesla-adb98f` | full-size pictures, titles as headings. Left: Tilda colours; store/blog feed |
| GoDaddy | 🟡 | `claude/youthful-montalcini-f0df87` | pictures and logo now read (`srcset` commas), backgrounds copied; stock pictures left out on purpose. Left: colours and lettering |
| Hostinger | 🟡 | `claude/pensive-lamport-64f821` | Left: Hostinger's own purple is taken as the brand colour (look hook) |
| Weebly / Square Online | ✅ | `claude/heuristic-lumiere-8d3b33` | menu with sub-pages, logo. Left: Square Online colours and social profiles |
| Carrd | 🟡 | `claude/loving-boyd-d4c856` | detected. Left: produce a one-page site from its `#sections` |
| BigCommerce | ✅ | `claude/strange-swartz-8c0b7e` | shop furniture out, sub-menus grouped, product names (no prices) |
| Magento | ✅ merged | `claude/laughing-blackwell-36511d` | Luma, Hyvä; PWA Studio needs the browser. Products → Business Information merged as opt-in |
| HubSpot | 🟡 | `claude/nifty-wiles-bc3452` | Left: resolve CTA redirect links; form questions; blog suits the blog-posts import |
| AEM | 🟡 | `claude/cool-wilbur-405e0f` | both AEM kinds detected; language picker out of the menu. Left: Edge Delivery menu. Can't: SPA editor sites |
| Sitecore | ✅ | `claude/jovial-colden-48bce2` | XP and JSS/XM Cloud. Can't: personalised content |
| Contentful | 🔵 | `claude/focused-mccarthy-66ba48` | framework picture routes full size; client-only pages flagged |
| Sanity | 🔵 | `claude/confident-dhawan-f8d2a6` | Next.js/SvelteKit/Nuxt page data. The public GROQ API deliberately not used |
| Strapi | 🔵 | `claude/unruffled-maxwell-dc7f4e` | detection needs its media library; `/_next/image` and `/_ipx/` unwrapped |
| Payload | 🔵 | `claude/objective-goldwasser-1a71ea` | reliable detection only; streamed content put back |
| Ghost | ✅ | `claude/vigorous-einstein-e975e9` | home hero read, full-size pictures. Left: Ghost fonts; posts suit the blog-posts import |
| Drupal | ✅ | `claude/hungry-curran-645228` | furniture and breadcrumbs out, main menu only. Left: Olivero brand colour |
| Joomla | ✅ | `claude/compassionate-sinoussi-d02c48` | modules outside `<main>` read; furniture out. Left: Cassiopeia colours |

## Already covered (for every platform)

- Pages that arrive as ordinary HTML: their words unchanged, headings, lists, quotes, links inside sentences, standalone buttons and card links, pictures (full size, with descriptions), CSS background pictures, embedded videos and maps as buttons, the menu and its drop-downs.
- JavaScript-drawn pages through headless Chrome, and Wix "Embed HTML" boxes.
- Prices never reach the site (listed for Business Information; shop products can be added there, opt-in).
- Their form's questions listed; social profile links; old addresses that changed forward to the new pages.
- The look: main, second, background, text, heading, header and footer colours, font pairing, corners, button and card style — from their CSS, Tailwind config and classes.
- Done since the reports: Magento no longer claims other sites' pages (merged), the logo uses each platform's full-size rule, shop machinery is never a page, a shop's own pages are read before its catalogue.

## Can be done — shared fixes, by how many platforms they help

1. ✅ **Done 2026-11-09 — a look hook for adapters** (`lookStylesheets`, `lookCss`, `look`; wired for WordPress, Elementor, Wix, Squarespace, Shopify, GoDaddy, Hostinger, Webflow, Ghost, Joomla). Was: (WordPress, Elementor, Squarespace, Shopify, Webflow, Wix, Hostinger, GoDaddy, Tilda, Ghost, Drupal, Joomla, Framer, Weebly — 14). Builders ship their own UI colours, or keep the owner's theme in variables we don't read (`--wp--preset--*`, `--e-global-*`, Dawn's tokens, Ghost's `--gh-font-*`). Let each adapter give its own colours and fonts and say which CSS to ignore. **S–M, biggest single win.**
2. ~~Merge the 31 waiting branches~~ — done 2026-11-09.
3. ✅ **Done 2026-11-09 — framework page data and pictures** (`site-page-data.ts`: streamed content spliced, a shell's words from Next.js / RSC / Remix / SvelteKit / Nuxt data; picture routes unwrapped incl. Astro and Cloudflare). Was: (v0, Sanity, Sitecore, Contentful, Strapi, Payload, Cursor, Windsurf, Lovable — 9): unwrap `/_next/image`, `/_ipx/`, `/_vercel/image`; expand `__NEXT_DATA__`, the RSC payload, SvelteKit/Nuxt data and streamed Suspense content as one shared step. **M.**
4. ✅ **Done 2026-11-09 — AI-builder colours** (Lovable, v0, Bolt): read shadcn HSL tokens and Tailwind v4 `oklch()`. **S.**
5. ✅ **Done 2026-11-09 — read the look from the rendered page** when headless Chrome drew it (Bolt, Lovable, Framer). **S.**
6. ✅ **Done 2026-11-09 — `srcset` addresses containing commas** (parsed as the HTML spec does). (GoDaddy, Wix): the shared reader splits them wrongly. **S.**
7. ✅ **Done 2026-11-09 — hidden and interactive parts**: empty closed Radix panels filled from page data, icon-only buttons dropped, phone-only drawers removed. `[hidden]` / `aria-hidden` deliberately kept (inactive tab panels and off-screen slides hold real words; duplicates are already dropped). Was:: closed accordions and tabs, `[hidden]` / `aria-hidden`, icon-only buttons, phone-only drawers (Lovable, Wix Studio, Bolt, Elementor). **S–M.**
8. ✅ **Done 2026-11-09 — one-page sites**: a home page whose menu jumps to sections becomes a one-page hosted site with those menu labels. Left: an in-page `#section` BUTTON (not menu) still isn't carried. Was: (Carrd, Bolt, v0): `#section` links and producing a one-page hosted site. **M.**
9. ✅ **Done 2026-11-09 — products from shop data** (`site-shop-feeds.ts`: Shopify `/products.json` with the shop's currency, WooCommerce Store API; up to 200, into the opt-in list). Was: (Shopify `/products.json`, WooCommerce Store API, Tilda store): all products, not only the ones a page shows, into the opt-in Business Information list. **M.**
10. ✅ **Done 2026-11-09 — platform pairs**: WooCommerce-on-Elementor pages get both adapters' tidying and products. Was:: WooCommerce-on-Elementor should get both adapters' tidying. **S.**
11. ✅ **Mostly done 2026-11-09**: `.html` addresses → clean slugs (old addresses forward); tracking parameters stripped everywhere; CMS-filled `/content/*.json` pages are read by the headless browser, which runs their own script (no second route needed). Left from the list: HubSpot CTA redirects, search box ≠ form, phone written two ways, Squarespace 7.1 footer facts. Was — smaller ones: `.html` addresses make ugly slugs (`about.html` → `/about-html`); CMS-filled pages from `/content/*.json`; give `detect` the page address (Windsurf, Bolt); say why a Replit app couldn't be read; resolve HubSpot CTA redirects; strip tracking parameters; a search box isn't a form; the same phone written two ways counted once; footer facts on Squarespace 7.1.

## Can't be done (any platform)

- **Content behind a login or password**: members' pages, paid posts, B2B prices, private apps and previews.
- **Personalised content** (Sitecore, HubSpot smart content): we see the default only.
- **A working shop**: cart, checkout, accounts, stock, option pickers. Hosted sites sell through Stripe only.
- **Third-party script widgets**: chat, booking, review widgets, custom HTML embeds, Tilda/Wix forms. Hosted sites run no scripts.
- **Words that exist only inside JavaScript bundles**, or that a page fetches from an API in the visitor's browser.
- **Motion**: interactions, autoplay sliders, hover menus drawn by script, Lottie. These become still content.
- **Telling which AI tool built a site** (Cursor, Claude Code, Windsurf, most Bolt sites): they leave no trace. That's harmless, because generic handling reads them.
- **Exact visual order on grid or absolute layouts** (Wix Studio, Tilda Zero Block).
- **Builders' own stock photos and crops**: GoDaddy stock (licensing); Elementor thumbnails, which have no link back to the original.
