# Bookings — closing the top 3 Calendly gaps (PLAN)

Owner request 2026-11-08, after a Calendly comparison. Decisions made 2026-11-08 (below); nothing built yet. Builds on
`docs/booking-plan.md` (phases 1–5 built 2026-10-15/16).

## Owner decisions (2026-11-08)
1. **Google verification: GO.** The 2026-10-15 "no Google verification" choice is reversed for
   Calendar.
2. **Google Cloud project: a NEW, separate project** for Calendar (recommended, owner asked for a
   recommendation). Keeps a calendar review or rejection away from the approved YouTube project and
   the Gmail project. Cost: one more OAuth client (`GOOGLE_CALENDAR_CLIENT_ID` / `_SECRET` on both
   Netlify sites), a branding check on the new consent screen, and a separate quota.
3. **Booking link needs the Website Assistant hired**, for now. LATER (not in this plan): an AI
   booking chat that businesses embed on ANY external website (a chat-bubble script on their own
   site, which they choose to add — not on our hosted sites, whose CSP stays as it is). It should use
   the same availability engine and `createBooking` lock, and have chat propose times while the
   customer confirms. Design A's `/book` + deep links so that chat can hand off to them.
4. **"Powered by Be More Swan" on the booking page: yes, on every plan.** Alternatives later.

## Status (2026-11-08)
- **A — BUILT** on the working tree (not committed): `/book` + per-service/person links, booking-only
  address for unpublished sites, "Your booking link" card on the Bookings tab (copy, open, per-service
  links, "Book now" button snippet), link in the Website chat snapshot and in every drafting prompt
  (`loadProductsBlock`). Respects "Bookings" switched off and archived Website Assistants.
  NOT done: the QR code (no QR generator in the codebase — `/card` is a QR *target*, not a maker).
- **B step 1 — BUILT**: `meeting_location` per service, the business's / a person's video link,
  copied onto bookings, shown only once confirmed (emails, .ics LOCATION/URL, reminder, manage page),
  owner email + Bookings tab + Outlook event + subscribe feed show it, phone calls require a number,
  chat `booking_setup` card sets `meetingUrl` + `serviceLocations`. NOT done: online classes
  (`class_sessions.meeting_url`).
- Release needs, in order: `db/z-booking-meeting-links.sql` on BOTH DBs BEFORE the deploy, then
  `db/help-articles-booking-link-2026-11-08.sql` with the release.
- B step 2 (Teams) and C (Google) not started.

The three gaps, in the order to build them:

| # | Gap | Size | Blocker outside the code |
|---|-----|------|--------------------------|
| A | **Booking link** that works without a published website, with a link per service | S–M | none |
| B | **Video meeting links** on consultations (any link → Teams → Meet) | S, then M | none for the first two steps |
| C | **Google Calendar sign-in** (two-way, like Outlook) | L | Google OAuth verification (weeks) — start it first |

Do C's Google Cloud console + verification work **in week 1, alongside A**, because the review takes weeks.

---

## A. A booking link of its own

### Today
`/_book` only runs on a **published** site (`site-serve.ts:157` gives "There's no website here yet"
otherwise). The booking flow reads its choices from a `booking` section on that site
(`site-booking.ts`, the `s` query parameter is the section id). A business that wants bookings but
not our website — or that wants to put "Book now" in an email, an Instagram bio or a Lead Generator
follow-up — has nothing to share.

### Build
1. **`/book` on every site address once bookings are set up**, published or not:
   `https://<slug>.bemoreswan.site/book` (and the business's own domain, which `site_domains` already
   maps). site-serve: when the path is `/book` or `/_book` and the site is a draft or has no booking
   section, render from a definition made up on the spot — `bookingOnlyDefinition(site, org)`: one
   page holding the hours section and one `booking` section with id `book`, using the brand colours
   and name the site shell already reads. All of `site-booking.ts` then works unchanged.
   - Needs a slug. A draft site with no slug gets one offered at booking setup (the same
     `RESERVED_SITE_SLUGS` + uniqueness checks the publish step uses).
   - Which kind for the made-up section: from `booking_settings` + what Products & Services hold
     (services with a length → appointment; tables set up → table; class sessions → class). Several
     kinds → a small "What would you like to book?" first step linking to each.
   - Robots: `noindex` on the booking-only page when the site isn't published, so a half-built
     workspace doesn't show in search.
2. **Deep links like Calendly's links per meeting type.** `readChoice` already understands `svc`
   and `res`: `/book?svc=12` jumps past "what", `/book?svc=12&res=3` past "who". Each choice is
   still checked again on the server, as it is today.
3. **Where the owner gets the links (GUI + chat, same server action):**
   - Website tab ▸ Bookings: a "Your booking link" card — copy, open, QR code (reuse the `/card` QR
     page), and a copy-link button on each service and each person.
   - Business Information ▸ Products & Services: "Copy booking link" on each bookable service.
   - Chat: the Website Assistant's snapshot carries the links; a `booking_link` card shows them
     (reading only, so no confirm click is needed).
4. **Other assistants can use it.** Add the booking link to the shared prompt block every
   drafting assistant reads (the way products and the intro offer reach every assistant), so
   Social Posts, Email Flows and Lead Generator follow-ups can say "book here" with the real address,
   and never make one up when none exists.
5. **For other websites: a button, not an embed.** The site CSP has `frame-ancestors 'none'` on
   purpose, so keep it. Offer an HTML snippet of a plain styled `<a>` link to `/book`. Embedding is
   out of scope.

### Decided
- Needs the Website Assistant hired (the site row is per Website Assistant — `sites_assistant_uq`).
- "Powered by Be More Swan" shows on the booking page on every plan.

### Files
`netlify/functions/site-serve.ts`, new `src/utils/site-booking-page.ts` (the made-up definition),
`src/utils/site-booking.ts` (the "what to book" step), Website tab Bookings UI, Products & Services
UI, `chat-orchestrator.ts` (snapshot + card), the shared prompt block, help article SQL.
Tests: `tests/bookings.test.ts`, a new `tests/site-booking-page.test.ts`, the site-serve tests.

---

## B. Video meeting links

### Today
A consultation is a booking with a different label (`site-booking.ts:87`). Nothing records *how*
it happens: there's no meeting link in the emails, the .ics, the reminder or the owner's calendar event.

### Build — three steps, each usable on its own
1. **Where it happens, per service** (like Calendly's "location"). `org_products.meeting_location`:
   `in_person` (shows the visit address, as today) | `phone` (phone number required at the details
   step; "{business} will call you") | `video`. Defaults: `in_person`, except products used by a
   `consultation` section, which default to `video`.
2. **Video with any link, no sign-in (step 1, ships first).** The owner pastes a reusable meeting link
   — Zoom personal room, a fixed Google Meet link, a Teams link — for the business
   (`booking_settings.meeting_url`) or for one person (`bookable_resources.meeting_url`, which wins). https
   only, length-capped, checked with the same URL rules as other owner links.
3. **Teams through the Outlook sign-in we already have (step 2).** When `outlook_calendar` is
   connected and the source is set to "Teams", the reconciler creates the event with
   `isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness'` and reads back
   `onlineMeeting.joinUrl`. Calendars.ReadWrite already covers this, so no new scope is needed. Personal
   Microsoft accounts may not support Teams meetings: fall back to the pasted link and tell the owner
   once (notification), not on every booking.
4. **Google Meet** arrives with C (`conferenceData.createRequest`, `conferenceDataVersion=1`, read
   `hangoutLink`). **Zoom's own API** (a unique meeting per booking) is later: it needs a Zoom
   Marketplace app and review, and the personal-room link covers most small businesses meanwhile.

### Where the link shows
Stored once on the booking (`bookings.meeting_url`, `bookings.meeting_source`) **when it is confirmed**,
not while it's only a request, so a declined request never had a link. Then it appears in: the
confirmation email, the .ics (`LOCATION` + `URL`), the day-before reminder, the manage page, the
owner's calendar event (Outlook / Google / the subscribe feed) and the Bookings tab. A moved booking
keeps its link; a cancelled one drops it from the feed. Class sessions: an optional link per session
for online classes (`class_sessions.meeting_url`), same rules.

### Owner decisions
- Should Meeting Note Taker offer to join video consultations automatically? (Natural follow-on,
  not in this plan.)

### Files
SQL `db/z-booking-meeting-links.sql` (the columns above, apply to BOTH DBs before deploy),
`src/utils/bookings.ts` (confirm path, emails, .ics), `send-booking-reminders.ts`,
`src/utils/calendar-microsoft.ts` (`eventJson`, read-back), `booking-calendar-feed.ts`,
`site-booking.ts` (phone required for `phone`), Business Information UI, `booking-settings.ts`
validation, chat `booking_setup` card gains `meetingUrl` / per-service location. Tests alongside each.

---

## C. Google Calendar sign-in

### Today
Google users paste the calendar's secret iCal address (read every 15 min) and subscribe to our feed
(Google refreshes it every few hours). The plan recorded "no Google verification" as the owner's
choice on 2026-10-15; Outlook got a sign-in, Google didn't ("Google sign-in later").

### Build — mirror `calendar-microsoft.ts`
- Workspace integration `google_calendar` (the name already appears in schema comments; add it to
  `IntegrationProvider` / `INTEGRATION_PROVIDERS`, the OAuth start/callback in
  `oauth-integrations.ts`, the disconnect path).
- **IN — busy times:** `freeBusy.query` on the primary calendar (only start/end come back) into
  `calendar_busy`, replacing the business's iCal address (`busy_source = 'google'`), every 15 minutes
  and right after connecting. Optional: tick extra calendars to check.
- **OUT — bookings and class dates as events:** the same reconciler design as Microsoft
  (`calendar_events` with `provider = 'google'`, content hash, create/patch/delete only the
  difference; mark our events with `extendedProperties.private.bms = <key>` and skip them on IN).
  Generalise the reconciler so Microsoft and Google share it, rather than copying it.
- **Never fail a booking** on a calendar problem (same rule as Microsoft).
- Per person: v1 connects the business's calendar only (as Outlook does today); one sign-in per
  staff member is a later step.

### Scopes and verification (start in week 1)
- Request the narrowest pair: `calendar.events` (write our events) + `calendar.freebusy` (busy
  times). Both are **sensitive, not restricted** → Google verification with a demo video, **no CASA
  assessment**. Confirm both against Google's scope list before submitting — the Gmail submission
  was rejected over a console/code scope mismatch (memory: google-oauth-verification-submission), so
  the console list and the code must name exactly the same scopes.
- A NEW Google Cloud project, separate from YouTube and Gmail (decided 2026-11-08).
- Until approved: works for up to 100 test users behind Google's "unverified app" screen. Keep it
  "Coming soon" on the public /connections page and in help articles until approval
  (connections page = public claim list).

### Decided
- Google verification goes ahead; new Google Cloud project.

### Files
`src/utils/workspace-integrations.ts`, `netlify/functions/oauth-integrations.ts`,
new `src/utils/calendar-google.ts`, a shared reconciler pulled out of `calendar-microsoft.ts`,
`sync-busy-calendars.ts`, Business Information ▸ Bookings ▸ Your calendar UI, `connections.html`,
chat prompt line in `chat-orchestrator.ts` ("Google sign-in isn't available yet" → updated),
help article SQL. Tests: a new `tests/calendar-google.test.ts`, existing `tests/calendar-microsoft.test.ts`
kept passing after the reconciler is shared.

---

## Rules that apply to all three
- Every new setting works in the GUI **and** chat, through the same server action; chat proposes, the
  owner clicks.
- Bookings stay free (no tasks).
- Help articles + the chat prompt are updated in the same release; SQL goes to both DBs before deploy.
- Nothing new runs script on customer sites.

## Suggested sequence
1. Week 1: A (booking link) + B step 1 (any meeting link, meeting location); start C's console work
   and demo video.
2. Week 2: B step 2 (Teams via Outlook); C built behind the integration, tested with test users.
3. On Google approval: C live, Meet links (B step 3), /connections → Live.
