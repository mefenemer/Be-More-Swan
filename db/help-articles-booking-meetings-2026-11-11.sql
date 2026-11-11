-- db/help-articles-booking-meetings-2026-11-11.sql: Help Centre, the booking link article gains the
-- QR code, a Teams / Google Meet meeting per booking, and online classes (docs/booking-calendly-gaps-plan.md).
-- UPDATE of 'Your Booking Link and Video Call Bookings' (db/help-articles-booking-link-2026-11-08.sql).
--
-- ⚠️ Run on each database WITH the release that carries the feature, not before
-- (and after db/z-booking-meeting-providers.sql). Idempotent.
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted, NO semicolons inside the body.

BEGIN;

UPDATE help_articles SET content_md = $$
# Your Booking Link and Video Call Bookings

Your Website Assistant takes bookings for appointments, consultations, tables and classes. Every business that takes bookings also gets a booking link of its own to share anywhere.

## Your booking link

Your booking link is your website's address with **/book** on the end, for example yourbusiness.bemoreswan.site/book. If your own domain is connected, it uses that instead.

It works as soon as bookings are set up, even if your website isn't published yet. Until you publish, the address shows only your booking pages.

To find it, open your **Website Assistant**, go to the **Bookings** tab and look for **Your booking link**. From there you can:

- **Copy link** to paste into your email signature, Instagram bio or messages
- copy a link for **one service** or **one person**, which skips straight past those choices
- copy a **Book now button** to paste into another website. It's a plain link, so it works anywhere. Other websites can't show the booking pages inside them.
- download a **QR code** to print for your counter, a flyer or the window. Scanning it opens your booking link.

Your booking link needs three things first:

1. Your website's address, chosen on the Website tab under Publish. You don't need to publish.
2. Your opening hours, in **Business Information ▸ Hours & Location**.
3. Something to book: a service with a length in **Products & Services**, a table under **Bookings**, or a class date.

Your other assistants know your booking link too, so a post, email or follow-up that asks people to book uses the right address.

## Where each booking happens

In **Business Information ▸ Products & Services**, each service with a length has a **Where it happens** setting:

- **In person** is the default.
- **Video call**: customers get your meeting link once their booking is confirmed.
- **Phone call**: customers must give their phone number, and you call them.

## Your video call link

Paste the link you use for every call in **Business Information ▸ Bookings ▸ Your video call link**. It can be your Zoom personal room or a Google Meet or Teams link you reuse.

A person under **Who or what can be booked** can have their own link. Their bookings then use it instead of yours.

The link appears in the confirmation email, the calendar invite, the day-before reminder and the customer's own booking page. It's never sent while a booking is still waiting for you to confirm it. If you change your link, upcoming bookings get the new one.

No link yet? Customers are told you'll send one, and your Bookings tab reminds you to add it.

## A Teams or Google Meet meeting for each booking

If your Outlook or Google calendar is signed in (**Business Information ▸ Bookings ▸ Your calendar**), you can choose **How video call links are made**:

- **Use my link above**: every customer gets the same link.
- **A Teams meeting for each booking**: needs Outlook signed in, with a work or school Microsoft 365 account.
- **A Google Meet for each booking**: needs Google Calendar signed in.

The meeting is made in your calendar when you confirm the booking, before the customer is emailed. If one can't be made, your own link is sent instead and Business Information tells you why. One calendar can be signed in at a time.

## Online classes and events

When you add a class or event date on the Bookings tab, you can add a **Video call link**. Everyone who books a place gets it once their place is confirmed, and the timetable on your website shows the date as online. The link itself is never shown on your website.

You can also set this up by asking your Website Assistant in chat. It shows you a card to approve first.
$$
WHERE title = 'Your Booking Link and Video Call Bookings'
RETURNING title, 'updated' AS result;

COMMIT;
