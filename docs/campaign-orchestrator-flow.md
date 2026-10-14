# Campaign Assistant — the end-to-end flow, and what the screens should become

**Status:** proposal for agreement, 2026-10-14. Nothing here is built yet.
**Prompted by:** approving prod campaign 1's plan. The six briefs were sent, then nothing visible
happened: no other assistant mentioned receiving one, and nothing said what was waiting or why.

---

## 1. What actually happened to campaign 1 (prod, read 2026-10-14)

| # | Work | State | Why |
|---|---|---|---|
| 1 | Adjust the messaging | **Done** | Steering only. It changes what is drafted from now on. |
| 2 | Commission pictures | **Waiting on you** | The Brand Designer brief exists. It waits for "Make options" on the Brand Designer's Briefs tab, then for you to pick a picture. |
| 3 | 2 pillar articles | **Waiting on item 2** | The plan said "after item 2". |
| 4 | 10 social posts | **Waiting on item 2** | Same. |
| 5 | A/B test, 4 posts per angle | **Waiting on item 2** | Same. |
| 6 | 4-email follow-up | **Waiting on you** | All 4 emails are written. They sit switched off in Email Studio for review. |

So nothing is on a schedule. Two items are waiting on the user, and three are waiting on one of
those two. ⚠️ The "after item 2" waits were in the plan Claude filed, and they are the main reason
nothing moved: no article or post can start until a picture is approved.

Once an item is released, social and blog drafting is drained by `process-content-jobs` /
`process-blog-jobs` every 10 minutes. That is the only real schedule in the flow.

None of the above was visible on any screen.

---

## 2. The flow, defined

One campaign moves through six stages. Every screen names the stage, and every campaign shows
exactly ONE next step for the user, or "Nothing needed from you" and why.

| Stage | What it means | Who acts | Status shown |
|---|---|---|---|
| **1. Goal** | Objective, who it is for, what counts as success, target, end date, task budget. Created with "New campaign" or in chat. | You (or chat proposes) | Draft |
| **2. Plan** | The work: which assistant does what, how much, what waits for what. The Campaign Assistant proposes it; you edit it. | Assistant proposes, you edit | Draft · plan ready |
| **3. Approve** | One click: the campaign starts and every assistant is briefed. | You | Running |
| **4. Work** | Each brief moves through **Received → Waiting (on you / on another item) → Working → Ready for you → Done**. | Assistants, plus you where an item waits on you | Running · n in progress |
| **5. Review** | Finished work lands in each assistant's own review queue. The campaign links straight to it. | You | Running · n ready for you |
| **6. Results** | Progress against the target, the summary, lessons to keep. | You | Running / Finished |

**The "next step" rule.** Derived from data, never written by a model. In priority order:
1. A plan to review → "Review the plan" (opens it).
2. Something waiting on you that is blocking other work → "Pick a picture for item 2. Three
   items are waiting on it." (deep link to the Brand Designer brief).
3. Work ready for review → "Review 4 emails in Email Studio" (deep link).
4. Otherwise → "Nothing needed from you. 10 posts are being drafted; the first should be ready
   within about 10 minutes."

**Waits must be avoidable.** Every item waiting on another gets **"Start now without waiting"**.
That one control would have unblocked campaign 1. Work released or queued gets an honest time
("starts within 10 minutes"), and on approval the queue is poked so drafting starts at once
rather than at the next cron tick.

---

## 3. What the Campaign Assistant's tabs become

Today: **Campaigns · Orders · Decisions · Calendar · Goals · Activity**. Orders and Decisions are
two halves of the same story spread across three tabs, and neither says what to do next.

Proposed:

| Tab | Contents | Change |
|---|---|---|
| **Campaigns** (landing) | One card per campaign: a stage stepper (Goal → Plan → Approve → Work → Results), progress to target, and **the next step** button. Click a card to open the campaign. | Reworked |
| **Campaign page** (opened from a card; not a tab) | Everything about one campaign on one screen: the plan / work list with each item's live state and link to its result; the pending plan with Edit / Approve; pictures, tracked links, results, summary and lessons. | **New**. Absorbs the per-campaign half of Orders and Decisions. |
| **Needs you** | Everything across all campaigns waiting on the user: plans and decisions to approve, pictures to pick, emails and posts to review, people's tasks to mark done. | Replaces **Decisions**, which only held decisions. |
| **Calendar** | The year view plus when each campaign's work lands. | Unchanged |
| **Activity** | Includes the team conversation (section 4). | Gains the team feed |
| ~~Orders~~ | Removed as a tab: each order is a line on its campaign page. A flat "all work" list can be a filter on Campaigns if it is missed. | Folded in |
| ~~Goals~~ | A campaign's target *is* its goal. Two places to set one is confusing. | Proposed hidden for this role — **to confirm** |

---

## 4. Making the assistants' conversation visible (the "team channel")

**Problem.** Orders are written into another assistant's queue silently. The receiving assistant's
page never says it was asked for anything, so the system looks idle when it is not.

**Proposal: a team feed of real events, WhatsApp/Slack-style.** Every message is generated from a
state change that actually happened, never written by a model. An assistant must not claim to be
"working on it" while its job is still queued; that is the failure
`chat-claims-drafts-it-never-saved` is named after.

```
Finn (Campaign Assistant) → Lyra (Blog Writer)              14 Oct 02:54
  Brief: 2 pillar articles for "Prove Be More Swan's value — 500 leads".
  Waiting for: item 2, the campaign picture (Sandy).

Lyra → Finn                                                  14 Oct 02:54
  Got it. I'll start as soon as the picture is approved.      [Start now without waiting]

Sandy (Brand Designer) → you                                 14 Oct 02:54
  Your brief is ready. Press "Make options" to see pictures.  [Open brief]
...
Lyra → Finn                                                  14 Oct 09:12
  Drafting article 1 of 2.
Lyra → you                                                   14 Oct 09:31
  Article 1 is ready for your review.                         [Review in Blog Studio]
```

**Where it shows:**
1. **On each receiving assistant's page:** a "From your team" panel on its Overview listing open
   briefs, their state and who sent them, plus a badge. This answers "has Lyra received it?"
2. **One workspace-wide "Team" channel:** every assistant-to-assistant message in one feed,
   filterable by campaign and assistant. This shows the system working.
3. **On the campaign page:** the same messages for that campaign only, as its timeline.

**Messages (phase 1), written at the points the state already changes:**
- received
- waiting on [item / you]
- started
- ready for you (with a deep link)
- done
- cancelled (with the reason)

The writers live in `campaign-orders.ts` (issue), `campaign-reconciler.ts` (release, deliver)
and the job processors (started, ready), so every message has exactly one writer.

**Phase 2:** you can reply in a thread, and the reply becomes a note on that brief that the
assistant reads when it drafts. This is the "GUI and chat parity" rule applied to briefs.

**Data:** a new `assistant_messages` table (org, campaign_order_id, from_assistant_id, to (an
assistant id or the user), kind, body, link, created_at). It needs DDL on both envs before deploy.

---

## 5. Suggested build order

1. **Unblock and explain the work (small; fixes campaign 1 today):**
   - live state per item on the Campaigns card
   - "Start now without waiting"
   - a queue poke on approval
   - the next-step line
2. **The team feed:** the table, its writers and the "From your team" panel. Then the Team channel.
3. **Tabs:**
   - the campaign page
   - Needs you replacing Decisions
   - Orders folded in
   - Goals hidden (if agreed)
4. **Phase 2 of the feed:** replies on a brief.

## Open questions for the owner
1. Hide **Goals** for the Campaign Assistant (the campaign target is the goal)?
2. Should the Team channel live in the main workspace navigation, or only inside each assistant?
3. Should plans the assistant proposes avoid "wait for the picture" by default? A shared picture is
   nice to have, but it should not hold up all drafting.
