# Business Information inside the Website Assistant — Plan

Owner request 2026-11-09: when a website needs facts the owner has to supply (a holiday let's
prices and rules, a salon's services and opening hours, a restaurant's menu), they are sent to
My Account ▸ Business Information to type them in. That is not intuitive. Whatever kind of website
they choose, they should be able to give those facts **on the Website Assistant screen or in its
chat**, and have them saved to Business Information as now.

**Phase 1 built 2026-11-09 (staging, not committed at time of writing):** `products-editor.js` and
`stays-editor.js` are mountable editors; `site-facts-drawer.js` opens them beside the Website Assistant;
the site editor's Products and Stays buttons open the drawer. Phases 2–5 not started.

## 1. Where it stands today

**The storage is right and stays.** Business Information is the one place every assistant reads
(products, prices, hours, bookings, stays). Nothing in this plan moves data or adds a second copy.

**The screens are the problem.** The site editor has about a dozen "go to Business Information ▸ …"
links (products, bookings, hours, stays, menu). Each one calls `loadView('assets')`
(`src/components/assistant-site-editor.js` ~L2756), so the owner leaves the site they're building,
lands on an account page, has to find the right tab, and then has to find their way back. Stays is
the worst case: a Stays section shows nothing until they've been somewhere else.

**The editors are fixed to that page.**

| Business Information tab | Editor today | Save endpoint |
|---|---|---|
| Products & Services | inline `<script>` in `assets.html` (~L314–900), `#op-editor` | `org-products.ts` POST / PATCH |
| Hours & Location + Bookings | one inline `<script>` in `assets.html` (~L1013–1300) | `booking-settings.ts` PUT / PATCH |
| Stays | `src/components/stays-editor.js`, but it only starts if it finds `.bizinfo-tab-panel[data-panel="stays"]` | `stays.ts` |
| Menu | no editor of its own: the site's menu section groups Business Information products | site section props + `org-products.ts` |

**Chat can save some facts but not others.** Website Assistant chat cards that write Business
Information today: `offer_profile`, `booking_setup` (opening hours + booking rules), `stay_setup`,
`stay_block`, `class_sessions`, `site_import_products` (only from an import). The prompt tells the
assistant it **cannot** add a product, give a service a length, or set a deposit, and must send the
owner to Business Information ▸ Products & Services instead (`chat-orchestrator.ts`, BOOKINGS and
CLASSES AND EVENTS paragraphs). That is the biggest gap in chat.

**The first draft leaves gaps rather than asking for them.** Before building, `chat_questions` asks
3–6 questions about the site (pages, feel, pictures), not about business facts. Missing facts are
written into the page as `[square brackets]`, and Publish refuses while any are left. Some of those
brackets are business facts (phone, address, prices, hours) that belong in Business Information,
not in the page.

## 2. Principles

1. **One store.** Every fact is saved to Business Information through the endpoint that saves it
   today. The drawer, the checklist and chat all call that same server action, with the same
   server-side checks (`stay-clean.ts`, `org-products.ts` cleaning, `booking-settings.ts`).
2. **One editor per kind of fact.** The Business Information tab and the Website Assistant drawer
   show the *same* editor component, not two copies that will drift apart.
3. **Never leave the site.** Facts the site needs are entered beside the site, and the preview
   refreshes when they're saved.
4. **Say where it went.** Every drawer and chat card says: *"Saved to your Business Information, so
   your other assistants use it too."* That tells people why it is shared, without sending them there.
5. **GUI and chat do the same things** ([[assistant-gui-chat-parity]]). Chat suggests a change on a
   card, and the owner confirms it. Chat never saves on its own, and never makes up a fact or a price.
6. **It works for every kind of website.** What's asked for comes from the sections on the site plus
   the "What does your business offer?" answer (`offer-profile.ts`), never from special code for
   holiday lets alone.

## 3. Step 1 — editors that can open anywhere

Turn each Business Information editor into a component with one entry point:

```js
window.BizInfoEditors.products.mount(rootEl, { compact: true, onSaved })
window.BizInfoEditors.hours.mount(rootEl, { ... })
window.BizInfoEditors.bookings.mount(rootEl, { ... })
window.BizInfoEditors.stays.mount(rootEl, { stayId, onSaved })
```

- Move the Products script and the Hours/Bookings script out of `assets.html` into
  `src/components/products-editor.js` and `src/components/booking-settings-editor.js`. `assets.html`
  then mounts them into its panels as it mounts Stays.
- `stays-editor.js` stops looking up its own panel. Whoever loads it calls `mount`.
- Each editor keeps its "load on first reveal" behaviour, which moves into `mount`.
- `compact: true` means one column, no page-level headings, a Save button pinned at the bottom.
  It's for the drawer.
- `onSaved(result)` lets the Website Assistant refresh the section preview and the checklist.
- The Business Information page keeps working exactly as it does now. No URLs change, so
  `window._bizinfoInitialTab` deep links and the quality reviewer's `[Edited in: …]` links
  (`FACT_LOCATIONS` / `_PRQ_FIX_LINKS`) still work.

⚠️ Source-scan tests read `assets.html` for markers ([[source-scan-tests-read-the-html]]). Moving the
scripts out will break some of them. Update each test to read the new file. Don't delete any test.
`e2e/product-currency.spec.ts` and `e2e/your-brand.spec.ts` drive this page too, so run them.

## 4. Step 2 — the drawer in the Website Assistant

- Add one right-hand drawer component (`site-facts-drawer.js`) to the Website tab. It holds one
  mounted editor at a time and closes with ✕ or Esc. On a phone it opens full screen.
- Every `data-site-open-products` / `data-site-open-bookings` / Stays / Hours link in
  `assistant-site-editor.js` opens the drawer instead of calling `loadView('assets')`. The wording
  becomes an action: "Add your first property", "Add a product", "Set your opening hours",
  "Give this service a length".
- Empty states inside a section editor show the action button, not a paragraph pointing elsewhere.
  For example, a Stays section with no stays shows "Add your first holiday let or room".
- Where a link opens a single item ("this service has no length"), the drawer opens that item.
- The docked chat pane ([[chat-pane-rollout]]) is on the right as well. While the drawer is open, it
  covers the chat pane, and the chat pane comes back when the drawer closes.
- A small "Open in Business Information" link stays in the drawer footer for people who want the
  full page.

## 5. Step 3 — "What your site needs" checklist

Add a card at the top of the **Set up** sub tab, with a short version on **Publish**. It lists the
facts this site needs, each with a tick or an "Add" button that opens the drawer.

The list is worked out on the server (`site-facts-needed.ts`, a pure function so it's easy to test)
from (a) the section kinds on the site, (b) the offer profile, and (c) what is saved:

| If the site has… | It needs | Done when |
|---|---|---|
| a Stays section, or offer `stays` | at least one stay with a name, a type and a standard nightly price; check-in and check-out times; house rules; a cancellation policy | `stays.ts` says it's bookable |
| a Bookings section (appointments) | at least one service with a length; opening hours | catalogue + `booking-settings` |
| a Bookings section (tables) | opening hours; party size limits | `booking-settings` |
| a Bookings section (classes) | a class product; at least one future session | catalogue + sessions |
| a Products section | at least one product with a fixed price; Stripe connected, to sell online | catalogue + Connect |
| a Menu section | at least one product in each group | section props + catalogue |
| a Contact / hours section, or offer `visits` | address; opening hours; phone or email | profile + `booking-settings` |
| any deposit, balance or damage deposit | Stripe connected | Connect |

- Two levels. **Needed** means the section is broken without it (a booking section with no hours,
  a Stays section with no bookable stay). **Suggested** covers things that help but aren't required
  (photos on a stay, house rules).
- Publish already refuses while `[square brackets]` are left. **Needed** items join that same list
  ("Your Stays section has no bookable stay yet — Add one"). **Suggested** items never block.
- The checklist is also given to the chat assistant as a context line, so it can offer to fill gaps
  ("Your booking section has no opening hours yet. What are they?").

## 6. Step 4 — chat can save every kind of fact

New cards, each calling the same endpoint as the drawer and confirmed by the owner:

| Card | Saves | Endpoint |
|---|---|---|
| `product_setup` | add or change a product or service: name, description, price, currency, length (for services), deposit, dietary/allergen fields (menu) | `org-products.ts` POST / PATCH |
| `business_contact` | address, phone, public email (if these aren't already covered by another card; check first) | `organisation-profile.ts` |
| `menu_groups` | group names and which products are in each group | site section props (through `site_changes` if it already covers this; check first) |

- `product_setup` follows `stay_setup`'s rule: `productId: null` for a new one, otherwise only the
  fields that change. The owner's own words and numbers only, never a made-up price.
- Remove the "you cannot, add it there" lines from the BOOKINGS and CLASSES AND EVENTS prompt
  paragraphs, and point them at `product_setup` instead.
- Each card's confirmed message says it was saved to Business Information.
- Check the known chat traps: routes drop unknown cards, and autosave overwrites chat rewrites
  ([[chat-pane-rollout]]). Card replies must not claim "done" before the save
  ([[confirm-card-replies-claim-done]]).
- The other assistants that read products (Social, Blog, Email) can get `product_setup` later. This
  plan covers the Website Assistant only.

## 7. Step 5 — the first draft asks for facts instead of leaving gaps

**Before the draft.** When the owner describes a new site (not an import), the existing
`chat_questions` card can include **one** business-facts question chosen by the checklist rules in
§5. For example: "What do you charge per night for the cottage?", "What are your opening hours?" or
"Which services do you offer, and how long is each?" The rules stay as they are: one card of
questions, never a second round, and skip anything Business Information already says.

**When the answers arrive**, the assistant proposes the draft *and*, on the same turn, the matching
`stay_setup` / `product_setup` / `booking_setup` card built from the owner's answers. The draft then
uses those facts. Nothing is saved until the owner confirms the card.

**After the draft.** Each `[square bracket]` is sorted into one of two kinds:

- **A business fact** (phone, address, opening hours, a price, a stay's details). The Pages sub tab's
  "still to fill in" list shows **Fill in**, which opens the drawer at the right editor. Once it's
  saved, the section reads the fact from Business Information and the bracket disappears. These
  facts are never typed into the page itself.
- **Prose** (`[number] customers since [year]`, a testimonial). These stay as words the owner types
  on the page, as now.

To sort them, the drafting prompt writes business-fact gaps with a fixed tag, e.g.
`[phone]`, `[address]`, `[hours]`, `[price: <product>]`, `[stay: <name>]`. `site-facts-needed.ts` maps
each tag to an editor. Free-text brackets keep their current behaviour.

**What doesn't change.** No facts are made up, prices are still never copied into page text, and
the import flow keeps its own products step (`site_import_products`).

## 8. Data and release

- **No new SQL** for steps 1–3 or step 5. Everything uses the tables and endpoints that exist.
- Step 4: `product_setup` uses `org-products.ts` as it is. If partial PATCH doesn't handle every
  field (length, deposit, currency), extend the endpoint, not the schema. Check
  `z-product-price-currency.sql` is applied ([[product-price-currency]]).
- Help articles: Products & Services, Bookings, Stays and the Website Assistant articles all say
  "go to Business Information". Update them with release SQL on both DBs
  ([[help-articles-quoting-and-renames]]).
- Public copy: no claim changes are needed. Check `/connections` and pricing don't describe the
  old steps.

## 9. Phases

| Phase | What | Why first |
|---|---|---|
| 1 | Stays and Products as `mount()` components + the drawer (§3, §4) | most of the pain; proves the approach |
| 2 | Checklist + Publish "needed" items (§5) | makes it work for every kind of website |
| 3 | `product_setup` (+ `business_contact` / `menu_groups` if needed) chat cards; prompt changes (§6) | closes the biggest chat gap |
| 4 | First draft asks for facts; tagged brackets with Fill in (§7) | depends on 2 and 3 |
| 5 | Hours/Bookings editor moved to a component and the drawer; remaining links swapped | lower traffic, largest script to move |

Each phase can be released on its own.

## 10. Decisions for the owner

1. **Where the checklist lives.** Top of Set up plus a short version on Publish (recommended), or a
   permanent strip above the preview?
2. **Should "needed" items block Publish**, or only warn? Recommended: block, as brackets do, but
   only for items that would break a section.
3. **The first-draft facts question**: always ask one when facts are missing (recommended), or only
   when the owner picks a site type that needs them (stays, bookings, menu)?
4. **`product_setup` for other assistants** (Social/Blog/Email chat) now, or later?

## 11. Tests

- `site-facts-needed.ts`: one test per row of the §5 table, plus the offer profile guessed vs answered.
- Bracket tags: the drafting prompt test checks the tags; a mapping test checks each tag opens an editor.
- Each `mount()` editor: loads only when shown; `onSaved` fires; Business Information page unchanged.
- Chat cards: shape, partial merge, refusal on missing required fields, confirm reply wording.
- Playwright: open the drawer from a Stays section, add a stay, see the preview update, and Publish's
  needed item clears.
