# Partner Onboarding + Partner Assistant Playbook — Plan

Owner request 2026-11-22: Angela (Kudzu Collab, an existing customer and US LLC) has applied to be our
first affiliate partner, at 50% for 12 months after costs. Approving her should feel like being
**welcomed as a partner**, not just getting a link. She should **meet her Partner Assistant**, which
tells her clearly what to do next. She also needs the tools and techniques to bring in as many paying
subscribers as possible.

Status: **decisions taken 2026-11-22 — the owner accepted every suggestion in §6 (D1–D8).** **Phase 1 built
2026-11-22** on branch `feat/partner-onboarding` (PR into staging): `src/utils/partner-onboarding.ts` (list,
greeting, starters, D7 limit), `src/config/partner-playbook.ts`, partner-hub `onboarding` block + `onboarding`
action, partner-assistant `partner_playbook` / `my_results` tools + first-draft tick, new approval email +
`partner_approved` bell notification, sidebar `ended` fix. ⚠️ **NEW SQL `db/z-partner-onboarding.sql` — apply to
BOTH DBs before deploy** (partner-hub / partner-assistant select every `partners` column). **Applied to STAGING
2026-11-23** (verified); prod not yet. Live test 2026-11-23 on staging (real handlers in-process, test partner #3
temporarily approved then restored): greeting + list + sums correct, 403 before Terms, marks merge, a real first
post (label first, workspace numbers in [brackets], link) and a playbook-based 30-day plan. Fixed from it: a reply
that said "needed more steps" above a finished draft when the 21s budget ran out. **Phase 2 built 2026-11-23** on branch `feat/partner-invite-page`: own invite page — `src/utils/partner-invite-profile.ts`
(text rules, JPEG check, R2 photo helpers), `partner-photo.ts` (approved photo public, pending only to the partner
or partner admins), partner-hub `invite_profile_submit` / `invite_profile_withdraw`, admin-partners `invite_page`
(approve / changes / take down) + Partner Ops `propose_invite_page`, Partner Assistant `propose_invite_page` (fills the
form only), invite.html "Paid partnership" block, first-week step 3, erasure; partner kit card reading
`partner-kit/kit.json` (empty until the owner adds files). ⚠️ **NEW SQL `db/z-partner-invite-page.sql` — BOTH DBs
before deploy** — applied to STAGING 2026-11-23; live-tested there in-process (submit, refusals, send back, resend,
approve, public page, take down, withdraw; real R2 not tested — no R2 keys in local .env). ⚠️ privacy.html doesn't mention the invite-page photo yet — owner/legal wording. **Phase 3 built 2026-11-23** on branch `feat/partner-weekly-nudge` (no new SQL): `src/utils/partner-weekly-nudge.ts`
(who gets one, the words, one action), scheduled `partner-weekly-nudge.ts` Mondays 08:10 UTC (claims the ISO week
before sending) + `run-partner-weekly-nudge` for staging-crons (weekly), bell + email (`partner_weekly_summary`,
non-transactional), one-click off on the Partner page (partner-hub `weekly_nudge`), `?view=partner&ask=<key>` types a
whitelisted question into the assistant, "In free trial" tile + `in_trial` / 7-day counts in partnerHubSummary.
Live-tested on staging in-process (sent once; same week skipped; off skipped; on sent; emails simulated).

Builds on the programme in [affiliate-partner-programme-plan.md](./affiliate-partner-programme-plan.md)
(steps 1–9 live on prod since 2026-10-19/23). Nothing here changes how commission is worked out, held or
paid.

## 1. Where it stands today

**The plumbing is done.** Apply → admin approves → email → Partner page inside the workspace
(`partner-content.html`, `partner-hub.ts`) with:
- the invite link (`/invite/<code>`) and an optional partner code;
- the Terms banner (v1.2 must be accepted before the assistant or payouts work);
- visits / sign-ups / paying / paid tiles, pending and ready-to-pay money, and the commission table;
- the payout form (PayPal / Wise / UK bank, saved in the vault, confirmed by email);
- the Partner Assistant (`partner-assistant.ts`): drafts with her link and an ad label first, answers
  money questions from her real numbers, and hands off to her own Social Media Manager / Email
  Marketing / Lead Generator. Free, 50 messages per 30 days.

**The welcome is thin.**

| Moment | Today | Problem |
|---|---|---|
| Approval email (`partner_approved`) | "Good news … Sign in to find your personal invite link." Button → `workspace.html` | Lands on the workspace home, not the Partner page. No rate, no next step. |
| In-app | Nothing on approval. A "Partner" item appears in the sidebar. | Easy to miss. No notification in the bell. |
| Partner page, first visit | Terms banner, then link, assistant, tiles (all 0), payout form | No "start here". A wall of zeros is discouraging. |
| Partner Assistant | Empty chat, 5 starter buttons | Doesn't introduce itself or explain anything. Waits to be asked. |
| Know-how | Writes posts / emails / scripts from `bms_facts` | No sales playbook: who to target, objections, launch plan, follow-up, demo script. Doesn't know her own results as a customer, which are the most persuasive thing she has. |
| Invite page (`invite.html`) | "Angela invited you to Be More Swan" + offer | Only her first name. No face, no words of her own, no reason to trust it. |
| Assets | None | No logo, screenshots or demo video to share. |
| Ongoing | Emails only when commission is earned or a payout is sent | Silence until the first sale. A partner who doesn't see progress in the first 2 weeks usually stops. |

## 2. The experience we want (Angela's first week)

1. **Approval email:** "Welcome to the partner team, Angela." It states her rate in one line (50% of what
   each customer pays, after costs, for their first 12 months) and has one button: **Meet your Partner
   Assistant** → `workspace.html?view=partner&welcome=1`.
2. **Bell notification**, the same message, opening the Partner page. It's there if she signs in without
   the email.
3. **Partner page, first visit:** a welcome card at the top with her name, rate, link and a short
   **"Your first week" checklist**:
   1. Accept the Partner Terms ✔︎ (button inline)
   2. Tell us where to pay you ✔︎
   3. Make your invite page yours (photo + a line in your own words), from Phase 2
   4. Draft your first post with your assistant
   5. Share your link personally with 5 people who'd benefit
   6. First visit → first sign-up → first paying customer (ticks itself)

   Ticks come from **real data**, never from clicking "done". The card folds away once 1–4 are done,
   and she can reopen it.
4. **The assistant speaks first.** The first time she opens the page (and after "New conversation" until
   she has sent a message), the chat shows a greeting built from her data:
   > Hi Angela, I'm your Partner Assistant. You earn 50% of what each customer you invite pays (after a
   > 20% cost deduction) for their first 12 months. On an £79 plan that's £31.60 a month for you.
   > Here's your plan for this week: ① accept the Terms ② add payout details ③ let's write your first
   > post about how Kudzu Collab uses Be More Swan. Which would you like to start with?

   The greeting comes with buttons: **Write my first post** · **Who should I tell first?** · **How do I get
   paid?** · **Give me a 30-day plan**. The greeting is put together **without a model call** (free,
   instant, doesn't use one of her 50 messages, and the numbers are exact).
5. **Starter buttons follow where she is:** Terms not accepted → "What's in the Terms?"; no visits yet →
   "Write my first post"; visits but no sign-ups → "Why aren't people signing up?"; sign-ups but nobody
   paying → "My sign-ups are in trial — what now?".

## 3. Tools and techniques (the playbook)

The assistant gets two new read tools and a written playbook, so its advice is specific and proven,
not generic.

### 3.1 `partner_playbook(topic)` — the know-how

A version-controlled file, `src/config/partner-playbook.ts`, written once and reviewed by the owner.
The assistant pulls the section it needs. Topics:

| Topic | What it gives her |
|---|---|
| `who_to_tell` | Who Be More Swan suits best (small businesses with no marketing person, solo owners, consultants' clients). How to pick her first 20 people from people she already knows. |
| `launch_30_days` | Week 1: personal story post + 5 personal messages. Week 2: a short demo video of her own workspace. Week 3: email to her list (consenting subscribers only). Week 4: a live demo / Q&A session, then follow-up. |
| `story_first` | "Show, don't sell": what it did for Kudzu Collab, before/after, a screenshot. Why personal beats promotional. |
| `objections` | "I'm not techy", "Is AI content any good?", "I tried ChatGPT", "Too expensive", "No time to set it up". Each answered with `bms_facts` only. |
| `demo_script` | A 10-minute screen-share walkthrough and a 45-minute workshop outline she can run for her clients or community. |
| `dm_and_followup` | Personal message templates, when to follow up (once, after 3–5 days), and when to stop. One-to-one only. |
| `trial_period` | Sign-ups get 14 days free and then their first month free. What she can say to people she knows are trying it (she never sees who they are; she can only ask her own contacts). |
| `channels` | LinkedIn, Instagram, Facebook groups, newsletters, YouTube, podcasts and events: what works where, how often, and the ad label on each. |
| `rules` | Ad label first, no spam, no invented results, no paid ads on our brand name, nothing that pretends to be Be More Swan. Mirrors Partner Terms v1.2. |

Every section respects what's already enforced: facts come only from `bms_facts`, drafts go through
`deliver_draft` (link + label first), and hand-off briefs carry the PECR / CAN-SPAM rules.

### 3.2 `my_results` — her own story as a customer

Because Angela is also a customer, her strongest material is **what her own team has done**. A read-only
tool returning **counts from her own workspace only**: posts published, blogs published, leads found,
emails sent, hours saved (if we already work that out) and months on Be More Swan. The assistant uses
these to suggest "I've had 48 posts written and published in 3 months". **She approves every number
before it goes out** (it is in a draft, never sent). Partners with no workspace get nothing from this
tool, and the assistant is told not to invent a story.

### 3.3 Her own invite page (Phase 2)

`/invite/<code>` becomes **her** page: photo, her headline ("Why I use Be More Swan for Kudzu Collab"), a
quote of up to 280 characters, then our standard offer and sign-up button. It's the single biggest
lever on visit → sign-up.
- Edited on the Partner page (and through the assistant: "help me write my invite page" → a card that
  fills the form; the same server action, per [GUI + chat parity]).
- **It goes live only after an admin approves it** (Admin → Partners → Details, and a Partner Ops card),
  because it's on our domain (see D4). Until then the page looks as it does today.
- Photo stored like other uploads; text sanitised; "Partner" badge + ad label on the page.

### 3.4 Partner kit (Phase 2)

A "Partner kit" card on the Partner page: logo (light/dark), 6–8 product screenshots, a 60-second demo
video, approved one-line descriptions, and brand do's and don'ts. Files supplied by the owner, served from
a static folder. The assistant can point to them ("attach screenshot 3 to this post").

### 3.5 Weekly nudge (Phase 3)

Every Monday, while she has activity or is in her first 8 weeks: an in-app notification + email from her
Partner Assistant with last week's numbers (visits → sign-ups → in trial → paying) and **one** suggested
action, which opens the chat with that action typed in. Skipped when there's nothing new to say, and she
can turn it off. Written from data without a model call (no surprise cost), using the playbook's rules.

### 3.6 Funnel tile: "In trial" (Phase 3)

Add an **In trial** tile between Sign-ups and Paying (a count only, never names). It answers her most
likely worry ("10 sign-ups, nobody paying?") and drives the `trial_period` advice.

## 4. Build

### Phase 1 — ready for Angela (small; build first)

| Change | Where |
|---|---|
| Approval email: new copy with rate + "Meet your Partner Assistant" button → `?view=partner&welcome=1` | `email-templates-catalog.ts` (`partner_approved`); `sendApprovalEmail` passes the rate. ⚠️ An admin-edited `notification_templates` row would override the catalogue, so check both DBs. |
| Bell notification on approval | `partner-notify.ts` (new `partner_approved` notification), called from `sendApprovalEmail` |
| Welcome card + "Your first week" checklist | `partner-content.html`; data from `partner-hub.ts` (new `onboarding` block) |
| Remember steps the data can't show (link copied, first draft made, card folded) | **SQL:** `partners.onboarding jsonb not null default '{}'` (`db/z-partner-onboarding.sql`, both DBs before deploy) |
| Greeting built from data + buttons that change with her progress | `partner-content.html` (greeting) + `partner-hub.ts` (facts) |
| `partner_playbook` + `my_results` tools; SYSTEM prompt points to them | `partner-assistant.ts`, new `src/config/partner-playbook.ts` |
| Record "first draft made" when `deliver_draft` runs | `partner-assistant.ts` |
| Fix: sidebar Partner item leaves out `ended` | `workspace.html` (~L4482) |
| Tests | `partner-onboarding.test.ts` (checklist from data, greeting numbers, £31.60 sum), extend `partner-assistant.test.ts` (new tools, playbook rules, `my_results` returns own workspace only) |
| **Live run of the Partner Assistant on staging** (never done; go-live item in the original plan) | browser pane, staging test partner |

### Phase 2 — her own invite page + partner kit

**SQL** for the invite-page fields + review status; profile editor + admin approval (screen + Partner Ops
card); `invite-lookup.ts` returns the approved profile; `invite.html` shows it; the kit card and static
assets.

### Phase 3 — weekly nudge + "In trial"

Scheduled function (Monday), notification + email template, opt-out setting, `partnerHubSummary` gains
`in_trial`, plus the new tile.

## 5. Before Angela starts (admin steps, no code)

1. Admin → Partners → Angela → Details: confirm the 50% is a **special rate** (20% deduction, 12 months,
   started). If the programme rate was changed instead, every future partner gets 50%. A started period's
   rate is frozen; only its end date can move.
2. Check her application is linked to her **existing account**. If it isn't, approval emails a
   create-account link and she gets a second workspace.
3. Optional: set a memorable partner code (e.g. `KUDZU`).
4. Approve. Ideally after Phase 1 is on prod, so she gets the new welcome.
5. Payout: as a US LLC she'd use **PayPal or Wise email**.
6. Before her first payout (at least 30 days after her first customer pays): compare the Wise CSV headers
   with a real Wise template, and ask the accountant about US tax forms (W-8BEN-E). We don't collect them.

## 6. Decisions (owner, 2026-11-22: "take my suggestions" — every row below is decided as suggested)

| # | Question | Decided |
|---|---|---|
| D1 | Approve Angela now with today's welcome, or wait for Phase 1? | Wait. Phase 1 is a few days, and she is the test run. |
| D2 | Greeting written from data (free, exact) or by the model (more natural, uses a message)? | From data. |
| D3 | Should `my_results` use her workspace counts in drafts? | Yes, as a suggestion only; she approves every number. |
| D4 | Her invite page: admin approves before it goes live, or live at once? | Admin approves (our domain, our liability for claims). |
| D5 | Who supplies the partner kit files (logo, screenshots, 60-second demo)? | Owner; the demo can come from the Walkthroughs studio. |
| D6 | Weekly nudge: on by default, for how long? | On, first 8 weeks + any week with activity; one-click off. |
| D7 | Raise the 50-message cap for the first month? | 100 in the first 30 days (counted from their first message), then 50. |
| D8 | Who reviews `partner-playbook.ts` before it goes live? | Owner reads it; `affiliate-legal-counsel` agent checks `rules` + `channels`. |

## 7. Not in this plan

- Multi-tier (partners recruiting partners), volume tiers, automated payouts, tax-form collection (as in
  the original plan §7).
- Showing partners who their sign-ups are. Customers stay "Customer N".
- Paid-ads tooling for partners.
