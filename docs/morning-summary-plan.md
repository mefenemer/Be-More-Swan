# Morning Summary — Plan

Owner request 2026-10-31, from a ReStructure AI Short ("every morning it sends a one-page summary:
which calls turned into sales and what video to make next"). Status: **built on staging 2026-11-02,
not committed when written** — owner took every recommendation in §7 (D1–D5). Before deploy: apply
`db/z-mentor-morning.sql` on BOTH DBs and re-run `db/notifications-categorization.sql`; help text in
`db/help-articles-2026-12zzzzzzzzzzzzzzz-mentor-morning.sql`. Not built: an Overview card (the summary
lives in the Mentor chat, like the weekly review). Never run against a real database yet.

## 1. What it is

A short morning note from the **Business Mentor** (live on prod, on every plan, takes no seat):
yesterday's money, today's diary, what needs the owner, and one thing to make next. One screen,
read in under a minute. On a day with nothing to say, nothing is sent.

## 2. What already exists — reuse, don't rebuild

| Need | Exists | Notes |
| --- | --- | --- |
| Weekly coaching | `mentor-review.ts` + `dispatch-mentor-reviews` (06:45 UTC daily, runs on review day) | The morning summary is its daily, model-free sibling |
| Results across active assistants | `roi-activity.ts` | One counting module; never count tables directly |
| Customers, won/lost | `mentor-customers.ts` (`revenue_events`, reviews, tickets, invoices) | Already gated on ACTIVE assistants |
| Site sales | `site_orders` (shop), `bookings` (+ deposits) | Website Assistant |
| Enquiries | `site_enquiries` (+ `site_chats` if the sales chat ships) | |
| Waiting on the owner | `pending_actions` → `pending-actions-digest.ts` (09:00 UTC daily email) | ⚠️ overlap — see D3 |
| Campaign source | `/go/` links, `?lt=` lead credit | Answers "where did it come from" |
| Delivery | notification prefs (`mentor_weekly_review` pattern), Team Chat note, email templates catalog | |
| Time zone | `booking_settings.timezone` (default Europe/London), `user_profiles.timezone` | |

`weekly-digest.ts` stays unscheduled (owner choice 2026-10-12); this does not revive it.

## 3. Contents (in this order, each section omitted when empty)

1. **Yesterday's money** — shop orders and paid deposits (count, £), deals marked won (from
   `revenue_events`), each with its source when known ("from your Instagram campaign link",
   "from website chat").
2. **Today** — confirmed bookings and pending requests waiting for a yes.
3. **New enquiries** — count, oldest unanswered, with "Reply" links.
4. **Needs you** — approvals waiting (posts, emails, outreach, Mentor proposals), oldest first,
   capped at 3 lines + "and 4 more".
5. **Make next** — ONE suggestion, picked by rule, not a model: the best-performing post/blog of
   the last 14 days → "Make another like this" (deep link to that assistant's chat with the
   prompt filled in, only if that assistant is ACTIVE); otherwise the top open Mentor proposal.

"Which calls turned into sales" is only claimable where we can link them: a booking or chat that
ended in an order, or a lead marked won. We do not see phone calls; the summary never implies we do.

## 4. Design

- `src/utils/mentor-morning.ts`: `buildMorningSummary(db, orgId, day)` → plain data; renderers for
  email, Team Chat note and an Overview card. Pure rules → **no model call, no task**.
- Dispatcher: `dispatch-mentor-mornings` hourly; sends at **07:00 in the workspace's time zone**
  (so one schedule covers every zone); staging poke in `staging-crons.yml`.
- Skips: Mentor not provisioned, Quiet mode, switched off, nothing to say, already sent today
  (`mentor_mornings` row per org per day — also the idempotency latch).
- Recipients: owners and admins, by each user's notification settings (new type
  `mentor_morning_summary`; email default per D2).
- GUI + chat parity: Mentor setup question "Morning summary: on/off, time"; chat card
  `setup_field_proposal` already covers setup answers; "Show me this morning's summary" in chat
  reads the same builder.

## 5. Data model
`db/z-mentor-morning.sql`: `mentor_mornings` (organisation_id, day date, sent_at, summary jsonb,
unique (organisation_id, day)). Kept 30 days. Notification type + email template rows.

## 6. Build order
1. Builder + tests (each section omitted when empty; no inactive assistant named; no "calls").
2. SQL, dispatcher, email + Team Chat + Overview card, setup question, help article.
3. Fold `pending-actions-digest` into it for workspaces that receive the summary (D3).
4. When the website sales chat ships, add chat outcomes to sections 1 and 3.

## 7. Decisions for the owner
- **D1** Owner: the Business Mentor (rec.) — it's on every plan and already does the weekly review.
- **D2** Default: ON for owners in the app, email opt-in (rec.)? Or email on by default?
- **D3** Replace the 09:00 pending-actions email for anyone who gets the summary (rec.: yes —
  two morning emails is one too many)?
- **D4** "Make next" by rule only (rec., free) or a model-written suggestion (1 task/day)?
- **D5** Send time: 07:00 local (rec.) or user-chosen?
