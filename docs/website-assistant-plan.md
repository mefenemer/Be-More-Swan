# Website Assistant — Plan

Added 2026-10-14, from an external proposal ("Website Design Assistant") reviewed against the code
as built. Status: **step 1 built 2026-10-14** — `src/utils/site-definition.ts` (definition, the one
`normaliseSiteDefinition` gate, typed operations), `src/utils/site-render.ts` (HTML pages, sitemap,
robots, JSON-LD; no JavaScript in the output), `tests/site-builder.test.ts`. Sections so far: hero,
features, steps, text, FAQ, testimonials, call to action. **Step 2 (without hosting) built
2026-10-14**: role `website_assistant` (inserted Hidden by `db/z-website-assistant.sql`, which also
adds `sites` and the `website_pages` plan feature: 5 / 15 / 50, off the pricing table until go-live),
API `sites.ts` (get / apply / draft), AI whole-site draft (`site-draft.ts`, `site-store.ts`,
`draft-site-background.ts`; 1 task; never invents facts — `[placeholders]` instead), signed-in preview
`site-preview.ts` (CSP forbids scripts), the Website tab editor (`assistant-site-editor.js`), chat
route + `site_changes` / `site_draft_request` cards, goal metric `site_pages_ready`, notification
`site_draft_ready`. Credit link ON by default (owner, 2026-10-14). Not yet: hosting/publish (needs
the free-subdomain domain), forms, commerce — step 3. Step 3's publish must refuse pages with
`[placeholders]` (`placeholdersIn`). Builds after
[mystery-shopper-plan.md](./mystery-shopper-plan.md).

---

## 1. Requirements (from the user)

1. The user chats; the assistant builds the site, asks for approval, makes requested changes,
   publishes, hosts and applies SEO.
2. It sources, generates or uses the user's own media and content; suggests pages, navigation and
   structure; optimises for marketing; builds the sitemap; serves HTTPS.
3. Contact forms, newsletter sign-up, Stripe checkout and a product library — "no need for Shopify
   or Squarespace".
4. More complex components considered, but capped.
5. GUI and chat parity.

## 2. Verdict on the proposal

- **Disruptive?** Yes, in one specific way: the site is *maintained by an assistant that already
  knows the business* (products, brand kit, blog, audience, campaigns). That is the moat — not the
  first build, which every AI builder now does.
- **£29/month?** Plausible for service businesses. The risk is not willingness to pay, it is cost:
  hosting + bandwidth + chat edits are open-ended. Edits must spend tasks (they already would, via
  chat) and hosting needs a page/bandwidth ceiling per tier.
- **Feasible?** Yes **if** the model edits a structured site definition rendered by our own
  components, and **no** if the model writes free HTML. Commerce must stop at Stripe-hosted checkout.

## 3. What already exists — reuse, do not rebuild

| Needed | Already built ✅ | Where |
|---|---|---|
| Brand colours/font/logo | Brand kit + website extraction | `brand-kit.ts`, `brand-extract.ts` |
| Images (stock, AI, branded) | Brand Designer + Pexels + fal + brand cards; asset library | `content_assets`, docs/brand-designer-plan.md |
| Contact / newsletter forms | Form Builder: one definition, one renderer, hosted + embed | `audience_forms`, `subscribe.js` (`BmsForm.render`) |
| Contacts → email | Audience + Email Marketing sequences | `audience-*.ts`, newsletter_editor |
| Blog on the site | Blog widget + RSS + SEO metadata | `widget-api.ts`, `widget-rss.ts`, blog SEO |
| Product library | `org_products` (product/service, price, url) | `src/utils/org-products.ts` |
| Host-routed site on its own domain | The Swan Index: a function answers every path on another domain | `swan-index-page.ts`, `netlify.toml` §Swan Index |
| Safe server-side rendering of user text | `inlineJson`, escape helpers, tokens-only styles | Form Builder renderer |
| Audit of the result | Mystery Shopper scores any URL — including ours | docs/mystery-shopper-plan.md |

Not built: Stripe **Connect** (no connected-account code exists), customer custom domains at scale,
a page/section renderer, a site editor.

## 4. Where the proposal is changed — and why

1. **Vanilla server-rendered sections, not React/Tailwind components.** The app is vanilla IIFE
   (memory `frontend-is-vanilla-not-react`). Published sites are static HTML + one small CSS file
   generated from the brand kit — fastest possible pages, nothing to hydrate, nothing to break.
2. **The model edits a `site_definition` JSON through typed operations** (`add_section`,
   `update_section`, `reorder`, `add_page`, `set_nav`, `set_theme`), each validated by one
   `normaliseSiteDefinition()` gate (the Form Builder pattern). The model never emits HTML.
3. **Custom domains:** Netlify domain aliases (how the Swan Index works) don't scale to thousands
   of customer domains. Decision D2: Cloudflare for SaaS custom hostnames in front of the render
   function, or Netlify for the first ~50 sites while proving demand.
4. **"Replace Shopify" is not claimed.** Commerce = up to N products from `org_products` → Stripe
   **hosted** Checkout on the customer's own Stripe account (Connect Standard). No inventory sync,
   variants matrix, shipping calculators or refunds UI. Copy says "sell simple products and
   services", not "replace Shopify".
5. **Custom interactive widgets are out of v1.** A sandboxed code slot is a security surface
   (arbitrary JS on a domain we serve). Revisit after launch with a fixed widget catalogue
   (calculator, quiz, comparison) rather than generated code.
6. **We become a host → abuse controls are part of v1, not later.** Sites on our infrastructure can
   impersonate banks or collect card numbers. Needed at launch: moderation on publish (reuse
   `moderation.ts`, but it must fail **closed** here, unlike chat), no free-form password/card
   fields (forms only allow Form Builder field types; payments only via Stripe Checkout), an abuse
   report link in every footer, an admin takedown switch, ToS + AUP update.
7. **Approval before publish, always.** Drafts live at a private preview URL; publish is the user's
   click. Chat proposes the publish card; it never publishes (same rule as campaigns).

## 5. The design

### 5.1 Site definition (`sites.definition` jsonb)

`theme` (from brand kit: colours, font, radius, logo) · `nav` · `pages[{slug, title, seo{title,
description, ogImage}, sections[{id, type, props}]}]` · `footer` · `settings{analytics, favicon}`.

Section catalogue v1 (~15): hero (3 layouts), features grid, steps, services/products list, pricing
table, testimonials, logos, FAQ (emits FAQPage JSON-LD), CTA band, contact form (Form Builder ref),
newsletter bar (Form Builder ref), blog feed (widget), gallery, text, team. Each section type has a
props schema, a renderer, and SEO hooks.

### 5.2 Rendering & serving

- `render-site.ts` (pure) → HTML per page + `sitemap.xml` + `robots.txt` + Organization /
  LocalBusiness JSON-LD. Snapshot published output to R2 per version (instant rollback).
- `site-page.ts` answers by **Host header**: `<slug>.<sites-domain>` (decision D3) and verified
  custom domains. Draft preview at a signed, noindex URL.
- Lighthouse-style guardrails in tests: one H1 per page, alt text required, contrast checked
  against brand kit (reuse `contrastRatio`).

### 5.3 Build flow

1. **Start from what exists:** "Import my current site" — fetch via `site-extract.ts` (shared with
   Mystery Shopper) → propose pages/sections/copy from it. Or start from a short interview.
2. Assistant proposes sitemap + nav → user approves → it drafts all pages → preview (desktop/mobile
   toggle beside the chat) → change requests → publish.
3. After publish: the Mystery Shopper scores the live site; its fixes become **apply-able
   operations** on the definition (one click, then re-score).

### 5.4 Commerce (phase 4)

Stripe Connect Standard onboarding → `buy` button / small cart → Checkout Session on the connected
account → webhook records the order and notifies. Stripe Tax optional. Our platform fee: decision D5.

### 5.5 GUI and chat parity

Every operation in §4.2 is a button in the editor (section panel, page list, nav, theme) **and** a
chat proposal card hitting the same `sites.ts ?action=` path. Publish, domain connect and Stripe
connect are click-only.

## 6. Data model (SQL before code)

`sites` (org, assistant, slug, status draft|published|suspended, definition, published_version,
custom_domain, domain_status) · `site_versions` (site, version, definition, r2_key, published_at,
published_by) · `site_domains` (hostname, verification, cert state). Form submissions reuse
`audience_*`; orders (phase 4) get `site_orders`.

## 7. Build order

1. Definition + `normaliseSiteDefinition` + 6 core sections + renderer + tests.
2. Draft preview + editor GUI + chat operations; hosting on the sites subdomain.
3. Publish/versions/rollback, sitemap/robots/JSON-LD, forms + newsletter + blog feed, abuse
   controls, **products + Stripe Connect checkout** (D4: in the first release).
   - **3a built 2026-10-14:** publish / take offline / versions (newest 20) / copy a version into the
     draft; addresses on `bemoreswan.site` (src/utils/site-hosting.ts — reserved + phishing words);
     publish refuses `[placeholders]` and runs the safety check on every visible word; served by the
     separate `sites-host/` Netlify project → `site-serve.ts` (shared SITE_SERVE_SECRET, published
     version only, no scripts); "Report this site" → report-site.html → site-reports.ts; Admin ▸
     Trust ▸ Hosted Sites (admin-sites.ts) suspends. SQL: db/z-website-hosting.sql. No CDN cache yet
     (every view is one function call) — add tag-purged caching when traffic warrants.
   - **3b built 2026-10-15:** `contact` and `signup` sections, script-free HTML posting to the site's
     own `/_form` (sites-host forwards POST + visitor IP → site-serve → src/utils/site-forms.ts).
     Enquiries → `site_enquiries` + owner notification (`site_enquiry_received`) + email to the
     ACCOUNT's address; never the Audience. Sign-ups → audience-public subscribe in-process, which
     now also accepts the workspace's own published site as an origin. Enquiries tab on the Website
     tab; both in the data export. SQL: db/z-website-forms.sql.
   - **3c built 2026-10-15:** `products` section (owner-typed prices in pence; the AI draft drops it;
     JSON-LD Product/Offer). Orders tab: "Connect Stripe" → Standard account + Stripe onboarding
     (owner/admin). Buy → `/_buy` → Checkout Session ON the connected account, price read from the
     published site, GBP, qty 1–10, optional UK delivery address, **no application fee (D5 = 0%)**.
     Orders recorded by `stripe-connect-webhook.ts` (own secret STRIPE_CONNECT_WEBHOOK_SECRET),
     unique per session; owner notified (`site_order_received`) and emailed. SQL: db/z-website-shop.sql.
   - **Owner's words & pictures, built 2026-10-15:** (1) "Choose picture" (src/components/media-picker.js)
     on every picture and the logo — library pictures (`assetId`) drawn through the signed permanent
     link emails use; ownership checked on every save (site-store.ts verifySiteAssets). (2) "Add your
     own words" (site-words.ts): text / Word / PDF → numbered blocks → the model returns only a
     block-to-section PLAN → sections are built from the owner's blocks, so the wording is theirs by
     construction; nothing dropped, nothing truncated; a proposal until Apply; 1 task. (3) Chat
     attachments (chat-attachments.ts, chat_attachments table): paperclip / drag / paste for the
     Website Assistant; pictures used by assetId in site_changes, words only via a `site_words` card
     (attached document, or a quote verified against the owner's own messages).
   - **Products mastered in Business Information, 2026-10-15:** org_products gets structured prices
     (db/z-product-pricing.sql, src/utils/product-price.ts: fixed | from | on_request | text, amount in
     pence, unit), duration (for bookings) and a picture. `price` = the displayed wording, derived on
     save, so every prompt is unchanged. The site's products section holds only `productIds`; page,
     JSON-LD and checkout read Business Information (site-shop.ts loadSiteProducts). Only a fixed
     price is buyable; Buy re-checks name AND price at the click. Old typed-in items: shown, never
     sold, "Move them into Business Information" (sites.ts products_import).
4. Custom domains (D2). Mystery Shopper → one-click fixes.
5. (moved into 3)
6. Import-my-site, remaining sections, widget catalogue (post-launch).

Phases 1–3 = a sellable "website managed by your assistant" on a Swan subdomain.

## 8. Decisions

Decided 2026-10-14 (the user):

- **D3. ✅ Free subdomain on a dedicated, newly bought domain.** Must be a separate domain, not
  `*.bemoreswan.com` — customer content must never share cookies or reputation with the app (a
  phishing site on a subdomain of ours can get the whole domain blocklisted).
- **D4. ✅ Commerce in the first release.** Build order changes: products + Stripe Connect Standard
  checkout move into phase 3. Before code: enable Connect on our Stripe platform account and
  complete Stripe's platform profile. With Standard accounts the customer is the merchant of record
  (their refunds, disputes, VAT) — we never hold their money.

- **D1. ✅ Included at £29 with a 5-page cap**; higher tiers get more (numbers to set in Plan
  Features when the role is built — never hard-coded, memory `plan-features-db-driven`).

Still open:

- **D2.** Custom domains. Netlify adds each customer domain as an alias on one site, and a site
  takes roughly 90 aliases (hard limit, per Netlify staff; ours already carries
  aura-assist.com + theswanindex.com + www variants), plus a cap of 20 certificate requests per
  domain per week. Workarounds (more Netlify sites) work, but get messy beyond a few hundred.
  Cloudflare for SaaS: 100 custom hostnames free, then $0.10/hostname/month, up to 50,000. On its
  non-Enterprise plans customers point `www` at us; the bare domain redirects to `www` at their
  registrar. Recommendation: build behind one `site-domains.ts` interface, launch on Netlify
  aliases (first ~50 custom domains), switch to Cloudflare when 40 are in use — the free subdomain
  covers everyone else.
- **D5. ✅ 0% (decided 2026-10-15).** Platform fee — a percentage Be More Swan takes from each sale, on top of Stripe's own
  fee (a Connect "application fee"). Recommendation: **0%** at launch and say so — "no
  transaction fees" is a sharper line against Shopify and Squarespace than the revenue would be.
  Can be added later for new sites only.

## 9. Selling it — what can and cannot be claimed

Can: "chat to build it, approve it, it's live", "your assistant keeps it up to date", "forms,
newsletter and blog built in", "sell simple products with Stripe".
Cannot: "replace Shopify", "unlimited custom features", "guaranteed rankings".
