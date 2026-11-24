-- db/z-followup-card-own-mailbox-copy.sql — Fix pipeline #75 (owner, 2026-11-17): the Note Taker's "Email a Follow-Up
-- to Attendees" connection card still says the email can come "from Be More Swan when no inbox is connected".
-- That route was removed in PR #695 (c7db5cfb): the follow-up goes only from the user's own Gmail or Outlook, and with
-- neither connected nothing is sent. db/seed-catalog.ts has the right words, but it only runs on a fresh database, so
-- both live databases still show the old ones (checked 2026-11-24; the only scenario whose text differs from the seed).
-- An UPDATE, so the owner runs it on BOTH databases. Safe to run more than once; changes nothing else.

UPDATE integration_scenarios
   SET description = 'When you approve a meeting, email the reviewed summary and action items to every attendee — from your own connected Gmail or Outlook, never from anyone else’s address.'
 WHERE scenario_key = 'email_meeting_followup'
   AND description <> 'When you approve a meeting, email the reviewed summary and action items to every attendee — from your own connected Gmail or Outlook, never from anyone else’s address.';

-- Check: should show the new words.
SELECT scenario_key, description FROM integration_scenarios WHERE scenario_key = 'email_meeting_followup';
