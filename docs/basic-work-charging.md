# Charging for chat, helpers, free rounds and finished designs — switch-on checklist

Decided by the owner on 2026-11-06, after a usage check showed customers far below their limits.
The code is built and stays off until `BASIC_WORK_CHARGED_FROM` takes effect.

| Work | Tasks | Charged when |
|---|---|---|
| Chat | 1 per 10 messages | Every 10th delivered reply in the month |
| Editing helper (rewrite, hooks, overlay text, quality review suggestions, applying suggestions, compliance check, caption shortening, blog Shorter/Longer/section rewrite, email line suggestions, lead follow-up preview, Mentor Get feedback, topic wording) | 1 each | When it succeeds |
| Brand Designer round with stock, branded cards, stock video or flyer pages | 1 per round, on top of any AI images or video in it | When the round produces those options |
| Finished design | 1, once per design, print files included | First PNG or PDF download from the editor |
| Remove background | 1 | Already on, not behind this switch |

Staying free: uploads, approving, scheduling, editing in the design editor, Mentor help-only mode with no
plan, and stock or branded cards outside Brand Designer rounds (Post Editor, Blog, Video Producer).

When the allowance runs out, chat and helpers stop until the 1st or an upgrade, like all other work.

## Before it can go live

1. Owner chooses the start date, at least 30 days after the notice goes out (terms 5.2, 20.2).
2. Owner has the terms reviewed: clause 5.1 and 5.2 (new charges) and 5.4 (chat and helpers currently
   "do not use tasks"), plus the X link and AI image wording. Bump `CURRENT_TOS_VERSION` and update the login modal.
3. Send the notice by email and in-app.
4. Apply `db/z-chat-task-tally.sql` to staging and prod.
5. Set Netlify env `BASIC_WORK_CHARGED_FROM=YYYY-MM-DD` on production. To test, `on` on the `staging` branch only.
6. Decide whether allowances (600 / 2,750 / 10,500) stay the same.

## On the start date (deploy this copy that day)

Text from the server follows the switch by itself (chat's cost summary and the Brand Designer source costs).
These are static and still say free:

- `pricing.html`, `faq.html` (task, chat and Mentor answers), `billing.html`, `my-content.js`
- "What Counts as a Task" and the Mentor Get feedback help text
- `src/components/assistant-briefs.js` (round cost lines), `src/components/disruptive-ui-registry.js`
  (the brief card's "Stock and branded cards are free"), `src/components/design-studio.js` (download menu)
- `FAIR_USE_MESSAGE` stays: the daily limits still apply on top

## Known gaps

- A design's picture saved or used from the library after approval is not charged as a download.
- Chat replies that fail before delivery do not count. Team notes count, as they are chat turns.
- Helper use is only kept 24 hours by the fair-use limit; once on, `task_ledger` is the record.
