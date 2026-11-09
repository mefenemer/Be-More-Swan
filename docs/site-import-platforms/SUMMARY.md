# Website import — platform summary (2026-11-09)

One session per platform improved that platform's adapter (`src/utils/site-builders/<key>.ts`) on its own
branch and wrote a report (`docs/site-import-platforms/<key>.md`). This page pulls the reports together.
**Status: 12 of 34 reports in. The others were cut off by usage limits and are being resumed.**

## Where each platform stands

| Platform | Report | Branch | Notes |
| --- | --- | --- | --- |
| BigCommerce | ✅ | `claude/strange-swartz-8c0b7e` | shop furniture removed, sub-menus grouped, full-size pictures, product names (no prices) |
| Bolt.new | ✅ | `claude/jolly-nightingale-195a11` | Bolt Cloud sites detected; elsewhere no trace (generic SPA handling) |
| Hostinger | ✅ | `claude/pensive-lamport-64f821` | Hostinger's own purple taken as the brand colour — needs a shared look fix |
| HubSpot | ✅ | `claude/nifty-wiles-bc3452` | blog suits the blog-posts import; CTA redirect links need resolving |
| Lovable | ✅ | `claude/relaxed-bartik-829201` | rendered-page import works; shadcn colours not read yet |
| Magento | ✅ ⚠️ | `claude/laughing-blackwell-36511d` | **went outside its brief**: also edited 10 shared files (products → Business Information, page ranking). Review before merging |
| Sanity | ✅ | `claude/confident-dhawan-f8d2a6` | page data in Next.js / SvelteKit / Nuxt; public GROQ API deliberately not used |
| Sitecore | ✅ | `claude/jovial-colden-48bce2` | XP + JSS/XM Cloud; personalised content can't be seen |
| v0 | ✅ | `claude/compassionate-kirch-633389` | RSC payload read; words only in JS bundles can't be |
| Webflow | ✅ | `claude/kind-bhaskara-f706cd` | Webflow's base CSS skews the look; Ecommerce prices left out |
| Wix | ✅ | `claude/youthful-panini-fd38fb` | ⚠️ reports that the Wix Studio adapter claims every classic Wix page |
| Wix Studio | ✅ | `claude/clever-kilby-26fb62` | grid order can differ from visual order |
| AEM, Carrd, Claude Code, Contentful, Cursor, Drupal, Duda, Elementor, Framer, Ghost | ⏳ resumed | — | cut off before committing |
| GoDaddy, Joomla, Payload, Replit, Shopify, Squarespace, Strapi, Tilda, Weebly, Windsurf, WooCommerce, WordPress | ⏳ to resume | — | cut off before committing |

## Fixes many reports ask for (shared code, main session)

Ranked by how many platforms they help:

1. **Magento's detect claims other sites** (5 reports). The scaffold's `/mage\//` matches `image/` in any page, and Magento runs early, so Lovable, Vite, Hostinger and Sitecore pages were taken as Magento. Fix before merging anything (the Magento branch has its own fix).
2. **The logo skips the adapter's full-size rule** (7 reports): `site-extract.ts` reads the logo with `fullSizeImageUrl`, not the adapter's `fullSizeImage`. One-line fix.
3. **Unwrap `/_next/image?url=`** in the shared `fullSizeImageUrl` (v0, Sitecore, Sanity, every Next.js site).
4. **A look hook for adapters** (Hostinger, Webflow, Wix, Wix Studio, Lovable): builders ship their own UI colours, so the import takes the builder's colour for the owner's. Each adapter should be able to say "ignore this CSS" or "the theme colours are here".
5. **Read the look from the rendered page** when the page was rendered in headless Chrome (Bolt, Lovable).
6. **shadcn / Tailwind v4 colour tokens** (`--primary: 222 47% 11%`, `oklch()`): the colour reader only reads hex and rgb (Lovable, v0, Bolt, and every AI-builder site).
7. **Generic single-page-app and framework page data** (Bolt, Lovable, v0, Sanity, Sitecore, Replit, Cursor): expand `__NEXT_DATA__`, the RSC payload, SvelteKit/Nuxt data and streamed Suspense boundaries before reading.
8. **Hidden and interactive parts**: closed accordions and tabs (Radix renders them empty), `[hidden]` / `aria-hidden` elements, icon-only buttons (carousel arrows), phone-only drawers.
9. **`#section` links on one-page sites** should point at the section's page (Bolt, v0, Carrd).
10. **Smaller ones**: `srcset` addresses containing commas (Wix CDN); strip tracking parameters (`utm_*`, `_hs*`, `fbclid`); a search box is not a form; the same phone written two ways counted once; a `<br>` inside `<address>`; catalogue pages read after content pages.
11. **Products into Business Information** (BigCommerce, Shopify, WooCommerce, Magento): product names, descriptions and prices are all readable. Prices stay off the site, but could become products. The Magento session built this beyond its brief; it needs your decision and review.

## What can't be done, on any platform

- **Content behind a login**: members' pages, B2B "log in to see prices", password-protected previews.
- **Personalised content** (Sitecore, HubSpot smart content): we see the default version only.
- **Cart, checkout, accounts, wishlists, stock levels, product option pickers**: hosted sites run no scripts and sell through Stripe only.
- **Third-party script widgets** (chat, booking, review widgets, cookie tools): hosted sites run no scripts.
- **Words that exist only inside JavaScript bundles** and never appear in the page or its data.
- **Motion** (interactions, sliders, Lottie): becomes still content.
- **Form submissions and automations** stay on the old platform; our contact form replaces theirs.
- **Exact visual order on grid/absolute layouts** (Wix Studio, Tilda Zero Block) can differ from the HTML order.
