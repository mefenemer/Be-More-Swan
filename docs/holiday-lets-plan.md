# Holiday lets — Plan (stays on the Website Assistant)

Owner request 2026-11-09: the Website Assistant should host sites for businesses that rent out
holiday lets, and take the guest's booking end to end. It widens the "one booking engine for every
kind of business" idea: appointments, consultations, tables, classes, and now **stays**.

Companion to [booking-plan.md](./booking-plan.md) and [website-types-plan.md](./website-types-plan.md)
(§3 already lists "Holiday lets, B&Bs — multi-night stays" as a gap; this plan closes it). Nothing
is built yet.

## 1. What a holiday-let owner needs, against what we have

✅ reuse as it is · ⚠️ reuse with changes · ❌ new

| Need | Today | |
|---|---|---|
| A page per property: photos, sleeps / bedrooms / bathrooms, amenities, house rules, location | gallery, text, faq sections; listings give "a page per entry" | ⚠️ new `stays` section + `/stays/<slug>` page |
| An availability calendar the guest can read | none: `/_book` shows time slots for one day | ❌ month grid drawn on the server (no JS, `?month=` links) |
| Book a date range: check-in, check-out, number of guests | bookings are `starts_at`/`ends_at` slots | ❌ new kind `stay` |
| Nightly prices, seasons, weekend rates, minimum nights, changeover days | one price per product | ❌ rates in Business Information |
| Cleaning fee, pet fee, extra-guest fee, weekly discount | none | ❌ fixed lines on the quote |
| No double bookings | advisory lock + recompute in `createBooking` | ✅ same lock, a nights check |
| Sync with Airbnb, Booking.com, Vrbo | iCal in (`ical-busy.ts` + safe-fetch every 15 min), private iCal feed out | ⚠️ one feed in **per channel per property**, one feed out per property |
| Take a deposit now, the rest before arrival | deposits via Stripe Connect, held 35 min, refunds | ⚠️ add a balance step; **currency** (deposits are £ only today) |
| Instant book or "request to book" | `mode` instant / request | ✅ per property |
| Guest emails: confirmation, balance due, arrival details, checkout reminder | confirmation + day-before reminder + .ics | ⚠️ timed by check-in, not by start time |
| Door code / Wi-Fi sent only a few days before arrival | none | ❌ "Arrival details" held back until N days before |
| Review request after the stay | review requests (`send-review-requests.ts`) | ✅ triggered by check-out |
| Cancel / change link for the guest | signed manage link | ⚠️ cancellation policy by days-before-arrival (full / part / no refund) |
| Licence or registration number shown (Scotland short-term let licence, Greek AMA number, etc.) | none | ❌ one field per property, printed on its page |
| Search engines understand it | JSON-LD on every page | ⚠️ `VacationRental` / `LodgingBusiness` JSON-LD with the property's facts |
| Several languages (tourist areas, e.g. Syros) | none | ❌ separate phase; see website-types-plan §6.7 |

## 2. Principles (the same lines as bookings)

1. **Facts live in Business Information.** A property, its rates and its rules live in a new
   Business Information ▸ **Stays** tab, shown when the business offers stays. The site points at
   properties by id; it never copies names or prices. (Same rule as products and prices.)
2. **One booking table.** A stay is a row in `bookings` with `kind = 'stay'`, so the Bookings tab,
   notifications, the owner's calendar feed, the Outlook calendar, Results ▸ Brought In, the manage
   link and review requests all work without a parallel system.
3. **Dates, not times.** A stay is check-in DATE → check-out DATE (nights) in the property's
   timezone. `starts_at` / `ends_at` are still filled in (check-in time on arrival day → check-out
   time on departure day) so the existing readers keep working, but availability is worked out on
   the dates.
4. **No JavaScript on the site.** The calendar is a month grid of plain links; the steps are GET
   pages until the last one: dates → guests → quote → your details → pay.
5. **The price is always worked out again on the server** at the moment of booking (like slot times
   today). The shown quote is never trusted.
6. **The AI never sets a price** and never invents a property fact (beds, amenities, rules). The chat
   proposes cards; the owner's click saves through the same checks as the Stays tab.
7. **We are honest about channel sync.** iCal is the only route open to us (the Airbnb and
   Booking.com APIs are for approved partners). Airbnb reads an iCal feed only every few hours, so a
   double booking across channels is possible in that gap. We say so on the Stays tab, read their
   feeds every 15 minutes, and flag any overlap the moment we see it.

## 3. Data (one SQL file, both DBs before deploy)

> **As built (2026-11-09, phase 1 foundation):** `db/z-stays.sql` differs from the sketch below in
> three ways. (1) Stay types have their **own table `stay_types`**, not `bookable_resources`: every
> appointment reader treats a non-table resource as staff, so a cottage there would be offered as a
> hairdresser. Bookings point at it with `bookings.stay_type_id`. (2) The per-property settings
> (deposit, balance, damage deposit, cancellation, rules) are **columns on `stay_types`**, with no
> separate `stay_settings` table. (3) Single use is a **`single_discount`** off each night, so it
> follows the seasons. Owner blocks are in `stay_blocks`. Channels (`stay_channels`, and a
> `unit_id` on `calendar_busy`) come with phase 2 in their own SQL file.
> Built so far: `stay-quote.ts` (price, payment plan, refunds), `stay-availability.ts` (free rooms,
> room assignment), `stay-clean.ts` (what the owner may save), `stays.ts` (load/save, `createStay`
> under the bookings lock, `publicStay` without arrival details), `tests/stays.test.ts`. Appointment
> slots now ignore stay bookings (`takenOn`).
> **Site pages built (2026-11-09):** the `stays` section (feature `stays`, `/stays` reserved), each
> stay's page at `/stays/<slug>` with a two-month calendar and search data (`site-stays.ts` pure,
> `site-stays-load.ts` reads, HTML in `site-render.ts`), the booking steps at `/_book?stay=` (dates →
> price, payment plan, rules, details → POST; `site-stay-booking.ts`), Stripe Checkout in the stay's
> currency with the card saved only for automatic balance (`stay-charges.ts`; rides the deposit hold and
> webhook, which now confirms by the stay's own instant/request setting), the guest's manage link with a
> refund by the cancellation policy, emails that say dates and nights, live site + preview routes,
> sitemap. Tests: `tests/site-stays.test.ts`.
> **Stays tab built (2026-11-09):** Business Information ▸ Stays (`src/components/stays-editor.js`,
> `netlify/functions/stays.ts`): list, add a holiday let or a room type, one editor saved whole
> (details, rooms, photos, amenities, prices and seasons, extra charges, deposit / balance collection /
> damage deposit, cancellation steps, rules, private arrival details), archive / delete (refused while
> guests are booked), closed dates. Offer kind `stays` (7th tick; old six-tick answers stay complete,
> `asked:6` still read — nobody is re-asked — and stays is added for them only when they have one set up).
> The website editor offers the Stays section. Tests: `tests/stays-tab.test.ts`.
> **Balance and damage deposit built (2026-11-09):** `stay-jobs.ts`, run hourly inside
> `send-booking-reminders.ts`: on the due date (confirmed stays only) the saved card is charged
> off-session, or the guest is emailed a link to `/_book?pay=` (a page; Stripe opens only on its POST);
> a failed card falls back to the link and tells the owner; guest reminded after 3 days, owner told
> after 6; nothing is cancelled automatically. The damage deposit: owner reminded the day before it
> goes back, returned in full on its date unless the owner chose "Return now" or "Keep part" (amount +
> reason, emailed to the guest; only once the stay has begun) on the Bookings tab. Refunds now work
> across both payments (`refundPlan`: balance payment first, then deposit; damage deposit off the
> payment that took it); the owner declining/cancelling refunds everything; the day-before "see you
> tomorrow" reminder leaves stays out. Tests: `tests/stay-jobs.test.ts`. Due dates use the UTC date.
> **Chat cards built (2026-11-09):** the Website Assistant sees the stays and the stays booked
> (`stays-prompt.ts` — never the arrival details, only whether they're set) and proposes `stay_setup`
> (new, or a change naming only what changes — `PUT { partial: true }` lays it over what's saved, so a
> saved door code survives), `stay_block` and `stay_damage` (return / keep part). Each click uses the same
> server action as the Stays tab or the Bookings tab. Prices are folded into `stay_setup` (no separate
> stay_rates card). Tests: `tests/stays-chat.test.ts`.
> **Arrival email built (2026-11-09):** `sendArrivalDetails` in `stay-jobs.ts` (hourly, after the balance
> step): confirmed stays, `arrival_details_days` before check-in — times, address, room(s), house rules and
> the owner's arrival details word for word. Held back while a balance is unpaid (the owner's "still unpaid"
> email says so). Marked with `bookings.reminder_sent_at` (stays never use it otherwise) — no new SQL.
> ✅ `db/z-stays.sql` applied to staging and prod by the owner 2026-11-09.
> **Not built yet:** and checking the remaining
> `bookings` readers for `kind = 'stay'` (review requests, calendar feed, Outlook, Mentor morning summary).

`db/z-stays.sql`:

**Two shapes, one model (B&B rooms are in phase 1, decided 2026-11-09).** What the guest books is a
**stay type**, and the actual room or house is a **unit**:
- *Whole property* (a cottage, a flat): stay type `whole`, exactly one unit, created for it
  automatically. The owner never sees the word "unit".
- *Rooms* (a B&B, a guest house, an inn): stay type `room` = a room type ("Double with sea view"),
  with one or more named units ("Room 3", "Room 5"). The guest books the room type; a free unit is
  given to them under the lock. **One unit for the whole stay**, so a guest never moves room halfway
  through. The owner can move a booking to another unit of the same type if it's free.

- **`bookable_resources.kind`** gains `'property'`. A stay type is a resource: `capacity` = most
  guests per unit. `stay_type` (`whole` | `room`), and for rooms `single_nightly` (a lower price for
  one guest, optional) and `breakfast` (`none` | `included` | `optional`; an optional breakfast is a
  `stay_fees` row priced per guest per night). New columns (all nullable, only used by properties): `slug`, `summary`, `description`,
  `bedrooms`, `bathrooms`, `beds` (text, e.g. "1 king, 2 singles"), `amenities` (closed list, JSONB),
  `house_rules`, `address`, `licence_number`, `image_asset_ids` (JSONB, alt text required),
  `check_in_time`, `check_out_time`, `mode` (instant / request, overrides the business's),
  `arrival_details` (door code, Wi-Fi, directions: **never shown on the site**, emailed only).
- **`stay_rates`** (one row per property, per season): `resource_id`, `name` ("Summer"),
  `starts_on`, `ends_on` (NULL = the base rate), `nightly`, `weekend_nightly` (Fri + Sat nights),
  `weekly_nightly` (7+ nights), `min_nights`, `changeover_days` (which weekdays check-in may
  fall on, NULL = any), `currency`. Amounts in minor units.
- **`stay_fees`** per property: `kind` (cleaning | pet | extra_guest | other), `label`, `amount`,
  `per` (stay | night | guest_night), `after_guests` (extra_guest only).
- **`stay_settings`** per property: `deposit_percent` (0 = pay in full), `balance_days` (balance due
  N days before arrival; inside that, pay in full at booking), `balance_collection` (`auto` = charge
  the saved card on the due date | `link` = email the guest a pay link; owner's choice, default
  `link`), `damage_deposit` (minor units, NULL = none), `damage_deposit_return_days` (default 7),
  `cancellation` (days-before → %
  refund, e.g. `[{days:28,refund:100},{days:14,refund:50}]`), `arrival_details_days` (when the
  arrival email goes), `max_advance_days`, `min_notice_days`, `gap_nights` (turnover nights blocked
  after each stay).
- **`stay_units`**: `resource_id`, `name`, `status` (active | archived), `sort_order`. A whole
  property's single unit carries the property's name.
- **`stay_channels`** per **unit** (Airbnb and Booking.com sync one calendar per listing or room,
  so a B&B with two "Double" rooms has a feed for each): `name` (Airbnb / Booking.com / Vrbo /
  other), iCal address **in the vault**, `last_read_at`, `last_error`. Busy dates go to
  `calendar_busy` with the `unit_id`.
- **`booking_units`**: `booking_id`, `unit_id`, `check_in`, `check_out`. Availability reads this
  table, never `bookings` alone. A whole-property stay has one row. A B&B booking for a family can
  take **several rooms of one type** in one booking and one payment (one row per room). Mixing room
  types in one booking comes later.
- **`bookings`** gains `check_in DATE`, `check_out DATE`, `guests`, `rooms`, `quote JSONB` (the lines as
  charged), `currency`, `balance_pence`, `balance_status`, `balance_due_on`. Status and payment
  columns are reused. Also `balance_collection` (copied from the property when booked) and
  `stripe_customer_id` / `payment_method_id` (only for `auto`, on the owner's connected account).
  Damage deposit: `damage_deposit_pence`, `damage_deposit_status` (none | due | held | returned |
  part_kept | refund_failed), `damage_deposit_kept_pence`, `damage_deposit_kept_reason`,
  `damage_deposit_return_on`.

## 4. On the site

- Section **`stays`**: cards for chosen properties (photo, name, sleeps, "from £X a night" worked
  out from the rates, button).
- Page per property **`/stays/<slug>`**: photos, facts, amenities, rules, licence number, map link,
  the calendar (two months, `?month=` to move), and a "Check availability" form (check-in, check-out,
  guests). JSON-LD `VacationRental`.
- For a B&B, the page is the **business**, listing each room type with its photos, beds, breakfast
  and "from" price, and **one search for all of them** (dates + guests + rooms) that shows which room
  types are free and the price for each. JSON-LD `BedAndBreakfast` with a `HotelRoom` per type. A
  room type's calendar shows a night as free while at least one of its rooms is free.
- **`/_book?stay=<id>&in=…&out=…&guests=…&rooms=…`**: shows the quote line by line (nights × rate, fees,
  total, what is due today, when the rest is due, the cancellation terms), then the guest's details
  and acceptance of the house rules, then Stripe Checkout on the owner's connected account.
- **`/stays/<slug>.ics?unit=…`**: each unit's export feed for Airbnb and the rest to import (dates
  only, no guest details). Signed token in the URL, reset-able.
- Sitemap lists each property page.

## 5. Money

- **Deposit now, balance later.** Booked more than `balance_days` ahead, the deposit is charged at
  Checkout. Booked closer, the guest pays in full. **How the balance is collected is the owner's
  choice, per property** (`balance_collection`, set on the Stays tab or by chat card):
  - **Charge automatically**: Checkout saves the card on the owner's Stripe account
    (`setup_future_usage: off_session`) and the quote tells the guest it will be charged on the due
    date. An hourly job charges it then. If the card fails, the guest is emailed a pay link and the
    owner is told.
  - **Send a pay link** (default): no card is saved. On the due date the guest is emailed a Checkout
    link, with a reminder 3 days later. The owner is told if it's still unpaid after that.
  - The guest sees which method applies before paying, on the quote and in the confirmation. Changing
    the setting only affects new bookings; an existing booking keeps the method the guest agreed to
    (stored on the booking as `balance_collection`).
- **Currency** per property (GBP / EUR / USD / AUD / CAD, as products since 2026-11-07). This also
  lifts the "deposits are £ only" limit for stays.
- **Cancellation** by the guest through the manage link refunds the % their policy gives for that
  many days before arrival; the owner can always refund more.
- **No platform fee** (same as shop and deposits; D5 = 0%).
- **Damage / security deposit (phase 1, decided 2026-11-09)**: optional per property
  (`damage_deposit` amount, none by default). A card hold only lasts about 7 days on Stripe, which is
  too short for most stays, so it is a **real, refundable charge**:
  - Charged with the balance, or at booking when the guest pays in full. It is a separate line on
    the quote that says it is refundable and when.
  - After check-out the Bookings tab asks the owner to **Return in full** or **Keep part**. Keeping
    part needs an amount and a written reason, which is emailed to the guest. The rest is refunded
    on the owner's Stripe account.
  - If the owner does nothing, it is **returned in full automatically** `damage_deposit_return_days`
    after check-out (default 7). The owner is reminded the day before. A guest's money is never kept
    because nobody decided.
  - If the guest cancels or the owner declines or cancels, it is refunded in full along with the
    rest.
  - Chat: the same Return / Keep part card. Keeping money is always the owner's click, never the
    model's decision.

## 6. Owner side

- Business Information ▸ **Stays** tab: properties, rates, fees, rules, channels (with "last read"
  and errors), arrival details.
- Website tab ▸ Bookings: a **stays calendar** (one row per property or room, dates across) with our
  bookings, channel bookings and blocked dates; "Block dates" on one room or a whole stay type for
  owner use or maintenance; "Move to room…" within a room type; confirm / decline requests. A
  **Today** view for B&Bs: who arrives, who leaves, breakfasts tomorrow.
- Notifications as for bookings (`site_booking_received`), plus "overlap with Airbnb" as needs-you.
- Chat (every capability GUI **and** chat): `stays_setup` (from the owner's own answers: never
  invented facts), `stay_rates` (season and price changes, owner's numbers only), `stay_block`,
  and the existing booking decisions card handles requests. Snapshot: occupancy for the next 60
  days and the empty gaps.
- Business Information "What does your business offer?" gains a 7th kind, **stays**. The saved
  answer's sentinel moves `asked:6` → `asked:7`, so existing answers are re-asked once.

## 7. Phases

1. **Properties, B&B rooms + direct bookings.** Stays tab (whole properties and room types with
   their rooms), `stays` section, property and B&B pages, calendar, the rooms search, `/_book` stay
   steps, room assignment under the lock, quote engine (pure function + tests), pay in full or deposit via Checkout, request /
   instant, emails, manage link with the cancellation policy, chat setup card, optional damage
   deposit (charge, Return / Keep part, automatic return).
2. **Channel sync.** iCal in per channel per room (15 min), feed out per room or property, overlap alert, the stays
   calendar.
3. **Balance + guest journey.** Saved card + automatic balance charge, arrival-details email N days
   before, checkout reminder, review request after check-out.
4. **Grow the bookings.** The Social Assistant sees the empty gaps and drafts "last-minute nights"
   posts; the Email Assistant can send them to past guests who agreed to marketing; the Mentor reports
   occupancy and direct-vs-channel share. (This is where the "omnibooking" story pays off: one engine,
   every assistant reads it.)
5. **Later.** Several room types in one booking, children's prices, discount codes, several languages, guest registration records if the owner
   wants them (UK hotel-records rule for overseas guests).

## 8. Decisions for the owner

1. ~~**Balance payment**~~: **decided 2026-11-09: the owner chooses, per property** (charge
   automatically or send a pay link). See §5.
2. ~~**Damage deposit in phase 1**~~: **decided 2026-11-09: yes**, optional per property, as a
   refundable charge with automatic return. See §5.
3. ~~**Phase 1 scope**~~: **decided 2026-11-09: B&B rooms are in phase 1**: room types with named
   rooms, single-guest price, breakfast included or optional, several rooms of one type per booking.
   See §3 and §4.
4. **A first customer to build against?** A real property's rates and rules would keep the quote
   engine honest.
5. **Public claims**: pricing / help / `/connections` copy should say "Airbnb, Booking.com, Vrbo
   calendar sync (iCal)" only once phase 2 is live, never "integration".
