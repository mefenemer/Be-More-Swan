# Website Sales Chat — Plan

Owner request 2026-10-31, from a ReStructure AI Short ("AI sales line": a visitor talks to an AI
version of the owner, it answers questions, checks fit, then sends them to checkout or books a call).
Status: **scoped, nothing built.** Decisions in §8 are open.

## 1. What it is

A question-and-answer chat on the customer's website. A visitor asks about services, prices, opening
hours or availability. The assistant answers **only from what the business has told us**, asks up to
three fit questions the owner wrote, and ends in one of four places:

| Ending | What happens | Built on |
| --- | --- | --- |
| Book | Link into `/_book` with the service already chosen | `site-booking.ts`, `bookings.ts` |
| Buy | Link to the product's hosted Stripe Checkout | `site-shop.ts startCheckout` |
| Hand over | Name + email (+ phone) saved as an enquiry, owner notified | `site_enquiries` |
| Nothing | Visitor leaves; the conversation is kept for the owner to read | new table |

It never takes payment, never quotes a price or a time that isn't in Products & Services or the
booking engine, and never promises anything on the owner's behalf.

## 2. What already exists — reuse, don't rebuild

- **Hosted sites** (`site-render.ts`, `site-serve.ts`) — ⚠️ principle: **no JavaScript on customer
  sites** (website plan §5.2, booking plan §3). The booking flow already proves a multi-step
  server-rendered flow works (`/_book`, GET forms, one POST).
- **Grounding:** Business Information, Products & Services (`org_products`, prices, durations),
  opening hours (`booking_settings`), FAQ sections on the site, the site page directory
  (`loadSiteDirectoryBlock`), Brand Knowledge, intro offer (`intro-offer-free-trial`).
- **Enquiries** (`site_enquiries`) + owner email to the account's `users.email` + the rule that
  enquiries never join the Audience (asking ≠ marketing consent).
- **Embed precedent for non-hosted sites:** `widget.js` (Shadow DOM, public key, `/api/widget/:key`).
- **Model picker per role**, moderation (`src/utils/moderation.ts`), fair use (`fair-use.ts`),
  work metering (`work-metering.ts`).
- **Tracking:** `/go/` links and `?lt=` lead credit (campaign attribution), `site_orders`,
  `bookings`, `revenue_events`.

## 3. Design

### 3.1 Owner: the Website Assistant
It's the Website Assistant's capability (it owns the site, bookings and the shop). If the Lead
Generator is ACTIVE, a hand-over also lands in its pipeline as a warm lead; if not, it stays an
enquiry on the Website tab (teammates-must-be-active rule).

### 3.2 Two ways onto a page
1. **Hosted sites — no JavaScript.** A new `ask` section ("Have a question?") with a text box that
   GETs `/_ask?q=…`. `/_ask` is a server-rendered conversation page: each turn is a form POST, the
   reply renders on the next page, the transcript is shown above the box. Works without scripts,
   on every phone, and passes the site CSP unchanged.
2. **Any other website (phase 3).** `ask.js`, built like `widget.js`: Shadow DOM, a floating button,
   the same `/api/ask/:key` endpoint. Optional; only for workspaces with their own site.

### 3.3 The conversation
- First line, always: *"You're chatting with [business]'s AI assistant. It can answer questions
  and help you book; a person reads every enquiry."* Disclosure is not optional (EU AI Act Art. 50
  transparency duties apply from 2 Aug 2026; the UK CMA/ASA treat hidden bots as misleading).
- System prompt = grounding blocks (§2) + expert craft for a front-of-house salesperson (rule:
  assistants are experts in their role) + hard rules: no invented facts, unknown → "I'll ask
  [owner name] and they'll email you", no discounts beyond the configured offer, no medical /
  legal / financial advice beyond what the business wrote.
- **Fit questions:** up to 3, written by the owner in setup (e.g. "What's your budget?",
  "Which area are you in?"). Answers are saved on the enquiry; the model can say "this probably
  isn't for you" only on a rule the owner wrote.
- **Endings** are links the server builds from real ids (product id → checkout, service id →
  `/_book?service=`), never URLs the model writes (same idea as `groundLinks`).
- Turn cap per conversation (rec. 12), then "Leave your details and [owner] will reply".

### 3.4 Owner side (GUI + chat parity)
- Website tab ▸ **Conversations**: list with outcome (booked / bought / handed over / none),
  transcript, "Reply by email" on hand-overs.
- Setup: on/off, greeting, fit questions, hand-over contact fields, opening line wording.
- Chat card `sales_chat_setup` hits the same endpoint as the setup form.
- Notification `site_chat_handover` (reuses the enquiry notification path).

### 3.5 Safety and abuse
- Rate limits: per truncated IP, per conversation, per site per day (cap in `platform_config`).
- Moderation on every visitor message; prompt-injection rules (visitor text is data).
- Over cap, out of tasks, or the model fails → the page shows the ordinary contact form. The
  visitor never sees an error.
- No account, no cookies beyond a signed conversation id in the form (no consent banner needed).

### 3.6 Privacy
Visitor messages are personal data the business controls; we process them. Keep transcripts
**90 days** (rec.), then delete; hand-overs keep only the enquiry. Add to `workspace-export.ts`,
the data inventory and the hosted-site privacy notice. Never the Audience.

## 4. Data model (SQL before code)
`db/z-site-chat.sql`:
- `site_chats` (id, organisation_id, site_id, started_at, last_at, turns, outcome
  `none|booked|bought|handed_over`, booking_id, site_order_id, site_enquiry_id, fit jsonb,
  source_path, lt / campaign link id).
- `site_chat_messages` (chat_id, role `visitor|assistant`, body, created_at).
- `site_enquiries.chat_id` nullable.
- Setup lives in the Website Assistant's setup answers (no new table).

## 5. Cost

| Item | Rec. |
| --- | --- |
| Model | Haiku-class via the role's model picker (a visitor waits on a page load; keep replies < ~8 s) |
| Tasks | **1 task per conversation that reaches its 2nd visitor message** (one-line visits are free) |
| At task cap | Falls back to the contact form; owner gets one "chat paused" notice |
| Rough model cost | ~£0.002–0.01 per conversation |

## 6. Measuring it
Every chat records its ending, so the Website tab (and the morning summary, see
`docs/morning-summary-plan.md`) can say: "12 chats → 3 bookings, 1 sale (£45), 2 enquiries".

## 7. Build order
1. SQL + `site-chat.ts` (prompt, grounding, endings, caps) + tests pinning "no invented link".
2. `/_ask` page + `ask` section on hosted sites; Conversations tab; setup + chat card; help article.
3. `ask.js` for customers' own websites.
4. Lead Generator hand-off (when active) and Mentor reads chat outcomes.

## 8. Decisions for the owner
- **D1** Owner role: Website Assistant (rec.) or a new "Sales Assistant" seat?
- **D2** Metering: 1 task per conversation from the 2nd message (rec.), or free under fair use?
- **D3** Hosted sites only first (rec.), or `ask.js` for external sites in the first release?
- **D4** Transcript retention: 90 days (rec.)?
- **D5** Plans: every plan with the Website Assistant (rec.), or £69+ only?
- **D6** Name in the product: "Website chat" / "Ask us" / "Sales chat"?

## 9. Selling it — what can and cannot be claimed
Can: "answers visitors' questions from your own business information and sends them to book or buy".
Cannot: "closes sales for you", "sounds like you" (no voice), "24/7 human-quality support", or any
conversion figure until we have measured one.
