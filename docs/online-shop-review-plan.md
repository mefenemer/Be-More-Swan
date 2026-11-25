# Online shop — REVIEW + PLAN (feature request #35)

2026-11-15. **Nothing built.** Owner decisions taken 2026-11-15 (§8): micro sellers, Phase 0 first, 0% fee,
**UK first, EU and US in later phases**, abandoned checkout email in, and a **separate Shopkeeper Assistant** on every plan (§9, §10). Nothing left open.

The ask: *"Our website assistant offers an online shop. Review it and suggest how it can be improved so that it is
better than the competition e.g. shopify, simple to maintain for the user, is a disruptive technology. Thoughts?"*

---

## 1. Short answer

- **Today we have Buy buttons, not a shop.** The money side is good and honest: each business connects its own
  Stripe Standard account, checkout runs on Stripe, we take no cut, orders are recorded from the webhook and the owner
  is told. But a visitor can buy **one product line per checkout**: no basket, no product pages, no options (size,
  colour), no stock, no delivery charge, UK delivery only, and **we send the buyer nothing** after they pay.
- **We already claim "a shop"** on public pages (`website-builder-for-small-business.html`,
  `be-more-swan-vs-website-builders.html`, `db/assistant-showcases.json`). That is defensible for a few items sold one
  at a time, but not against Shopify, and some legal basics (§5) are missing. Close those first.
- **Don't try to out-Shopify Shopify on features.** Shopify has 50,000 products, apps for everything and its own AI
  (Sidekick, and a chat store builder, "Canvas", reported in October 2026). Our angle is the one thing they can't
  copy cheaply: **the shop is run by the same team of assistants that already writes the business's posts, emails
  and website** — one place, one bill, no app store, no fee on sales. "A shopkeeper you talk to", aimed at the
  micro business selling 5–200 things, not at the brand selling 5,000.
- **Recommendation:** Phase 0 (legal + buyer emails) now, Phase 1 (basket, product pages, options, stock, delivery)
  next, then Phase 2 (the assistants run the shop). Only then change the public copy to compare us with Shopify.

## 2. What we have today (checked in code, 2026-11-15)

| Area | State | Where |
| --- | --- | --- |
| Products, one list for the whole workspace | **Works.** Business Information ▸ Products & Services; structured price (fixed / from / on request / own words), currency GBP/USD/EUR/AUD/CAD, picture, dietary markers. Up to 200 | `org_products` (`db/z-org-products.sql`, `z-product-pricing.sql`, `z-product-price-currency.sql`); `src/utils/org-products.ts`, `product-price.ts` |
| Products section on a site | **Works.** Picks up to 12 products by id; names and prices are read live, never copied into the site | `site-definition.ts` (`ProductsProps`), `site-render.ts` |
| Product schema for Google | **Works.** `Product` / `Offer` JSON-LD on the page | `site-render.ts` |
| Stripe Connect | **Works.** Standard account per workspace, onboarding link, flags synced, "payments ready" notice. GB accounts only | `src/utils/site-shop.ts` (`connectOnboardingLink`, `syncConnectAccount`); `sites.ts` `payments_connect` / `payments_refresh` |
| Checkout | **Partial.** One product, quantity 1–10, hosted Stripe Checkout, price re-checked at the click, rate-limited. No basket, no discount codes, no delivery charge, address collection UK only | `site-shop.ts` `checkoutParams`, `startCheckout`; `site-serve.ts` `/_buy` |
| Orders | **Works (basic).** Webhook records a paid order once; owner gets a bell notice and an email; Orders page and Website tab with "Mark as done"; in data export and morning summary | `stripe-connect-webhook.ts`, `recordPaidCheckout`, `markOrderDone`; `orders.html` / `orders.js`; `sites.ts` `orders` |
| Order statuses | **Partial.** Only `paid` / `done`. No dispatched, refunded, cancelled; refunds made in Stripe are not seen | `site_orders` CHECK in `db/z-website-shop.sql` |
| Email to the buyer | **Missing.** Only the Stripe success page; Stripe's own receipt only if the business switched it on in their dashboard | — |
| Product pages, options/variants, stock | **Missing.** No `stock`, `sku`, `weight` or variant fields on `org_products` | `db/schema.ts` `orgProducts` |
| Delivery | **Missing.** No rates, no free-over threshold, no collection option, no international | `SHIPPING_COUNTRIES = ['GB']` |
| VAT | **Missing.** Price charged as entered; no Stripe Tax; no VAT shown on a receipt | (plan doc §5.4 says "Stripe Tax optional") |
| Shop legal pages | **Missing.** No returns / delivery / terms page or trader details at checkout | — |
| Digital products, gift cards, subscriptions | **Missing** | — |
| Import from Shopify / WooCommerce | **Works.** Reads the old shop's public feed into an opt-in product list | `src/utils/site-shop-feeds.ts`; chat card `site_import_products` |
| Products by chat | **Partial.** The Mentor chat can add / change / remove products (`mentor_products*` cards, `mentor-cards.ts`); the **Website Assistant's** own chat can only import them. No order cards in any chat | `chat-capabilities.generated.ts` |
| Buyers into Audience | **Missing.** Buyer email stays on the order; not offered to the Email Marketing Assistant | — |

Constraint worth knowing: hosted sites are served **with no scripts** (`site-serve.ts`), so a basket must be
server-side (form posts and a short-lived basket id), not a JavaScript cart. That suits us: fast, private, no cookies
banner.

## 3. The competition (micro business, UK, Nov 2026)

Figures from public pricing pages and UK reviews; several conflict, so confirm before quoting any publicly.

| | Monthly | Fee per online sale (UK card) | Good at | Where small sellers complain |
| --- | --- | --- | --- | --- |
| **Shopify Basic** | £19 yearly / £25 monthly | ~2% + 25p (Shopify Payments); +2% if another provider | Everything; Sidekick AI; huge app store | Apps add £50+/month, themes extra, setup takes days, fee if you avoid Shopify Payments |
| Shopify Starter | ~£5 | ~5% reported | Links and social buy buttons | No real website |
| **Squarespace** | Basic ~£12–16; Core ~£17 | Basic 2% (+7% digital); higher plans 0%, plus card fee | Looks | Weak stock and delivery tools; fees on cheapest plan |
| **Wix Core** | ~£16 yearly | ~2.1% + 20p (Wix Payments) | All-in-one | Upsell maze, slow editor, apps |
| **Square Online** | £0 (paid plans ~£20 / £64) | 1.4% + 25p | Free, ties to card reader | Plain designs, limited marketing |
| **Big Cartel** | Free (5 items) / ~$15 / ~$30 | Card fee only | Very simple, makers | Product caps, few features |
| **Etsy** | £0 | 6.5% + 4% + 20p + 0.48% + 16p a listing | Buyers already there | Fees, Offsite Ads 12–15%, not your own customers |
| **Stripe Payment Links** | £0 | 1.5% + 20p (premium cards 1.9%) | Instant | Not a shop at all |
| **Be More Swan today** | Website Assistant inside the plan (plan prices from master data, `plan-prices.js`) | **Stripe's card fee only; 0% to us** | No fee, own Stripe, site + marketing in one | Buy buttons only (§2) |

The common complaints we can answer: **fees that grow with sales**, **app sprawl**, **days of setup**, **a separate
tool for posts, emails and reviews**. Shopify's AI helps you *operate the admin*; it doesn't post to your Instagram,
write your email flow or answer enquiries.

## 4. Where we can genuinely beat them

Each item uses something we already run; none needs a third-party app.

1. **Add a product from a photo.** Send a picture in the Website Assistant chat (it already `acceptsAttachments`);
   the assistant drafts name, description, picture crop and suggested delivery size, **never the price** (rule since
   2026-10-15: AI never sets prices). The owner types the price and ticks "add". Same server path as Business
   Information ▸ Products' Save (GUI = chat).
2. **"Ask your shop."** "How many candles did I sell in October?", "Who hasn't had their order yet?", "Mark Jo's
   order as posted" — order cards in chat, the same actions as the Orders page buttons.
3. **Stock that talks.** When stock falls to the owner's level: a bell notice and a chat bubble ("3 left of the
   lavender candle — reorder, or hide it at 0?"). At 0 the site shows "Sold out" by itself.
4. **Back in stock → a post and an email, drafted for approval.** The Social Assistant drafts a post and the Email
   Marketing Assistant an email to people who asked to be told (a "Tell me when it's back" box using the existing
   sign-up path). Nothing goes out without approval, as today.
5. **Buyers become an audience (with consent).** A checkbox at checkout ("Send me news from …", unticked) puts the buyer
   into Audience; a "First order thank-you" email flow and a review request (we have `send-review-requests.ts`) follow.
6. **Abandoned checkout reminder.** Stripe can collect marketing consent and tells us when a checkout expires; one
   reminder email, only to buyers who ticked consent (PECR). Built on Email Marketing, not a new app.
7. **The Mentor watches the shop.** Morning summary already counts orders; add "best seller this week", "this item
   hasn't sold in 60 days", "your delivery price is above the average for your sector" as Suggestions.
8. **Moving from Shopify in minutes.** We already read Shopify / WooCommerce feeds; extend to options and stock, so
   "give us your Shopify address" brings the whole catalogue across.
9. **No fee on sales, ever, and no app store.** Flat plan price; the money goes straight to the business's own
   Stripe. Simple to explain, and true today.

**The disruptive line (only once Phases 0–2 are live):** *"Your shop, run by your team. Add a product with a photo,
and your assistants post it, email it and tell you when it's running low. No apps, no cut of your sales."*

## 5. Gaps to close before claiming "better than Shopify"

Legal (UK; we are the platform, the business is the trader and merchant of record — as `site-shop.ts` already says):
- **Consumer Contracts Regulations 2013:** before payment the buyer must see the trader's name, geographic address and
  contact details, total price **including delivery**, delivery arrangements, and the **14-day right to cancel** (with
  the model cancellation form, and who pays return postage). After payment, a **durable confirmation** (an email)
  repeating it. Today we show none of this. *Fix: a generated "Delivery & returns" page per shop from a short form
  (with exceptions such as personalised or perishable goods), linked under every Buy button and in Stripe Checkout's
  terms consent; a buyer confirmation email from us.*
- **Consumer Rights Act 2015:** faulty goods — refund within 30 days. Covered by the same page's wording.
- **DMCC Act 2024 (drip pricing, from April 2025):** delivery and unavoidable charges shown with the price, not added
  late. Show "+ delivery from £3.50" beside prices once delivery exists.
- **VAT:** a VAT-registered business must show VAT-inclusive prices to consumers and give a VAT receipt on request.
  *Fix: "I'm VAT registered" + number in Business Information (we already store `vat_number` for billing, not for
  customers), VAT line on our buyer email. Selling to the EU and US comes in Phase 3 — see §9.*
- **Privacy:** the buyer's name, email and address are the business's data; our DPA covers us as processor. Add the
  shop to the site's privacy wording; marketing only with the unticked box.
- **Payments ready ≠ shop ready:** refuse to publish a Buy button until the Delivery & returns page and trader
  address are filled in (like publish already refuses `[placeholders]`).

Product basics: basket (several items, one checkout), product pages (own address, several pictures, for Google and
for sharing in posts), options with their own price and stock, delivery rates (flat, free over £X, collection), order
statuses (posted with tracking link, refunded via Stripe's `charge.refunded`), discount codes (Stripe promotion codes).

## 6. Phased build

**Phase 0 — make what we have legal and complete (small).**
*Status 2026-11-15: the legal pieces below are LIVE (PR #624). The Shopkeeper shell (§10) is built, HIDDEN in the catalogue: its Shop tab (`assistant-shop.js` → `netlify/functions/shop.ts`) has Stripe, the Delivery & returns form and the workspace's orders, and its chat reads the shop and offers the same `shop_settings` card. The Website Assistant's Orders tab keeps the same form until the Shopkeeper goes live; both save through the same rows. Before launch: `db/z-shopkeeper.sql` on both DBs, then Admin ▸ Assistants go-live checks.*
- `shop_settings` per workspace: trader address, returns window and exceptions, who pays returns, VAT number, delivery
  text. GUI in the **Shopkeeper**'s Settings (§10); chat card `shop_settings` (same server action).
- Generated "Delivery & returns" page; link under Buy buttons; Stripe Checkout `consent_collection.terms_of_service`.
- Buyer confirmation email from us (order, total, trader details, returns summary, cancellation form link).
- Publish refuses Buy buttons without the settings. Webhook adds `charge.refunded` → status `refunded`.

**Phase 1 — a real shop.**
- `org_products`: `stock` (null = not tracked), `low_stock_at`, `weight_band`; `product_options` table (name, price
  difference, stock). Additive SQL on both DBs before the code.
- Product pages at `/shop/<slug>` drawn from Business Information; products section links to them; >12 products
  through a "Shop" page with groups (reuse the `menu` grouping).
- Server-side basket (`site_baskets`, 24-hour id in the URL, no scripts) → one Checkout Session with several lines.
- Delivery: **UK only.** Up to 5 rates by `weight_band` (Stripe `shipping_options`), free-over threshold, "collect
  in person". Store rates under a `zone` (only `uk` for now) so EU/US can be added in Phase 3 without a reshape (§9).
- Stock decremented on the webhook; "Sold out" at 0; overselling guard when the session is created.
- Orders: statuses new → posted (tracking link, email to buyer) → done / refunded; CSV export.
- Chat parity for all of it: **Shopkeeper** cards `products_add`, `product_stock`, `order_update`, `shop_settings` (§10).
- **Shop without a website** (owner 2026-11-15, last item of Phase 1): a business with no Be More Swan site gets one
  plain branded shop page — the same product pages, basket and checkout, drawn by the same renderer (no second
  template). It carries its own Delivery & returns page, trader details and privacy wording; its address uses the
  existing hosted-site domain path (our subdomain or own domain). Product links work in posts and an Instagram bio.
  If the business later adds the Website Assistant, the shop page becomes the site's Shop page — nothing moves.

**Phase 2 — the assistants run the shop (the disruptive part).** §4 items 1–7: photo-to-product, low-stock and
back-in-stock drafts, buyers to Audience with consent, abandoned checkout email, Mentor shop suggestions, thank-you
flow and review request.

**Phase 3 — UK sellers delivering to the EU and US** (§9): delivery zones, import-charges notices, IOSS + Stripe Tax,
GPSR responsible person, EU/US versions of the returns page and buyer email.

**Phase 4 — businesses based in the EU and US** open their own shops: Stripe Connect beyond GB, per-country
consumer-law and tax wording, non-UK legal review. Needs its own plan first.

**Later (optional).** Digital downloads (we have private asset links from lead magnets), gift cards, Google
Merchant Center feed, Instagram/Facebook Shop catalogue from the same products.

### Phase 1 progress (built in slices, one PR each)

1. **Stock — built 2026-11-25** (`feat/shop-stock`). `org_products.stock` / `low_stock_at` (db/z-shop-stock.sql,
   additive, kept out of `db/schema.ts` so code before the SQL still works). `src/utils/shop-stock.ts`. Empty = not
   tracked (as before); 0 = "Sold out" on the site and checkout refuses; a buyer can't pick more than are left; stock is
   taken once when the order is recorded as paid, stops at 0, and the owner's order email says what is left or that it
   was oversold. Shopkeeper Shop tab ▸ **Stock** card and chat card `product_stock` → one action (`shop.ts
   product_stock`), any member (like Business Information ▸ Products). Tests: `tests/shop-stock.test.ts`.
   *Not in this slice:* low-stock / back-in-stock drafts (Phase 2), stock per option (with options).
2. **Product pages — built 2026-11-25** (PR #868): `/shop/<id>-<name>` (`site-product-page.ts`, `renderSiteProduct`),
   only while a products section offers the product; old names 301; in the sitemap; Stripe Cancel returns there.
3. **Options — built 2026-11-25** (`feat/shop-options`): `product_options` (db/z-shop-options.sql, raw SQL in
   `shop-options.ts`; mirrored in schema.ts only for the data export). One group per product; each option its own
   price (or the product's) and stock. A product with options is bought by option only: its card says "Choose
   size" and links to its page, where each option has its own Buy button. Checkout charges the option's price,
   names the order "Product — Option" and takes the option's stock. Shop tab Options editor + chat card
   `product_options` → `shop.ts product_options`. Tests: `tests/shop-options.test.ts`.
4. **Basket — built 2026-11-25** (`feat/shop-basket`): Shopkeeper workspaces only (decision 5). Carried in the address as
   `?b=<id>` (the sites host passes no cookies and allows posts only to /_form, /_buy, /_book), so every action posts to
   `/_buy` with `_a` = add / set / remove / checkout. `site_baskets` + `site_order_lines` (db/z-shop-basket.sql, raw SQL in
   `shop-basket.ts`). Every line priced again from Business Information; one Stripe Checkout for the lot; the snapshot of
   what was charged is kept per Stripe session; the paid order gets its lines, each line's stock is taken, the basket is
   emptied; both emails list the items. A page carrying `?b=` keeps it in links and is never shared-cached; /basket is
   never cached or indexed. Week-old baskets swept daily. Tests: `tests/shop-basket.test.ts`.
5. **UK delivery rates — built 2026-11-25** (`feat/shop-delivery`): basket checkouts (Shopkeeper workspaces). Up to 5
   choices buyers pick on Stripe's page: the business's own rates, each optionally free over an order total, plus
   "Collect in person". **Flat per order in this first version — no weight bands yet** (add `weight_band` per product
   later if sellers ask). Stored as `shop_settings.delivery = { zones: { uk: … } }` so EU/US zones add without a
   reshape (Phase 3); the paid order records `delivery_name` / `delivery_amount` (db/z-shop-delivery.sql, raw SQL in
   `shop-delivery.ts`). Shown on the basket page and the Delivery & returns page before paying. Shop tab Delivery card +
   chat card `delivery_rates` → `shop.ts delivery_rates` (owner/admin). Tests: `tests/shop-delivery.test.ts`.
6. Order statuses (posted + tracking email), CSV export.
7. Shop page for a business with no Be More Swan website.

## 7. Costs and fees model

- **Keep 0% on sales.** It is true, already public, and the clearest difference from Shopify Starter, Squarespace
  Basic and Etsy. Stripe's fee (from 1.5% + 20p) is the business's only per-sale cost.
- Cost to us is small: one function call per basket/checkout, webhooks, a few emails. AI work (photo-to-product, posts,
  emails) is **background work and spends tasks** as today (`getTaskCosts()`), so heavy shops pay through tasks, not
  a sales cut.
- Option to decide: a per-plan product cap on the shop (e.g. 25 / 200) — but the "no website page limit" decision
  suggests no cap; Business Information's 200 is the natural ceiling for now.
- Alternative the owner may consider: a small `application_fee_amount` (say 0.5%) only on a future "Shop Pro".
  *Recommendation: don't — "no cut, ever" is worth more as a message than the revenue at our size.*

## 8. Owner decisions (2026-11-15)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Scope | **Micro sellers**, up to ~200 products. |
| 2 | Phase 0 first | **Yes** — legal pieces and buyer email before any new shop marketing. |
| 3 | Public copy until Phase 1 is live | **Agreed** with the rule "never claim what the system doesn't do". Read as: **soften to "sell products with Buy buttons"** on `website-builder-for-small-business.html`, `be-more-swan-vs-website-builders.html` and `db/assistant-showcases.json` **now**, ahead of Phase 0 — confirmed by the owner 2026-11-15. |
| 4 | Fee | **0% on sales stays**, including any future bigger shop plan. No `application_fee_amount`, ever. |
| 5 | Plans and task costs | **The Shopkeeper is an assistant like any other** (owner 2026-11-15): on **The Workflow Saver** it can be the one assistant (shop-only sellers get the hosted shop page); **included from The Busywork Buster up**. Website Assistant–only customers **keep today's Buy buttons** (one product per checkout) — nothing is taken away; basket, stock, delivery and order handling need the Shopkeeper. **No product cap per plan** (Business Information's 200 is the ceiling). 0% on sales on every plan. Shop AI work (photo-to-product, back-in-stock drafts, abandoned checkout emails) **spends normal tasks** via `getTaskCosts()`. Trade-off accepted: website + full shop on The Workflow Saver needs two assistants, so The Busywork Buster. |
| 6 | Delivery abroad | **UK only for Phases 0–2.** EU and US come later: UK sellers delivering to the EU/US in Phase 3, EU/US-based sellers in Phase 4. See §9. |
| 7 | Abandoned checkout email | **Include it** — only to buyers who ticked the consent box (PECR / ePrivacy; CAN-SPAM for US). Phase 2. |
| 8 | Where the shop lives | **A separate Shopkeeper Assistant** in the catalogue, sharing the same products and orders. See §10. **Works without a website too**: a plain hosted shop page, end of Phase 1. |

## 9. Selling to the EU and US (decision 6) — Phase 3, then Phase 4

**Not in Phases 0–2.** This section is the groundwork for **Phase 3**: a **UK-based seller** (Stripe Connect stays
GB accounts) **shipping to buyers** in the EU and US. EU/US-*based* sellers are **Phase 4**, with their own plan.
The only Phase 1 hook: delivery rates are stored under a zone so Phase 3 adds zones rather than reshaping data.

**What changes for a UK seller shipping abroad** (confirm every point with an adviser before public copy):

| | EU buyers | US buyers |
| --- | --- | --- |
| Tax at import | No VAT threshold since 2021. Parcels ≤ €150: either the seller registers for **IOSS** and charges EU VAT at checkout (buyer pays nothing on delivery), or the buyer pays VAT + a carrier handling fee on delivery. Over €150: customs duty and VAT on import, usually paid by the buyer | The $800 "de minimis" exemption was suspended for all countries from 29 Aug 2025 — **every parcel can attract duty**, collected by the carrier unless sent duty-paid |
| Sales tax | (covered by VAT above) | State sales tax only once a seller passes a state's economic-nexus threshold (typically $100k or 200 orders a year in that state) — unlikely for micro sellers; show a note, don't calculate in Phase 3 |
| Consumer law | Selling *to* EU consumers means their country's protections apply: 14-day withdrawal (same as UK), **2-year legal guarantee** | No federal cooling-off for online sales; keep the seller's own returns policy |
| Product rules | **GPSR (from Dec 2024):** consumer products sold into the EU need an **EU-based "responsible person"** and manufacturer/safety details shown on the product page. Some countries also require packaging registration (e.g. Germany's LUCID) | Generally none for typical micro-seller goods; some categories (cosmetics, children's products, food) have their own rules |
| Price shown | VAT-inclusive if IOSS; otherwise a clear "import VAT and fees may be due on delivery" notice **before payment** | "Import duties may be due on delivery" notice before payment |
| Currency | EUR (already a product currency); Stripe Adaptive Pricing can show local currency | USD (already a product currency) |

**How we build it (Phase 3):**
- Delivery **zones**: UK, EU, US (rest of world later). Each zone has its own rates by `weight_band`, free-over
  threshold and on/off switch. `SHIPPING_COUNTRIES` becomes the union of the zones the seller switched on.
- Per-zone **import notice** shown beside the price and on the Checkout page (`custom_text`) — never added late
  (same drip-pricing rule as UK).
- Shop settings gain: **IOSS number** (optional), **EU responsible person** (name + address, required before EU
  delivery can be switched on for physical goods), and a "my products are covered by special rules" tick that hides
  EU/US for those products.
- **Stripe Tax** on the seller's own Standard account, used **only** when they enter an IOSS number (EU VAT at
  checkout). Stripe charges the seller for it, not us — say so in the switch's help text.
- Delivery & returns page and buyer email get an EU version (2-year guarantee wording, model withdrawal form) and a
  US version (seller's returns policy, duties note), chosen by the delivery country.
- Product pages show the GPSR fields (manufacturer, responsible person, safety warnings) when EU delivery is on.
- Exceptions to keep simple: no Northern Ireland special case in Phase 3 (NI addresses are treated as UK), no
  automatic duty calculation (DDP) — we disclose, the carrier collects.

## 10. Shopkeeper Assistant (decision 8)

A new role in the catalogue, **sharing** `org_products`, `site_orders` and the Stripe Connect account — no copies.

| Owns (Shopkeeper) | Stays with |
| --- | --- |
| Shop settings, Delivery & returns, delivery zones, IOSS / responsible person | — |
| Products: stock, options, low-stock level, photo-to-product | Business Information ▸ Products stays the shared list (same server path) |
| Orders: statuses, tracking, refunds seen, CSV export (moves from `orders.html` to the Shopkeeper's tabs; old link redirects) | Morning summary still counts orders |
| Basket, product pages, Checkout | **Website Assistant** draws the Products section, Shop page and product pages on the site; Buy buttons link to the Shopkeeper's checkout |
| Low-stock / back-in-stock alerts | **Social Assistant** drafts the post, **Email Marketing Assistant** the email (approval as today) |
| Buyers who ticked consent | **Audience** (Email Marketing) |
| Shop suggestions | **Business Mentor** shows them under Suggestions |

Rules it must follow (house conventions):
- Registered like every role: DB-driven assistant content, declared surfaces (not social-shaped by default), one
  status via admin-assistants, an **active teammate** in Team Chat with its own expertise.
- **Every capability in GUI and chat**, same server action; new chat cards added to the chat capabilities manifest
  (CI fails otherwise). Chat sees and changes its own settings.
- Public: a showcase page, sample work made in the product (not invented), and `/connections` updated only when live.
- Background work (photo-to-product, drafts, reminders) spends tasks; chatting with it is free as today.

Build order with the phases: Phase 0 can ship inside the Website Assistant's Shop tab **or** wait for the Shopkeeper
shell. *Recommendation:* build the **Shopkeeper shell in Phase 0** (settings + orders tabs, moved from Website) so the
legal pieces land in their final home and nothing is moved twice.

## 11. Still open for the owner

Nothing — all decisions taken 2026-11-15. Next step: build Phase 0 (legal pieces + Shopkeeper shell).
