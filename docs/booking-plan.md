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
3. Two-way Google / Outlook calendar sync (busy times block slots; bookings appear in the diary).
4. Optional deposits through Stripe Connect (the shop's connected account, no platform fee).
5. Classes / events (sessions with fixed times and a capacity).

## Escape hatch

A business that already uses Calendly, Acuity or OpenTable links to it with a button (a `cta`
section). Embedding a third-party widget is not offered: it would put another company's script on
every hosted site, which the sites' Content-Security-Policy forbids by design.
