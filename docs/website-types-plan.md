# Website Assistant — every kind of site a small business needs

Added 2026-11-05, from the owner's list of 22 website types (after trying Lovable), checked against
the code as built. Companion to [website-assistant-plan.md](./website-assistant-plan.md).

## 1. The line we keep

The Website Assistant builds sites from **typed sections** that our own renderer turns into pages
(`site-definition.ts` → `site-render.ts`). The model never writes HTML, CSS or code, and published
sites run **no JavaScript**. That is why they are fast, safe and can't break — and it is the
difference from Lovable, which generates an app (and so can build a Reddit clone, which then needs
a developer).

So a new kind of site is reached by adding **section types and data stores**, never by generating
code. Anything that can only be built by generating an app is out of scope.

Every capability ships GUI **and** chat (one server action; the chat proposes a card, the user's
click writes it).

## 2. The owner's list, checked (2026-11-05)

✅ in place · ⚠️ partly · ❌ to build · 🚫 out of scope (and why)

| Type | Today | What it needs |
|---|---|---|
| Corporate / brochure | ✅ | — |
| B2B service & lead generation | ✅ contact form, consultation bookings, sign-up + free PDF | A quote form with the owner's own questions (Form Builder forms are sign-ups only) |
| Lead capture / sales landing page | ✅ sign-up section, lead magnet, `hideFromMenu` pages for ads | — |
| Blog / publication | ✅ Blog Assistant at /blog | Categories / tags |
| Portfolio | ✅ gallery (pictures + own video) | A case-study layout (listings, §4) |
| Personal / CV site | ⚠️ | Timeline section (jobs, dates); "Download my CV" (a library PDF link) |
| E-commerce store | ⚠️ products from Business Information, Stripe Checkout on their own account, quantity, UK delivery address, Orders tab | **Checked 2026-11-05 — missing:** sizes/colours (variants), stock counts, shipping charges, discount codes, digital-download delivery |
| SaaS / subscription (their marketing site) | ⚠️ | Pricing-table section. Gated content → memberships (§6, Phase 4) |
| Single-event page | ⚠️ "Classes and events": dated sessions, places, waitlist. **Checked:** free places work (no payment); payment is only ever a deposit (a % up to the full price) | Ticket types (Early bird / Standard / VIP, each with a price and limit), countdown, programme section, "Add to calendar" |
| Festival / multi-day event | ❌ | The above + programme across days and venues, speakers/performers (listings), a map |
| Event directory / calendar | ❌ | **Listings (Phase 1)** |
| Business / property directory | ❌ | **Listings** with other fields |
| Non-profit / campaign | ⚠️ | Donations (one-off + monthly, their Stripe), volunteer form, target bar, charity number, Gift Aid wording |
| Affiliate / review site | ❌ | Comparison table, product cards with `rel="sponsored"` links, compulsory "we earn from links" notice (ASA/CMA) |
| Knowledge base / help docs | ⚠️ pages + FAQ | Grouped articles with contents; search done on the server (no JS) |
| Media hub (video / podcast) | ⚠️ own videos | Podcast episodes (audio plays — CSP `media-src https:`). **Checked:** YouTube/Vimeo embeds are blocked (CSP `default-src 'none'`, no `frame-src`) — allowing them is a privacy decision (cookies → consent banner) |
| Online courses (LMS) | ❌ later | Logins, lessons, progress, payment — after memberships |
| Intranet / client portal | ❌ later | Logins, locked pages, file sharing — memberships |
| Online marketplace | 🚫 | Paying other sellers, seller identity checks (KYC), disputes, liability for their goods |
| Auction site | 🚫 | Live bidding needs JavaScript; legal and fraud exposure |
| Social network / forum | 🚫 | User-to-user service → Online Safety Act 2023 duties (risk assessments, moderation, reporting) |
| Web apps / online utilities | 🚫 except one | Needs generated code. Exception: a typed **calculator** section (quote / price estimator) |
| Wiki | 🚫 | Public shared editing = the forum problem. A knowledge base covers the useful part |

## 3. Gaps in the list (common small-business sites)

- Restaurants, cafés, takeaways — menu, hours, table booking ✅; **order ahead / click & collect** ❌
- Holiday lets, B&Bs — **multi-night stays with an availability calendar** ❌ (bookings are time slots)
- Gyms, clubs, studios — timetable ✅; **memberships** ❌
- Trades & local services — ✅ (plus the quote form above)
- **Sites in more than one language** ❌ — needed anywhere tourists are (e.g. Syros)
- Link-in-bio, coming soon — ✅ a short page with a sign-up section

## 4. Phase 1 — Listings (an events directory, and every other "list of things")

The single most reusable piece: a store of entries the owner (and, if they choose, the public) adds
to, shown on the site as a filterable list with a page per entry. One engine covers event
directories and calendars, business and property directories, team / people, job vacancies, case
studies and podcast episodes.

### 4.1 Data — `db/z-site-listings.sql` (apply to BOTH DBs before deploy)

`site_listings`, per workspace (like `org_reviews`):
`kind` (`event` | `entry`), `title`, `slug` (unique per workspace), `category`, `summary`, `body`,
`starts_on` DATE, `start_time` / `end_time` TEXT `HH:MM`, `ends_on` DATE (events; dates and times are
stored as the owner typed them — no timezone shifting), `location`, `image_asset_id` + `image_alt`,
`link_url` + `link_label`, `status` (`pending` | `published` | `hidden` | `declined`),
`source` (`owner` | `public`), `submitter_name`, `submitter_email` (never shown on the site),
`created_by`, timestamps.

### 4.2 On the site

- Section **`listings`**: heading, intro, which kind, which categories, upcoming only or all,
  how many, and an optional "Post your event" button. Category filter = plain links
  (`?category=`), drawn on the server. Past events drop off by themselves.
- A page per entry at **`/listings/<slug>`**, with `Event` JSON-LD for events (search engines show
  dates), "Add to calendar" (an `.ics` download), and the link button.
- Sitemap includes every published entry.

### 4.3 Posting by the public (optional, per section)

A form page at **`/_post`** posts to `/_form` (`_k=listing`). Entries arrive **pending**; the owner
is emailed and approves or declines on the Listings tab or in chat. **Approval is compulsory** —
going live instantly (as Lovable does) makes the site a user-to-user service under the Online
Safety Act and puts spam live. Honeypot + per-IP limit like the other forms. The submitter's email
is kept for the owner only.

### 4.4 Managing them

- **Listings** tab on the Website Assistant's page (a feature: shown when the site uses listings):
  waiting for approval first, then upcoming, then the rest; add, edit, hide, approve, decline, delete.
- Chat: `listings_add` card (the owner's own entries — never invented details), and
  `listing_decisions` (approve / decline waiting entries). The chat snapshot lists them.

## 5. Phase 2 — Event pages

Ticket types on a class/event (price + limit each, paid in full by Stripe on their account),
programme section (day → time → item → venue), speakers/performers from listings (`kind` people),
countdown, add to calendar, map link.

## 6. Later phases

3. **Donations** — one-off and monthly via their Stripe, target bar, Gift Aid wording.
4. **Memberships** — visitor logins (magic link), locked pages, monthly payments; then client
   portals (files) and courses.
5. Shop gaps — variants, stock, shipping charges, discount codes, digital delivery.
6. Small sections — pricing table, timeline, comparison table, calculator, podcast, quote form.
7. Multi-night stays; order ahead; more than one language.

## 7. Done alongside (2026-11-05)

- The chat's step-by-step questions ask **"bring over your current site?" first** — naming the
  site when we already know it (set-up answer or Business Information), skipping it when they told
  us they have none — because the answer decides every question after it.
- **Full screen** button on the Website tab: the editor fills the window; "Exit full screen" (or
  Esc) goes back.
