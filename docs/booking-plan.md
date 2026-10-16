# Bookings — Plan

Owner request 2026-10-15: a booking widget for the Website Assistant, flexible enough for
restaurants, hairdressers, consultants and more, configured through the website chat.

## Principles

1. **Business data lives in Business Information, not in the widget.**
   - Services = Products & Services with a length (`org_products.duration_minutes`).
   - Opening hours, closed days and booking rules = Business Information ▸ Opening hours & bookings
     (`booking_settings`, one row per workspace).
   - Who or what is booked = `bookable_resources` (staff, tables / seating areas with capacity, rooms).
   Configuring bookings once therefore also powers future widgets (an "Open now" badge, a menu).
2. **One component, three kinds** (`booking` section, `kind`): appointment (a service with a length,
   optionally a choice of staff), consultation (the same, worded for calls), table (party size;
   capacity in seats). Classes / events are a later kind.
3. **No JavaScript on customer sites.** Every step is its own page at `/_book` with plain links and
   GET forms: what (or how many) → who (only when offered) → day → time → details. Only the last
   step POSTs. `src/utils/site-booking.ts`.
4. **No double bookings.** `bookings.ts createBooking` takes a per-workspace advisory lock inside a
   transaction and recomputes availability with the same pure function that drew the times
   (`booking-availability.ts`). A pending request holds its time as firmly as a confirmed booking.
5. **Time zones are the business's.** Hours are wall-clock times in its timezone; bookings are stored
   as instants. `booking-time.ts` converts across clock changes with `Intl` only.
6. **The owner decides.** Mode `request` (default): the owner confirms or declines on the Website tab
   ▸ Bookings; mode `instant`: confirmed at once. Either way the owner gets a notification
   (`site_booking_received`) and an email; the customer gets an email, with a calendar invite (.ics)
   once confirmed. A booking is not AI work: it uses no tasks.
7. **Chat proposes, the owner clicks.** The Website Assistant asks at most three questions (kind;
   hours and services; instant or request) and emits a `booking_setup` card. The click saves through
   the same checks as Business Information (`booking-settings.ts`) and can add the section.

## Phases

1. ✅ (built 2026-10-15) Data, availability engine, `/_book` steps, Bookings tab, emails + .ics,
   chat setup card, Business Information tab. SQL: `db/z-bookings.sql`.
2. ✅ (built 2026-10-15) Customer self-service: a signed link (`booking-links.ts`, HMAC of the id)
   in the request, confirmation and reminder emails opens `/_book?manage=…` to cancel (asks first)
   or choose a new time. A move releases the old time and books the new one in ONE locked
   transaction, undone if the new time has gone. Allowed until the business's notice period; after
   that, "get in touch". The owner is told (`site_booking_changed`). Day-before reminder: hourly
   `send-booking-reminders.ts`, confirmed bookings made more than a day ahead, claimed before
   sending. SQL: `db/z-bookings-changes.sql`.
3. ✅ (built 2026-10-15) The owner's calendar, with NO sign-in (owner's choice — no Google
   verification): OUT, a private subscribe link (`/api/bookings/calendar.ics?t=<32-hex token>`,
   reset-able) with bookings and class dates, who and how to reach them (Google refreshes it every
   few hours); IN, the calendar's private iCal address — for the business (blocks appointments for
   everyone) or a person (blocks only them) — read every 15 minutes through the SSRF fence, start
   and end only (`calendar_busy`); free / cancelled / our own events ignored; tables and classes
   never blocked. The address is a secret: vault only. SQL: `db/z-calendar-sync.sql`
   (`ical-busy.ts`, `calendar-sync.ts`, `booking-calendar-feed.ts`). Live sign-in sync (Google /
   Microsoft APIs) can come later as a faster upgrade.
4. ✅ (built 2026-10-15) Deposits through Stripe Connect (the shop's connected account, no platform
   fee). Per product: a fixed £ or a % of its fixed price (per place for a class); tables never.
   The booking is made 'awaiting_payment', holding its time / places for 35 minutes while they pay
   on Stripe Checkout (closes at 31); the Connect webhook makes it pending / confirmed and only then
   announces it. Unpaid holds stop counting at hold_expires_at and are tidied hourly. Refunded in
   full when the customer cancels online (only possible before the notice cut-off), the owner
   declines or cancels, or a class date is cancelled; a move keeps the deposit. A payment that
   arrives after its hold went is refunded at once. SQL: `db/z-booking-deposits.sql`
   (`booking-deposits.ts`).
5. ✅ (built 2026-10-15) Classes and events. A booking section of kind `class` shows dated SESSIONS
   (`class_sessions`: a Business Information product = the class, a date and time in the business's
   timezone, an optional teacher / room, a number of places; a weekly class = sessions sharing a
   `series_key`). A place is an ordinary booking (kind `class`, `session_id`, party_size = places),
   re-counted under the same per-workspace lock, so emails, the cancel link, reminders and review
   requests all work unchanged; a class place is not "moved" — they cancel and book another date.
   Full → `class_waitlist`; when places free up (customer cancel, owner decline / cancel), the earliest
   people whose places fit are emailed a link to book (first come, first served — nothing held).
   The owner adds and cancels dates on the Website tab ▸ Bookings ▸ Timetable (cancelling emails
   everyone booked), or the chat proposes them with a `class_sessions` card. Opening hours don't limit
   classes; notice and "how far ahead" do. SQL: `db/z-classes.sql`.

## Opening hours & contact section (built 2026-10-15)

The `hours` section shows an Open-now badge, the week, closed days in the next three weeks, the visit
address and Call / WhatsApp / Email / Get directions buttons. It holds no facts: hours and the visit
address + WhatsApp (`booking_settings.visit_address`, `.whatsapp`; SQL `db/z-business-location.sql`)
come from Business Information ▸ Hours, location & bookings; phone and email from the site's business
details. The home page's search data gains `openingHoursSpecification` and the street address.
`src/utils/business-hours.ts`, tests/business-hours.test.ts.

## Escape hatch

A business that already uses Calendly, Acuity or OpenTable links to it with a button (a `cta`
section). Embedding a third-party widget is not offered: it would put another company's script on
every hosted site, which the sites' Content-Security-Policy forbids by design.
