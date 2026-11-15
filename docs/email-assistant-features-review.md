# Email Assistant — features review (feature request #37)

2026-11-15. **Review only; nothing built from it.** For the owner to read and decide (§7). Builds on
`docs/email-assistant-plan.md` (all D1–D12 taken 2026-11-12; Phase 1 Outlook and Phase 3a Gmail built on
staging, read-only) and `docs/email-assistant-phase0.md`.

The ask: the owner pasted an AI-written market summary of "what people want and pay for in AI email
assistants" and asked *"Thoughts?"*, and how to make ours more disruptive.

---

## 1. Short answer

- **About half the list describes a different product.** Warm-up, sender score, throttling, mailbox rotation,
  enrichment for outbound and "research agents scanning Reddit/LinkedIn" are **cold-outreach tool** features
  (Smartlead, Instantly, Clay). They help someone send thousands of emails to strangers. The Email Assistant looks
  after **one person's own mailbox**. Where those features belong at all, they belong in the Lead Generator or Email
  Marketing, and several are already there.
- **The inbox half is mostly in the plan already**: sorting and priority (built), drafts in the business's voice,
  approval before anything is sent, docked chat beside the work.
- **What people actually pay for** (Fyxer, Superhuman, Shortwave) is three things: fewer emails to look at, a draft
  ready when they open the email, and nothing important missed. The most common complaints are drafts that need
  heavy rewriting and sorting that buries something important. **No product on the market knows the business**: its
  prices, its booking calendar, its leads, who its customers are.
- **That is our disruptive angle, and we already own the parts.** An enquiry arrives; one card offers a reply with
  real prices and the booking link, a lead record, and a follow-up reminder, all done with **one approval**. Section 4.
- **Price is an advantage too.** Competitors charge $30–50 per person per month on top of Workspace or 365. Ours is
  on every paid plan, limited by the task meter (D11).

## 2. The pasted claims, one by one

| Claim | Verdict | Why |
| --- | --- | --- |
| Expands shorthand ("yes thurs 2pm £80") into a full email in the user's style | **Already planned; add two things** | Chat already takes "reply to Jo saying yes" (§5.2). Add: (a) a **"Tell it what to say"** box on every email in the GUI, so this isn't chat-only (parity); (b) learning style from the user's **Sent** mail, not just "Your brand" (§5). |
| Triage and intent routing | **Already planned, partly built** | Categories and priority are built (Phase 1, `email-sort.ts`). "Routing" to other assistants is planned for Phase 5; **pull it forward** (§5). |
| Automated enrichment for personalised outbound | **Belongs in the Lead Generator** | Already there: Hunter and `lead-intel.ts`. In the inbox the useful version is small: "who is this?" on a **new enquiry**, using the Companies House client we already have. Later. |
| Deliverability: warm-up, sender score, throttling | **Skip warm-up and score; volume caps belong in the Lead Generator** | Warm-up exists to make bulk cold sending look human; we never bulk-send from this mailbox. `deliverability.ts` deliberately has **no spam score** (no honest model exists). The real risk is the Lead Generator sending outreach from the customer's main mailbox, already flagged in `lead-triage-review-split-plan.md` (volume cap, dedicated domain). One small inbox add: an SPF/DKIM/DMARC **check of the user's own domain** at connect, as named findings, because a reply that lands in spam is a lost customer. |
| Send-time optimisation ("15–20% open lift") | **Belongs in Email Marketing; skip for replies** | A reply should go when it's ready. Open-rate figures have been unreliable since Apple Mail Privacy Protection (2021) pre-loads tracking pixels, so the claim can't be checked. Newsletters already have send time and timezones. A plain **Send later** on a reply is worth adding if both providers support it cleanly. |
| Multi-agent orchestration: research agent scans Reddit/LinkedIn → drafting agent | **Already exists in the Lead Generator** | The Discussions tab (live on prod 2026-11-11) listens on Reddit and LinkedIn and drafts replies the user posts. Inside the inbox, "multi-agent" should mean hand-offs between **our** assistants (§4). |
| Cross-channel execution (email + social request + landing page from one approval) | **Campaign Orchestrator's job; a small inbox version is the angle** | The Orchestrator already issues Orders across assistants. For the inbox, one approval should do the 2–3 obvious things an email needs (§4), not launch campaigns. |
| Proactive mailbox rotation | **Skip** | Spreading cold mail over many look-alike domains to stay under spam filters. Against the spirit of Gmail/Yahoo's sender rules, and meaningless for one person's inbox. Never claim it. |
| Split-pane chat + canvas editing | **Already have** | Docked chat pane (`chat-pane.js`, `tabChat`) across Emails, Review and Clean-up; Review shows the draft beside the original with Shorter / Longer / Redraft. |

## 3. What the market charges and does (Nov 2026)

Prices are per person per month in US dollars, from third-party trackers that disagree with each other: **check the
vendor's page before quoting any of them publicly.**

| Product | Price | What it does | Common complaints |
| --- | --- | --- | --- |
| Gmail with Gemini | Included in Workspace Business (Standard ~$14) | Help me write, suggested replies, thread summaries, side panel | Generic; no draft waiting for you; not on delegated (shared) inboxes |
| Copilot in Outlook | Copilot Business add-on ~$18–21, plus a 365 plan | Draft, summarise, coach; agents | Extra seat cost; knows Microsoft files, not your prices or bookings |
| Superhuman | Starter ~$25–30; Business ~$33–40 (Auto Drafts here) | Fast client, split inbox, auto drafts, ask AI | Price; a new mail app to learn |
| Shortwave | Free tier; paid ~$18–45, more for Max | Gmail client, AI assistant, AI filters | Mainly Gmail; prices rose ~25% in June 2026 |
| Fyxer | ~$30 (one inbox) / ~$50 (several, chat, HubSpot) | Sorts in your own Gmail/Outlook, drafts in your tone, meeting notes | Drafts need heavy rewriting; rigid sorting buries mail; Outlook weaker; billing surprises |
| SaneBox | ~$7–43 depending on plan | Sorting and "SaneLater" only, no drafts | Sorting only; prices change often |
| Missive | ~$14–36; AI on your own OpenAI key | Shared team inbox, comments, AI drafts | AI costs extra and is DIY |
| Front | ~$25–105 plus AI add-ons ~$20+ | Shared inbox for support teams, rules, SLAs | Expensive; built for support teams, not a five-person business |

What this tells us:
- **Fyxer is the closest model** (works inside the user's own Gmail/Outlook, drafts waiting) and our plan already
  matches it. Its weak points (rewrites, buried mail, Outlook) are where we can be better: real facts, the
  `[check: …]` rule, measured Results, Outlook built first.
- **Nobody joins the inbox to the rest of the business.** That is the gap.

## 4. The disruptive angle: an inbox that knows the business

Every competitor's AI knows only the email. Ours can know what every other assistant knows, and act across them with
one approval. All of these use parts we already have:

| Email that arrives | What one card offers (one approval) | Parts we have |
| --- | --- | --- |
| New enquiry: "how much for a family portrait session?" | Reply with the **real price** from Products and the **booking link**; add the sender to the Lead Generator as a **warm, inbound** lead (never cold-contacted); remind me in 3 days if no answer | Products + prices (GBP/USD/EUR…), booking link (booking plan), Lead Generator, "Waiting on others" (§2.3) |
| Existing customer or booking guest | Shown as **Customer**, with their last booking or stay beside the email; reply uses it | Bookings, holiday lets/stays, leads marked won, Audience |
| Reschedule request | Reply offering 3 real free slots from the booking calendar | Bookings, Outlook/Google calendar grant |
| "Still waiting for that invoice?" or a payment reminder | Hand to **Accounts Receivable** | AR clerk drafts chases |
| A meeting follow-up | Link to the **Meeting Note Taker** notes and action items; reply lists them | Meeting Note Taker |
| The same question keeps arriving | Monthly suggestion: "8 people asked about parking. Add it to your website FAQ?" | Website Assistant, Blog Writer, Help-style FAQ blocks |

Rules that stay:
- **Approval-only.** The card lists every action it will take (reply text, recipients, lead record, reminder) with
  untick boxes; nothing happens until the user presses one button. No action that sends, books or contacts a third
  party happens silently.
- **GUI and chat parity.** The card appears in Review and in the docked chat; both POST the same server action. Chat
  can say "reply to the parking enquiry with the booking link and add her as a lead" and get the same card.
- **Facts are never invented.** Prices, slots and policies come from our own records; anything missing is a
  `[check: …]` gap that blocks Send.
- **Privacy.** Email content stays in the owner's private Review and chat, never Team Chat. A personal mailbox never
  hands off. The FAQ suggestion uses paraphrased questions and counts, business mailbox only, and is opt-in.
- **What we measure, not claim:** "enquiries answered within an hour", "enquiries that became bookings", time to
  reply. No "hours saved" unless computed.

A note on **quotes**: we have no quote feature today. v1 is a reply that quotes product prices. A proper quote
document (line items, valid until, accept button) is a separate feature and a decision (§7, item 4).

## 5. What to add to the existing plan's phases

- **Phase 2 (actions with approval):**
  - **"Tell it what to say"** box on every email (GUI twin of the chat request).
  - **Customer and lead matching** (deferred from Phase 1): sender checked against bookings, stays, won leads,
    Audience. Everything in §4 depends on it.
  - **Style from Sent mail:** read the user's last ~200 sent emails once to build a short style profile (greetings,
    sign-off, length, formality); store the **derived profile only**, never the bodies; shown and editable in
    Settings. Covered by `Mail.ReadWrite` / `gmail.modify`; add a line to the privacy wording and DPIA, and to the
    Google demo video.
  - **Send later** on a reply, if Gmail and Graph both support it without workarounds; otherwise drop it.
- **New Phase 2b, "Enquiry card"** (pulled forward from Phase 5's hand-offs): the one-approval card in §4 for new
  enquiries and customers first; AR and Meeting Note Taker hand-offs after. Inbound leads are flagged so the Lead
  Generator never puts them into a cold sequence. Requested-by pills show where the work came from.
- **Phase 3 (Gmail, connect):** domain check (SPF/DKIM/DMARC) at connect, as named findings in the style of
  `deliverability.ts`, no score.
- **Morning summary "Email" section** (already planned): add "1 enquiry unanswered for over a day".
- **Results tab:** add "Enquiries answered within an hour" and "Enquiries that became bookings".
- **Later (after launch):** "who is this?" for new enquiries (Companies House); the FAQ suggestion; quote documents
  if decided.
- **Lead Generator, separately:** the outreach volume cap and dedicated-domain route already flagged in
  `lead-triage-review-split-plan.md` answer the pasted deliverability points better than warm-up would.

**Public copy:** nothing on the assistant page, pricing or `/connections` until live on prod. Never say "warm-up",
"deliverability management", "open-rate lift" or "hours saved" for this assistant. Don't name competitors' prices
publicly without checking them on the day.

## 6. Cost of the additions

- Style profile: one AI call per mailbox at connect, then monthly. Small.
- Enquiry card: the reply draft is already `email_reply_draft` (1 task); the lead record, reminder and booking link
  are free. No new task key needed.
- Matching and domain check: no AI.
- FAQ suggestion: one monthly AI call per business mailbox; free or folded into background work.

## 7. Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Keep cold-outreach features (warm-up, rotation, sender score, enrichment) **out** of the Email Assistant? | **Yes.** Lead Generator owns volume caps and enrichment; rotation and warm-up are never built. |
| 2 | Make "the inbox that knows the business" (§4) the lead story for this assistant? | **Yes.** It's the gap no competitor fills and uses parts we have. |
| 3 | Pull hand-offs forward from Phase 5 into a new **Phase 2b Enquiry card**? | **Yes**, enquiries and customers first. |
| 4 | Quotes: reply-with-prices only, or a proper quote document later? | **Reply-with-prices for v1**; log the quote document as its own feature request. |
| 5 | Learn writing style from Sent mail (derived profile only, editable)? | **Yes**, with the privacy page, DPIA and Google demo updated before Gmail submission. |
| 6 | Add the domain check (SPF/DKIM/DMARC) at connect? | **Yes**, findings only, no score. |
| 7 | "Same question keeps arriving" FAQ suggestion? | **Later, opt-in**, business mailbox only. |
| 8 | Send later on replies? | **Only if** both providers support it cleanly; otherwise skip. |
