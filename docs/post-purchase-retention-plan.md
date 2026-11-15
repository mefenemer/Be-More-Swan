# Post-purchase retention assistants + plans — PLAN (feature request #39)

2026-11-15. **Nothing built.** For the owner to review and decide (§6).

The ask: *"Thoughts on the below? Remember it needs to fit the Be More Swan ethos. It must work as a UI and in chat.
Detailed spec for each assistant required and confirmation as to the disruptive capabilities they will each offer. We
also need to consider pricing as the 69 plan may not be enough money to cover all of the costs…"* The pasted proposal
suggested four assistants: Onboarding "Concierge" (days 1–30), Adoption "Coach" (30–60), Support & Triage (60+) and
Account Management & Expansion (90+).

---

## 1. Short answer

- **Good idea, wrong customer in the paste.** It was written for a SaaS company keeping its own subscribers (Stripe
  checkout, telemetry on unused features, bug-vs-feature triage). Our customers are hairdressers, cafés, coaches,
  trades and shops. What they need is help **keeping their own customers**: welcoming them, getting reviews, answering
  questions, bringing them back. That's "the stage after Marketing and Sales" in plain business terms: **Customer
  Care** (win → **keep** → run).
- **Most of the pieces already exist**, spread across assistants: review requests after a booking or order
  (`src/utils/review-requests.ts`, Audience ▸ Reviews), onboarding / renewal / win-back / re-engagement email flows
  (`src/config/email-campaign-cadences.ts`), the First-Line Support Assistant (drafts replies from the Knowledge
  Base), the Accounts Receivable Clerk, bookings, website orders, products, the Audience and Form Builder. The catalogue
  already lists **Client Onboarding Assistant** and **Reputation Management Assistant** as "coming soon". So this is
  mostly joining things up behind four assistants, not building from nothing.
- **Recommendation:** build four customer-facing Customer Care assistants (§3), in this order: Reviews & Reputation,
  Client Onboarding, Repeat Business, then a stronger First-Line Support. Keep Be More Swan's own retention as Admin
  work plus "dogfooding" (we use the same assistants on our customers), not as a product.
- **Pricing: you're right that £69 for everything is exposed.** Average use is tiny today, but a heavy £69 workspace
  could cost us roughly £65 a month in AI at worst before chat (§4.2). Proposal: keep £29 single assistant, make £69
  **Marketing & Sales** only, add **Customer Care** at about £49 and **Whole Team** (everything) at about £129, with
  existing £69 customers kept on what they have.

## 2. Two readings of the paste, and which to build

| | Reading A: Be More Swan keeps **its own** subscribers | Reading B: our customers keep **their** customers |
| --- | --- | --- |
| Who benefits | Us (lower churn) | Every customer; it's something we sell |
| Fits "a plan for the stage after Marketing and Sales" | No: it's not a plan anyone buys | **Yes**: a new stage of assistants to sell |
| What already exists | A lot (below) | The parts listed in §1, not yet one assistant each |

**What Be More Swan already does for itself (Reading A), mapped to the paste:**
- *Concierge (days 1–30):* the set-up wizards, assistant welcome messages, Mentor full set-up and **Take Me There**
  (business-mentor-plan), the trial plan.
- *Coach (30–60):* the **Business Mentor** on every plan (suggestions you approve, weekly review), the **morning
  summary** (07:00, rules only, no task), Results tabs, the What's New email.
- *Support & Triage (60+):* **Help Centre** and **Ask Your Team** (reads only published help articles), issue reports,
  the **Fix pipeline** and feature-request boards with proof before prod, the notifications **Inbox**.
- *Account management (90+):* plan moves with 30 days' notice, beta-ending handling. **Gaps:** no single customer
  health view and no "why are you leaving?" step that we act on.

**Recommendation:** build **Reading B** as products. For Reading A, add two small Admin items to the backlog (a
customer health list in Admin: last sign-in, % of tasks used, assistants live, approvals waiting; and a cancellation
reason + one honest save offer) and run our own customers through the new assistants once they exist, which also
gives us real proof for the pricing page.

## 3. The four Customer Care assistants

Rules that apply to all four (the Be More Swan ethos as the code already enforces it):
- **Nothing goes out without the owner's yes.** Every email, reply or offer is a draft in a Review tab; the owner can
  allow a named, low-risk kind (e.g. "thank-you after a 5★ review") to send by itself only after approving a few.
- **Every capability = GUI and chat** (same server action, a chat card for each; chat capabilities manifest updated).
- **Active teammates only:** an assistant only hands work to, or mentions, another assistant the workspace has live.
- **Plain English, expert craft:** each prompt gets a craft section and a rubric, as Business Mentor did.
- **Honest data rules:** consent and opt-outs via the Audience and `checkSuppression`; no review gating, no fake or
  rewritten reviews (DMCC Act 2024); marketing email only to people who may receive it (PECR soft opt-in for existing
  customers, with an opt-out on every message).
- Every role needs set-up questions, chat route, dashboard entry, build-manifest line, welcome message, goal metric,
  Mandate suggestions, connection-map entry and a Mentor playbook (tests enforce most of these).
- **"Disruptive capability"** below means *what this does that a small business can't get from its current tools at
  this price*, stated without stretching. (In the code, "Disruptive UI" is the name of the chat-card registry; every
  capability here also gets a card there.)

### 3.1 Reviews & Reputation Assistant (`review_reputation_manager`, catalogue row exists)
- **Purpose:** more honest reviews, every review answered, good ones put to work.
- **Who it serves:** any business with customers who could review it; strongest for local services and hospitality.
- **Triggers:** a booking completed or website order (already built), a Lead Generator lead marked Won, a manual "ask
  these customers" list or CSV, a new review arriving (pasted in Phase 1; Google Business Profile in Phase 2).
- **GUI:** tabs *Requests* (who was asked, opened, reviewed), *Reviews* (all sources, star filter), *Replies* (drafts
  to approve), *Settings* (Google review link, wait after purchase, wording). Extends Audience ▸ Reviews, not a copy.
- **Chat, e.g.:** "Ask everyone who booked last week for a review." "Draft a reply to the 2★ review from Sam — we
  were short-staffed." "Turn our three best reviews this month into a social post." "What are people complaining
  about?" (a theme summary with counts and quotes, never invented).
- **Data:** bookings, orders, Audience contacts, review settings, opt-outs (`review_opt_outs`), products/services.
- **Reuses:** review-requests.ts + send-review-requests (hourly), org-reviews, website reviews section; Social Media
  Assistant (if live) for "review → post"; Website Assistant for the reviews block.
- **Disruptive capability:** the same review flow Birdeye/Podium sell at about $299–$599 a month, joined to the
  business's own bookings and orders so asks go at the right moment with no set-up, and replies written in the
  business's own brand voice. Honest limits: email only (no SMS) at first; Google replies need the Business Profile
  API approval; Trustpilot invitations are not ours to send.
- **Cost/metering:** a request email = no AI (template) → **0 tasks**; a drafted reply or theme summary = 1 task
  (Sonnet, ~£0.01–0.03 of AI each, estimate). Sending uses our existing email provider.

### 3.2 Client Onboarding Assistant (`client_onboarding_guide`, catalogue row exists)
- **Purpose:** every new customer feels looked after in the first 30 days and gets to the result they paid for.
- **Who it serves:** service businesses with a start-up step (coaches, agencies, accountants, trainers, builders,
  holiday lets: check-in info).
- **Triggers:** a Won lead, a paid booking or order, a deposit paid, a new Audience contact tagged "client", or "new
  client" typed in chat.
- **GUI:** a *Clients* board (Welcome sent → Form back → Kick-off booked → First result → Settled), each card with
  what's missing; *Packs* (welcome email + documents per service); *Review* tab of drafts.
- **Chat, e.g.:** "Onboard Priya, she's bought the 6-week plan." "Who still hasn't sent their intake form?" "Chase
  them politely." "Add our parking info to the welcome pack." "Book Ben's kick-off for next week."
- **Data:** products/services, Form Builder forms and submissions, booking links, Audience, Lead Generator Won stage.
- **Reuses:** the Onboarding email-flow cadence (day 1 / 3 / 7 / 14), Form Builder, Booking (`/book` link per
  service), Email Marketing Assistant sending, Minute Taker for kick-off notes if live.
- **Disruptive capability:** a small business gets a proper client-onboarding process (welcome pack, chasing, kick-off
  booking, check-ins) without buying a CRM or a client portal, set up by answering a few questions in plain English.
  It knows when the customer is stuck (form not back, kick-off not booked) and drafts the nudge.
- **Cost/metering:** 1 task per drafted personalised email or pack; chasing reminders built from templates 0.

### 3.3 Repeat Business Assistant (win-back, rebooking, referrals; "account management" for a small business)
- **Purpose:** turn one-off buyers into regulars and bring lapsed customers back.
- **Who it serves:** anyone with repeat purchases or visits: salons, clinics, cafés, shops, trades with servicing.
- **Triggers:** "due again" dates from bookings/orders (a service interval per product, e.g. 6 weeks for a cut,
  12 months for a boiler service), no purchase in N days (lapsed), birthdays/anniversaries if collected with consent,
  a 5★ review (good moment to ask for a referral), an invoice paid.
- **GUI:** *Customers* list with a simple, explained health label (Regular / Due / Drifting / Lapsed — rules, not a
  black-box score), *Suggestions* ("12 customers are due a rebook — draft the invites?"), *Offers* the owner set,
  *Results* (rebookings and revenue the business confirms).
- **Chat, e.g.:** "Who hasn't been back since the summer?" "Send my regulars first look at the Christmas menu."
  "Draft a win-back for lapsed clients, 10% off, ends Friday." "Ask happy customers for a referral."
- **Data:** bookings, orders, products (prices, intervals), Audience consent and segments, the business's offers
  (`outreach-offer` / intro offer settings).
- **Reuses:** win-back, re-engagement and renewal cadences in Email Flows; Audience segments; intro-offer and offer
  rules (never invent a price or end date); Social Media Assistant for public offers; AR Clerk for unpaid balances.
- **Disruptive capability:** the "flows" Klaviyo or Mailchimp sell from about $20 a month upwards, but without the
  owner having to design the flows: the assistant works out who is due, drafts the message in the business's voice and
  asks for a yes. Works for a salon or a plumber, not just Shopify shops. Honest limits: no points/stamp-card loyalty
  scheme (Smile.io, LoyaltyLion) in this plan; customer data must be in Be More Swan (bookings, orders, Audience or an
  import) until shop connectors exist.
- **Cost/metering:** health labels are rules, 0 tasks; each drafted message or batch = 1 task (as an email today).

### 3.4 First-Line Support Assistant, stronger (`tier1_support_agent`, live)
- **Today:** drafts replies to questions the user pastes, from the Knowledge Base; angry customers and refund demands
  go to a human with a summary.
- **Add:** read customer emails as they arrive through the **Email Assistant's** connected mailbox (Gmail/Outlook,
  once verified) and website contact-form messages; sort into *question / complaint / request / booking change*;
  draft the answer; spot "this question keeps coming up" and offer a new help article or website FAQ.
- **Chat, e.g.:** "What came in overnight?" "Answer the parking questions, I'll do the complaint." "We now open at 9 on
  Saturdays — update the answers." "What are customers asking most this month?"
- **Disruptive capability:** a help desk that answers from the business's own information and never sends without
  approval, for the price of one assistant, against HubSpot Service Hub at about $7–20 a seat before AI add-ons.
  Honest limits: no live chat widget on hosted sites (they carry no JavaScript; the planned `/_ask` page could serve);
  Zendesk/Intercom connectors stay "coming soon".
- **Cost/metering:** sorting = Haiku (fractions of a penny), 0 tasks; each drafted reply 1 task.

**Shared with the Customer Care stage:** Email Marketing Assistant (sends the flows), Email Assistant (inbox),
Website Assistant (bookings, orders, reviews block), Accounts Receivable Clerk (getting paid is part of a good
after-sale; may move to a later "Run the business" stage).

## 4. Pricing

### 4.1 What is live today (master_plans; confirm in Admin before quoting)
| Plan | Price | Assistants | Tasks / month |
| --- | --- | --- | --- |
| Free trial | £0 | — | 150 |
| The Workflow Saver (`saver`) | £29 | 1 of your choice | 600 |
| The Busywork Buster (`buster`) | £69 (was £79 until 2026-10-19) | **every assistant** | 2,750 |
| The Digital Employee (`employee`) | £349 | 10 | 10,500 — no longer sold; existing keep it |
| Bespoke Assistant (`enterprise`) | by quote | built for you | agreed |

Business Mentor is included on every plan and takes no place. Chat and editing helpers cost **no** tasks today
(fair use 300 chat messages and 200 helper actions a day per workspace); the owner's 2026-11-06 decision to charge
basic work is built but switched off pending terms and notice. Weighted work: AI video 20 tasks (per-second pricing
built, off in prod), AI music 20, X link post +10.

### 4.2 What it costs us (grounded where we can be)
- **Model rates in `src/utils/ai-usage.ts`:** Sonnet 5.5 $2 / $10 per million tokens in/out, Opus 5.5 $4 / $20,
  Haiku 5.5 $0.10 / $0.50. A typical drafted email or post is roughly $0.02–0.03 on Sonnet, $0.05–0.06 on Opus
  (estimate). Media: FLUX.2 Pro about $0.03–0.05 an image; Kling 3 Pro about $0.11 a second (a 5 s clip ≈ $0.60 for
  20 tasks, i.e. about $0.03 a task); X charges about $0.20 per link post.
- **Real spend:** prod logged **$40.91 of AI** from 17 Oct to 6 Nov across all customers; the heaviest workspace used
  **2.5%** of its allowance. Treat this as a floor: usage writes were partly lost until the fix of 2026-11-12
  (d430869f, staging), so read the System Map's 30-day cost again once that is on prod.
- **So:** at about **$0.03 a task** on average, a fully used £69 plan costs about $82 ≈ **£65** of AI, plus Stripe
  fees, email sending and hosting, before chat. Free chat is the bigger open risk: 300 messages a day is far above
  what any customer uses, but at about $0.03 a message a determined user could cost more than the plan. Both point the
  same way: **everything-for-£69 only works while people use little of it.** Check whether prices include VAT; if
  they do, £69 is £57.50 to us.

### 4.3 Proposed structure (indicative prices — estimates for discussion)
Business stages in plain words: **Win** customers (Marketing & Sales) → **Keep** them (Customer Care) → **Run** the
business (Operations & Finance: later, as those assistants go live).

| Plan | Price | What's in it | Tasks | AI cost if fully used* | At 25% use* |
| --- | --- | --- | --- | --- | --- |
| **Single Assistant** (today's Workflow Saver) | £29 | any 1 assistant | 600 | ~£14 | ~£4 |
| **Marketing & Sales** (today's £69, narrowed) | £69 | Social Media, Blog, Email Marketing, Campaign, Brand Designer, Video Producer, Lead Generation, CRM Data, Website, Mystery Shopper | 2,750 | ~£65 | ~£16 |
| **Customer Care** (new) | £49 | Reviews & Reputation, Client Onboarding, Repeat Business, First-Line Support, Email Marketing, Email Assistant, Website (bookings, orders, reviews), Accounts Receivable Clerk | 1,500 | ~£36 | ~£9 |
| **Whole Team** (new) | £129 | everything live, incl. Minute Taker and future Run assistants | 4,500 | ~£107 | ~£27 |
| Bespoke Assistant | by quote | unchanged | agreed | | |

\* $0.03 a task, $1 = £0.79, AI only, no chat, no VAT — estimates to check against the System Map once usage logging
is complete on prod.

Why this shape:
- **Shared assistants are bought once.** Email Marketing and Website sit in both stage plans; buying both stages
  (£118, 4,250 tasks) is dearer than Whole Team (£129, 4,500 tasks), which nudges the upgrade.
- **Customer Care is cheaper than Marketing & Sales** because its work is mostly templates and short replies (many
  actions are 0 tasks) and because it is the easier second purchase for an existing customer.
- **£29 stays** as the way in; the Mentor stays free on every plan, and is what suggests the next stage when it fits
  ("you've had 40 bookings and no review requests — Customer Care would handle that").
- **Against the market:** Klaviyo or Mailchimp flows ~$20+ a month, Trustpilot from ~$99 a month, Birdeye/Podium
  ~$299–$599, Smile.io/LoyaltyLion $15–$199+, HubSpot Service Starter ~$7–20 a seat (third-party figures, Nov 2026,
  vary by source). £49 for reviews + onboarding + repeat business + support drafts is well under any two of those.
- **Existing £69 customers keep every assistant** via the existing "new subscribers only" snapshot
  (`plans.feature_overrides`) and the plan-change scheduler with 30 days' notice; nobody loses an assistant they use.

**Needed in code before any of this:** a per-plan list of allowed assistants (`master_plans.features.assistant_roles`
read through `hasFeature`, never a tier-key list), enforced in hire-assistant, role swap and chat; pricing page and
plan cards from `plan_features`; terms 5.2 / plan copy; help article tables from `{{plans.*}}` tokens. Separately,
lower or tier the chat fair-use limit, or switch on basic-work charging as already decided.

## 5. Phased build

**Phase 0 — decisions and plan plumbing (no new assistant).** Owner decisions (§6). Per-plan assistant list +
enforcement + tests; new master_plans rows (hidden until launch); pricing page and help copy; terms update and 30-day
notice drafted; Admin customer-health list (Reading A).

**Phase 1 — Reviews & Reputation.** Wrap existing review requests and Audience ▸ Reviews in the new role (set-up,
chat route, dashboard, cards). Add triggers (Won lead, manual list/CSV), reply drafting for pasted reviews, theme
summary, "review → social post" when Social is live. Phase 1b: Google Business Profile connection (read + reply; needs
Google approval — fold into the Calendar/Gmail Google project work).

**Phase 2 — Client Onboarding.** Clients board, welcome packs per service, Form Builder chasing, kick-off booking,
check-ins via the Onboarding flow cadence.

**Phase 3 — Repeat Business.** Service intervals on products, rule-based health labels, due/lapsed suggestions,
win-back and referral drafts through Email Flows, results the business confirms.

**Phase 4 — First-Line Support from the inbox.** After the Email Assistant's Gmail/Outlook approval: read, sort,
draft; FAQ suggestions to the Website Assistant and Knowledge Base.

**Phase 5 — launch the plans.** Customer Care and Whole Team on sale; Marketing & Sales replaces £69 for new
subscribers; existing customers snapshotted; Mentor suggestion rule for the next stage; What's New email.

Each phase: staging first, SQL on both DBs before deploy, help article, Results-tab goal metric, owner test in a real
workspace before prod.

## 6. Decisions for the owner

1. **Which reading:** build Customer Care assistants for customers (B) and keep our own retention as Admin work (A)?
   *Recommendation: yes.*
2. **The four assistants:** Reviews & Reputation, Client Onboarding, Repeat Business, stronger First-Line Support —
   and in that order? (The paste's "Adoption Coach" is dropped: for our customers it overlaps the Business Mentor.)
3. **Names:** keep the catalogue names (Reputation Management Assistant, Client Onboarding Assistant) or plainer ones
   (Reviews Assistant, Welcome Assistant, Repeat Business Assistant)? And the stage name: "Customer Care"?
4. **"Email Assistant" in both plans:** did you mean the Email Marketing Assistant (newsletters and flows), the new
   Email Assistant (Gmail/Outlook inbox), or both? *Recommendation: both, in both stage plans.*
5. **Plans and prices:** £29 Single / £69 Marketing & Sales / £49 Customer Care / £129 Whole Team, with the task
   allowances in §4.3?
6. **Existing £69 customers:** keep every assistant at £69 (snapshot), or move them to Whole Team at a loyalty price
   after notice? *Recommendation: keep them as they are.*
7. **Accounts Receivable Clerk:** in Customer Care now, or hold for a later "Run the business" stage?
8. **Automatic sending:** may an owner let one low-risk kind of message (e.g. review thank-yous, rebook reminders)
   send without a yes each time, after approving the first few? *Recommendation: yes, per kind, off by default.*
9. **SMS:** leave out (email only) for now, or plan it as paid add-on credits? *Recommendation: leave out.*
10. **Chat cost risk:** lower the fair-use limit per plan, or bring forward the decided basic-work charging, before
    adding more assistants to any plan?
11. **VAT:** are plan prices VAT-inclusive? (Changes the margin figures by a sixth.)
12. **Dogfooding:** run Be More Swan's own customers through Reviews & Reputation and Client Onboarding first, and
    use the results on the pricing page?
