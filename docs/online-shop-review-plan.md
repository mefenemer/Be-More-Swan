# Online shop — REVIEW + PLAN (feature request #35)

2026-11-15. **Nothing built.** For the owner to review and decide (§8).

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
  customers), VAT line on our buyer email; Stripe Tax only if the owner wants EU/abroad selling later.*
- **Privacy:** the buyer's name, email and address are the business's data; our DPA covers us as processor. Add the
  shop to the site's privacy wording; marketing only with the unticked box.
- **Payments ready ≠ shop ready:** refuse to publish a Buy button until the Delivery & returns page and trader
  address are filled in (like publish already refuses `[placeholders]`).

Product basics: basket (several items, one checkout), product pages (own address, several pictures, for Google and
for sharing in posts), options with their own price and stock, delivery rates (flat, free over £X, collection), order
statuses (posted with tracking link, refunded via Stripe's `charge.refunded`), discount codes (Stripe promotion codes).

## 6. Phased build

**Phase 0 — make what we have legal and complete (small).**
- `shop_settings` per workspace: trader address, returns window and exceptions, who pays returns, VAT number, delivery
  text. GUI in Website ▸ Shop; chat card `shop_settings` (same `sites.ts` action).
- Generated "Delivery & returns" page; link under Buy buttons; Stripe Checkout `consent_collection.terms_of_service`.
- Buyer confirmation email from us (order, total, trader details, returns summary, cancellation form link).
- Publish refuses Buy buttons without the settings. Webhook adds `charge.refunded` → status `refunded`.

**Phase 1 — a real shop.**
- `org_products`: `stock` (null = not tracked), `low_stock_at`, `weight_band`; `product_options` table (name, price
  difference, stock). Additive SQL on both DBs before the code.
- Product pages at `/shop/<slug>` drawn from Business Information; products section links to them; >12 products
  through a "Shop" page with groups (reuse the `menu` grouping).
- Server-side basket (`site_baskets`, 24-hour id in the URL, no scripts) → one Checkout Session with several lines.
- Delivery: up to 5 rates (Stripe `shipping_options`), free-over threshold, "collect in person".
- Stock decremented on the webhook; "Sold out" at 0; overselling guard when the session is created.
- Orders: statuses new → posted (tracking link, email to buyer) → done / refunded; CSV export.
- Chat parity for all of it: Website Assistant cards `products_add`, `product_stock`, `order_update`.

**Phase 2 — the assistants run the shop (the disruptive part).** §4 items 1–7: photo-to-product, low-stock and
back-in-stock drafts, buyers to Audience with consent, abandoned checkout email, Mentor shop suggestions, thank-you
flow and review request.

**Phase 3 (optional).** Digital downloads (we have private asset links from lead magnets), gift cards, selling to
the EU/US (Stripe Tax), Google Merchant Center feed, Instagram/Facebook Shop catalogue from the same products.

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

## 8. Decisions for the owner

1. **Scope:** aim at micro sellers (up to ~200 products, mostly UK) rather than Shopify's full range? *Recommended.*
2. **Phase 0 now:** build the legal pieces and buyer email before any new shop marketing? *Recommended — they are
   gaps in what we already claim.*
3. **Public copy until Phase 1 is live:** keep "a shop with checkout on your own Stripe account", or soften to "sell
   products with Buy buttons"? (Rule: never claim what the system doesn't do.)
4. **Fee:** confirm 0% on sales stays, including any future bigger shop plan.
5. **Which plans get the shop**, and whether shop AI work (photo-to-product, back-in-stock drafts) costs normal tasks.
6. **Delivery abroad:** UK only for Phase 1, or EU too (needs VAT/IOSS thinking and Stripe Tax)?
7. **Abandoned checkout email:** include it (consent box only), or leave it out to keep things simple?
8. **Where the shop lives in the app:** inside the Website Assistant (today), or a separate "Shopkeeper" role in the
   catalogue that shares the same products and orders?
