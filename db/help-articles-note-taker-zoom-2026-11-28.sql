-- db/help-articles-note-taker-zoom-2026-11-28.sql — Help Centre: the Note Taker on Zoom
-- (docs/zoom-marketplace-review-pack.md §6). Also the "Documentation" link in the Zoom Marketplace listing:
--   https://bemoreswan.com/help#the-note-taker-on-zoom   (help.html slugifies the title)
--
-- Inserted UNPUBLISHED (is_published FALSE): Zoom stays behind the meeting_bot_zoom flag until Zoom approves our
-- app, and a published article would tell customers they can use it today (Ask Your Team answers from published
-- articles). Publish it on the day we submit to Zoom, so the reviewer can open the link:
--   UPDATE help_articles SET is_published = TRUE, updated_at = now() WHERE title = 'The Note Taker on Zoom' RETURNING title, is_published
-- At go-live also change "Zoom is coming later" in 'The Note Taker Joining Your Calls'.
--
-- Guarded: inserts once. No semicolons inside string literals (the Neon editor splits pasted scripts on them).
--   node scripts/db-migrate.mjs apply --only help-articles-note-taker-zoom-2026-11-28 --execute --yes
--   node scripts/db-migrate.mjs apply --only help-articles-note-taker-zoom-2026-11-28 --url-var DATABASE_URL_PROD --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published)
SELECT 'Your Assistants', 13, 'The Note Taker on Zoom', $$
# The Note Taker on Zoom

Your Note Taker can join a Zoom call, take the notes, and put the minutes in your Inbox for you to approve. It works with any Zoom plan, free or paid.

Zoom only lets a note taker into a call on behalf of a Zoom user who has connected it and **is in that call**. So you connect your Zoom account once, and that person needs to be in each call the Note Taker joins.

## Connecting Zoom

1. Open your **Note Taker** and go to its **Inbox** tab.
2. Press **Send to a call**, then **Connect Zoom**.
3. Sign in to Zoom and press **Allow**.

The dialog then says which Zoom account is connected. One connection covers your whole workspace.

We ask Zoom for two things only: who you are (so we can show the connected account), and a one-time pass for each meeting you send the Note Taker to. We never read your recordings, chats, contacts, calendar, or meetings you didn't send it to.

## Sending it to a call

1. Copy the meeting link from the Zoom invite. It must have the meeting number in it, for example zoom.us/j/123456789. Personal room links (zoom.us/my/your-name) can't be used.
2. In **Send to a call**, paste the link.
3. Choose **Now**, or **Later** with a time, and how long it may stay.
4. Press **Send the Note Taker**.

**The person who connected Zoom must be in the call**, or Zoom won't let the Note Taker in. If they aren't, the **Live & upcoming** list says so, and nothing is charged.

If the meeting has a waiting room, the host lets the Note Taker in like any other guest.

## In the call

The Note Taker joins as **Note Taker for ⟨your business⟩**, with a tile showing your business name and **Taking notes & recording**. It posts a message in the meeting chat saying it is recording only to make a transcript, that the recording is deleted once the minutes are written, and that the host can remove it at any time.

**You must tell the people in the meeting that it is recording, and get any consent the law requires** (Terms clause 9.3).

## After the call

When the call ends, the minutes appear in your Inbox: a summary, decisions, action items with who and when, and a follow-up email that lists the action items. Nothing is sent until you approve it.

## Disconnecting Zoom

- In Be More Swan: **Send to a call**, then **Disconnect Zoom**. Only an owner or admin of your workspace can do this.
- Or in Zoom: open the **App Marketplace**, go to **Manage**, then **Added Apps**, and remove **Be More Swan Note Taker**.

Either way, the connection is deleted and no more Zoom calls can be joined until you connect again. Minutes already written stay in your workspace until you delete them.

## Cost and your data

Zoom calls cost the same as Google Meet and Microsoft Teams calls, and the recording is handled the same way: see **The Note Taker Joining Your Calls**. The Zoom sign-in is stored encrypted, and the one-time meeting pass is used straight away and never stored.
$$, FALSE
WHERE NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'The Note Taker on Zoom');

COMMIT;
