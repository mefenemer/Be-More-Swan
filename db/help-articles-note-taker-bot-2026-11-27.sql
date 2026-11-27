-- db/help-articles-note-taker-bot-2026-11-27.sql — Help Centre: the Note Taker joining your calls (launch 27 November 2026)
-- docs/note-taker-bot-legal.md §6. Ask Your Team answers ONLY from published help_articles, so this is how it can
-- explain sending the bot, letting it in, the cost, what is kept, and telling people.
--
-- Run on BOTH databases on launch day, with the release that publishes DPA 1.2 and Terms 2.5. Guarded: inserts once.
--   node scripts/db-migrate.mjs apply --only help-articles-note-taker-bot-2026-11-27 --execute --yes
--   node scripts/db-migrate.mjs apply --only help-articles-note-taker-bot-2026-11-27 --url-var DATABASE_URL_PROD --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published)
SELECT 'Your Assistants', 12, 'The Note Taker Joining Your Calls', $$
# The Note Taker Joining Your Calls

Free Google Meet and Microsoft Teams accounts don't make a transcript. Your Note Taker can join the call itself, take the notes, and put the minutes in your Inbox for you to approve.

## Sending it to a call

1. Open your **Note Taker** and go to its **Inbox** tab.
2. Press **Send to a call** and paste the meeting link from the invite. Google Meet and Microsoft Teams links work today. Zoom is coming later.
3. Choose **Now**, or **Later** with a time up to 60 days ahead, and how long it may stay (2 hours unless you change it, 4 at most).
4. Press **Send the Note Taker**.

You can also ask in chat, for example "join this call: ⟨link⟩". Your Note Taker shows a card, and nothing happens until you press it.

## Letting it in

The Note Taker joins as a guest called **Note Taker for ⟨your business⟩**, so the host must let it in:

- **Google Meet:** press **Admit** when it asks to join.
- **Microsoft Teams:** it waits in the lobby; press **Admit**. Some company Teams accounts don't allow guests at all; then it can't join.

If nobody lets it in within 10 minutes it gives up, and nothing is charged. It leaves on its own 2 minutes after everyone else has gone, or when it reaches the time limit. The host can remove it at any time. On a free Google Meet account it counts as a person in the call, so a 1-to-1 call becomes a group call with Meet's 60-minute limit.

## What it says in the call

When it joins, it posts a message in the meeting chat saying it is recording the call only to make a transcript, that the recording is deleted afterwards, and that the host can remove it. Its video tile shows your business name and **Taking notes & recording**.

**You must tell the people in the meeting that it is recording, and get any consent the law requires** (Terms clause 9.3). In some places, including several US states, everyone in the call must agree before it is recorded. Don't send it to a meeting secretly, or to a meeting you aren't entitled to attend.

Don't send it to meetings about health, disciplinary matters or other sensitive subjects unless you have a lawful reason to record them. Take particular care with meetings that include children or vulnerable people.

## Your minutes

When the call ends, the Note Taker writes up the minutes: a summary, decisions, action items with who and when, risks, and a follow-up email. They wait in your Inbox, marked **Joined by the Note Taker**, and nothing is sent until you approve them. Everyone in one room shares one name in the transcript, because names come from the meeting service.

The **Live & upcoming** list above your Inbox shows each call: booked, joining, in the call, or done. If a call has no minutes, it says why, for example nobody let it in, nobody spoke, or there was too little said to make a meeting.

## What it costs

It's free until **1 January 2027**. From then, it uses **1 task for each started 5 minutes** it's in the call with you, so a 1-hour meeting is 12 tasks. Nothing is charged if it isn't let in, or for the time it waits after everyone has left. Pasting notes or a transcript into a new meeting stays free.

When you send it, your monthly allowance needs room for the whole time limit you chose. It is only charged for the time it was actually in the call, and its minutes are always written, even if your allowance has run out in the meantime.

## What is kept, and where

- Our provider **Recall.ai** runs the bot. Its sub-processor **AssemblyAI** turns the audio into text.
- For UK and EU workspaces, the recording and transcript are made and stored in the EU (Frankfurt). For US workspaces, in the US.
- The transcript is used once to write the minutes. Then the recording and transcript are deleted at Recall.ai. We don't keep the transcript.
- AssemblyAI deletes the audio once it has made the text. If that deletion fails, the audio and text are deleted within 3 days.
- Your minutes stay until you delete them.

An owner or admin of your workspace must accept version 1.2 of our Data Processing Agreement, which names Recall.ai and AssemblyAI, before anyone can send the Note Taker. Whoever sends it must have accepted version 2.5 of our Terms of Service. Until then, **Send the Note Taker** is greyed out and says why.

If your organisation needs a data protection impact assessment for recording meetings, email privacy@bemoreswan.com and we'll send a summary of how the Note Taker handles meeting data.
$$, TRUE
WHERE NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'The Note Taker Joining Your Calls');

COMMIT;
