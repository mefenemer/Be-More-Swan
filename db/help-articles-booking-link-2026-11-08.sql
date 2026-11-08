-- db/help-articles-booking-link-2026-11-08.sql: Help Centre, the booking link and where bookings
-- happen (video call, phone call, in person). NEW article. docs/booking-calendly-gaps-plan.md A + B1.
-- Ask Your Team answers only from published help_articles.
--
-- ⚠️ Run on each database WITH the release that carries the feature, not before
-- (and after db/z-booking-meeting-links.sql).
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted, NO semicolons inside
-- the body. Idempotent.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published)
SELECT 'Your Assistants', 10, 'Your Booking Link and Video Call Bookings', $$
# Your Booking Link and Video Call Bookings

Your Website Assistant takes bookings for appointments, consultations, tables and classes. Every business that takes bookings also gets a booking link of its own to share anywhere.

## Your booking link

Your booking link is your website's address with **/book** on the end, for example yourbusiness.bemoreswan.site/book. If your own domain is connected, it uses that instead.

It works as soon as bookings are set up, even if your website isn't published yet. Until you publish, the address shows only your booking pages.

To find it, open your **Website Assistant**, go to the **Bookings** tab and look for **Your booking link**. From there you can:

- **Copy link** to paste into your email signature, Instagram bio or messages
- copy a link for **one service** or **one person**, which skips straight past those choices
- copy a **Book now button** to paste into another website. It's a plain link, so it works anywhere. Other websites can't show the booking pages inside them.

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

You can also set this up by asking your Website Assistant in chat. It shows you a card to approve first.
$$, TRUE
WHERE NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'Your Booking Link and Video Call Bookings')
RETURNING title, 'added' AS result;

COMMIT;
