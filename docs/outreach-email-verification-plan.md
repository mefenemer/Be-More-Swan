# Outreach: check addresses before sending, and read replies and bounces — PLAN

2026-11-12. Nothing built yet. Came out of comparing the Lead Generator with a list of lead tools
(Hunter's verifier was the item we pay for but don't use). Part B (reading Gmail and Outlook)
added the same day at the owner's request.

**Goals:**
- **Part A:** never send a first outreach email to an address that doesn't exist.
- **Part B:** see what happens after we send — bounces, replies that skip our Reply-To address,
  out-of-office notes — by reading the customer's mailbox, with their permission.

Part A prevents; Part B detects. Each works without the other, and they share one result on the
lead (`data.emailCheck`).

## Why it matters more for us than for most tools

- Outreach sends from the **customer's own mailbox** (Gmail / Outlook), not ours
  (`outreach-sends-from-tenant-mailbox`). Every bounce counts against *their* domain's
  reputation, and a few bad weeks can push their normal email into spam.
- **We can't see bounces today.** A bounce goes back to the sender's mailbox, not to our Reply-To
  address, and our Google access is `gmail.send` only (Outlook: `Mail.Send`). So today a dead
  address fails silently: the follow-ups keep going to it, and the user never learns why nobody
  replied. Part B changes this for customers who allow it.
- Our addresses go stale: scraped from pages that may be years old, or bought from Hunter at
  enrichment time and sent weeks later.

So checking before sending is the only protection available to everyone, including customers
who don't allow reading.

---

# Part A — Check the address before the first email

## 0. What exists today

| Piece | Where | Now |
| --- | --- | --- |
| First-email send | `netlify/functions/lead-generation.ts` `send_outreach` (~line 1340) | Gates in order: do-not-contact → suppression → personal inbox → postal address → generate → send. Bulk send (`lead-bulk-send.js`) and chat go through it. |
| Follow-ups | `netlify/functions/process-sequence-sends.ts` | Only for threads that already had a first email (line ~367: "a cadence already in flight never passes through it again"). |
| Hunter | `src/lib/discovery-enrich-provider.ts` | `domain-search` and `email-finder` only. Keeps `confidence`; ignores each email's `verification` field. No `email-verifier` call anywhere. |
| Bulk skip wording | `src/components/lead-bulk-send.js` `WHY` map | Maps each `reason` to a sentence. |
| Contact column | `src/config/lead-contact-state.ts` | reachable / nonePublished / notAttempted / pending / missed. Nothing for "address doesn't work". |
| Cost logging | `logServiceCost(...)` | Feeds the System Map cost view. |

## 1. Two checks: free first, then Hunter

**1a. Free check (every address):** syntax, then a DNS MX lookup on the domain (Node `dns.resolveMx`,
falling back to an A record as mail servers do). No mail server → the domain can't receive email:
`invalid`. This alone catches closed companies and lapsed domains, at no cost.

**1b. Hunter verifier (paid):** `GET https://api.hunter.io/v2/email-verifier?email=…` for addresses
that passed 1a and have no fresh result.

| Hunter `status` | Our result | What happens |
| --- | --- | --- |
| `valid` | works | send |
| `invalid` | doesn't work | **blocked** (see 3) |
| `accept_all` | can't be checked (the domain accepts everything) | send, marked "can't be checked" |
| `webmail` | works (personal webmail) | send; the existing personal-inbox gate still applies |
| `disposable` | doesn't work | blocked |
| `unknown` | can't be checked | send, marked |

- HTTP 202 means Hunter is still checking: retry once after a few seconds, then treat as
  `unknown`. Don't hold the user's send for longer.
- ⚠️ **Any non-2xx is an error, never a verdict** — same rule as `lookupHunter` (lesson from
  `hunter-quota-exhausted-silently`). 401/429 (bad key / out of credits) must not mark addresses
  as dead. On error: fall back to the 1a result, send, log it, and raise a System Map health
  warning so an empty Hunter balance is noticed the same day.
- Log each call with `logServiceCost('hunter-email-verifier', 1, …)`.

**1c. Free results we already get:** Hunter's domain-search returns a `verification`
`{ status, date }` on each email (check against a saved response before relying on it). Store it
when we buy the address. A Hunter-verified address less than 30 days old needs no second check.

## 2. When to check

- **Ahead of time:** when a lead moves to Outreach (`outreachStage` set, or approved). A background
  check, so the address is already known to work by the time anyone presses Send. Most sends
  then need no call at all.
- **At send time, in `send_outreach`:** a new gate **after** suppression and **before** the
  personal-inbox gate and generation (no point writing an email to a dead address). It reuses a
  result under 30 days old; otherwise it checks now.
- **Not on follow-ups.** They go to an address that already passed. The exception: if the
  thread's address has changed (see `lead-thread-contact-email-goes-stale`), the new address is
  checked like a first email.
- **Not on replies** to someone who wrote to us (`lead-threads.ts`): they just proved the address
  works.

## 3. What a "doesn't work" result does

- `send_outreach` returns `{ sent: false, reason: 'address_invalid', to }`. Bulk send lists it as
  "Skipped: the address doesn't work" (add to the `WHY` map) and carries on with the rest.
- The lead keeps the address (for the record) but is marked. Contact column shows **"Address
  doesn't work"** — a new state in `lead-contact-state.ts`, counted as not reachable.
- **Try the next address for free:** enrichment often found more than one (`foundEmails`, Hunter's
  `people`). Pick the next best with `pickBest` minus the dead one, check it, and offer it:
  "info@… doesn't work. We found sales@… instead, which does." The user confirms; we never swap
  silently. If there's no other address, the next step offers the existing **Look again**.
- **Addresses the user typed themselves** (`emailSource` manual): warn and allow **Send anyway**.
  They may know something we don't. Never a hard block on their own input.
- Ledger event `email_verified` with the result (no address in the payload), so Results can show
  "4 dead addresses caught this month".

## 4. Storage (no migration)

On the record: `data.emailCheck = { addressHash, result, source: 'mx'|'hunter'|'hunter_search', checkedAt }`.

- The **hash** of the address, not the address: if the address changes, the hash no longer matches
  and the result is ignored. Nothing new to redact on erasure, but add `emailCheck` to
  `prospect-erasure.ts`'s cleared fields anyway (it's about a person) and a test for it.
- No result cache shared between workspaces. It would save a few credits, but mixing data across
  workspaces isn't worth it.

## 5. Showing it — GUI and chat (parity rule)

- Contact cell: a small tick for "works", a warning for "can't be checked", red for "doesn't work".
- Lead panel: "Address checked 12 Nov — works" and a **Check address** button (free to the user).
- The email preview before sending shows the same line.
- Chat: "is this address OK?" returns the same result, and the chat's send card refuses an invalid
  address with the same reason as the button (it calls the same server action).
- Help article (SQL on both DBs at release) explaining the three results, and that "can't be
  checked" is common for small businesses whose mail server accepts everything.

## 6. Cost and who pays

- **No task charge to the user.** Checking is part of sending a good email, which already costs
  an `outreach_email` task. The cost is ours.
- Hunter bills verifications from the same balance as searches (check the current rate on our
  plan; we're on Starter, 2,000 credits/month, shared by every workspace).
- **Before building, size it:** count first emails sent in the last 30 days on prod
  (`outreach_sent`, step 1, in the revenue ledger), minus those that would be covered by 1c's
  free results. If that's a large share of the 2,000, budget a Hunter plan upgrade alongside this.
- Operator ceiling `EMAIL_VERIFY_MAX_PER_DAY` (default 200). Above it, fall back to the free MX
  check only, and log it. Never block sending because the ceiling was hit.

## 7. Tests

- Gate order in `send_outreach`: DNC and suppression still run first; an invalid address never
  reaches generation.
- Each Hunter status maps as in the table; 202 → one retry → unknown; 401/429/timeout → error,
  never `invalid`.
- MX: domain with no MX and no A → invalid; A only → passes.
- A result older than 30 days or for a different address hash is ignored.
- User-typed invalid address → warning + Send anyway; scraped/bought → blocked.
- Bulk send skips with the new reason and carries on.
- Erasure clears `emailCheck`.

## 8. Phases (Part A)

1. **Free MX check + gate + Contact state + bulk wording.** Catches dead domains at no cost.
2. **Hunter verifier**, ahead-of-time check on move to Outreach, store domain-search `verification`.
3. **Next-best address offer**, chat card, Results count, help article.

---

# Part B — Read replies and bounces from Gmail and Outlook

## B0. What exists today

| Piece | Where | Now |
| --- | --- | --- |
| Gmail grant | `oauth-integrations.ts` `gmail` scope | `gmail.send` only. Chosen 2026-08-26 because reading scopes are **restricted** (annual CASA security assessment). This part reverses that choice, as an **opt-in second grant**. |
| Outlook grant | `src/utils/workspace-integrations.ts` `OUTLOOK_SCOPE` | `offline_access Mail.Send User.Read`. |
| Gmail send result | `src/utils/gmail.ts` `GmailSendResult` | Gmail returns the message `id` and `threadId`; **we throw them away** (`OutboundMessageInput` has no field for them). |
| Outlook send result | `src/utils/outlook.ts` | Graph `sendMail` returns 202 with no body, so we have no message id at all. |
| Replies | SendGrid Inbound Parse via the cross-domain Reply-To → `inbound-email.ts` → `recordInboundMessage` → follow-ups halted | Works only when the prospect's email program honours Reply-To. A reply sent to the From address, a colleague replying in a new email, or a forward never reaches us, **so follow-ups keep going after someone has replied.** |
| Halt reasons | `src/config/outreach-sequences.ts` | `replied`, `send_failed`, `max_steps`, `manual`, … — nothing for a bounce or an out-of-office. |

## B1. What reading gives us

1. **Bounces.** A permanent bounce (5.x.x: no such user, domain gone) marks the address "doesn't
   work" (`data.emailCheck.result = 'invalid'`, `source: 'bounce'` — the strongest evidence,
   beating any earlier Hunter "valid"), stops the follow-ups (new halt reason `bounced`), tells the
   user once, and offers the next-best address (Part A §3). A temporary bounce (4.x.x: mailbox
   full) is noted; three in a row count as permanent.
2. **Replies we miss today.** Any message in a thread we started, from anyone at the prospect's
   domain, is recorded as a reply (`recordInboundMessage`) and stops the follow-ups. Matched by
   Message-ID against what SendGrid already delivered, so nothing is counted twice.
3. **Out-of-office notes.** Recognised by headers (`Auto-Submitted: auto-replied`,
   `X-Autoreply`, `X-Autorespond`) and then wording. Not counted as a reply. The next follow-up
   waits until the return date when the note gives one (read in code from the text; never
   guessed). "No longer works here" notes mark the contact as gone, and a replacement name is
   offered only if it is printed in the note (same rule as `verifyPeople`).
4. **The user's own emails in the thread.** If the user answers the prospect directly from Gmail,
   that shows on the lead's timeline, and our follow-ups stop so we never chase on top of a
   conversation they're already having.
5. **Real numbers.** Bounce rate per workspace on the Results tab, and a warning when it passes
   3% (above that, mailbox providers start treating the sender as a spammer).

## B2. What we read, and what we never read

We read **only**:
- messages in conversations we started (Gmail `threadId`, Outlook `conversationId`);
- bounce notices from the mail system (`mailer-daemon`, `postmaster`, Microsoft's delivery
  reports) from the last 7 days, matched to one of our sends by our reference header (B3) or by
  the original Message-ID quoted inside the bounce.

Everything else in the mailbox is never fetched beyond the headers needed to decide it isn't ours,
never stored, and never sent to an AI model. We store: for a reply, the same message row we store
for SendGrid replies today; for a bounce, the code, a one-line reason and the date — not the
bounce text. No mailbox data is used for training or anything outside the lead's conversation.

This is what Google's **Limited Use** rules require, and it must be stated on our privacy page
before Google will review the app.

## B3. Groundwork (no new permission — do first)

- **Keep what Gmail already returns:** add `providerMessageId`, `providerThreadId` and
  `internetMessageId` to `OutboundMessageInput` and the thread message row. Gmail gives us the
  first two today.
- **Our reference header on every outreach send:** `X-BMS-Ref: <opaque token>` (Gmail raw headers;
  Graph `internetMessageHeaders`, which accepts custom `X-` headers). Most bounces quote the
  original headers, so this is how a bounce is matched to the right lead. The token is random and
  stored on the message row; it never contains a name, address or ID that means anything outside
  our database.
- Add `bounced` and `out_of_office_wait` to the halt/pause reasons with user wording.
- This needs no new permission and makes Part B a pure "read" job later.

## B4. Outlook (Microsoft Graph) — likely first, no audit

- Permission: **`Mail.Read`** (delegated), added to the Outlook mailbox grant as a separate,
  optional step: "Let Be More Swan see replies and bounces". Customers who don't take it keep
  sending exactly as today.
- After each send (no id from `sendMail`): look up the message in Sent Items by recipient, subject
  and time, then store its `internetMessageId` and `conversationId`.
- Watching: Graph **delta query** on the Inbox every 10 minutes for mailboxes with live
  conversations (and only those). Later, change notifications (subscriptions last about 3 days,
  then renew) if polling proves slow.
- ⚠️ To check before building:
  - whether our Azure app is a **verified publisher**. Many work tenants only let users consent
    to apps from verified publishers, and some require an admin to approve any mail-reading app.
    Both affect how many customers can switch this on;
  - personal Outlook.com accounts vs work accounts behave differently. Test both.

## B5. Gmail — two routes: Google sign-in with the audit (main), app passwords (fallback)

Reading Gmail has exactly two routes. Using IMAP instead of the Gmail API doesn't avoid the
audit: IMAP signed in through Google (OAuth) needs `https://mail.google.com/`, which is restricted
too. The only way round the audit is a password the customer creates (an app password).

### B5.1 Main route: Google sign-in + Google's review + yearly CASA (owner chose, 2026-11-12)

- **Works for every Google account type:** personal (@gmail.com, @googlemail.com, Workspace
  Individual) and business (Google Workspace on their own domain), unless a Workspace admin has
  blocked outside apps.
- **Scopes, shared with the Inbox Assistant** (`docs/inbox-assistant-plan.md` §3.1 and §6):
  - `gmail.readonly` — Part B only (replies and bounces);
  - `gmail.modify` — the Inbox Assistant (read, labels, archive, trash, drafts and send).
  Both go in **one** review, so one yearly audit covers both features. A customer who only wants
  Part B grants `gmail.readonly`; turning on the Inbox Assistant later asks for `gmail.modify`
  (incremental consent). Not requested: `https://mail.google.com/` (permanent delete) and
  `gmail.settings.*`.
- **Separate Google Cloud project for reading**, as a second, optional grant. The send app's
  approval (2026-08, `gmail.send` only) stays untouched, so a slow or failed review can't break
  outreach sending. We already run two projects, so this is a known pattern.
- **Steps, in order:**
  1. Create the reading project; consent screen with both scopes; test users only (Google caps
     unverified apps at 100 users and shows a warning screen), so we test with our own mailboxes.
  2. Privacy page updated with the Limited Use statement (B2) and the Inbox Assistant's use,
     **before** submitting.
  3. Submit restricted-scope verification: what each scope is for, and a demo video with one
     section per feature (outreach replies and bounces; Inbox Assistant).
  4. **CASA Tier 2** security assessment through an approved lab. TAC Security, the lab Google
     points to, is reported at about **$540–720 a year** per app at Google's negotiated rate
     (other labs up to about $3,000). The lab runs a security scan of the app; fixing what it finds
     is the real cost in time.
  5. Google issues approval (Letter of Assessment). **Renew every 12 months**: re-assessment and
     re-verification; calendar it from the approval date and put the yearly fee in Admin → System
     fixed costs.
- **Timeline:** submit early, because the review sets the date. Part B's Gmail reading waits for
  it (the Inbox Assistant plan's decision D2 covers whether Part B goes ahead alone first with
  `gmail.readonly`, at the price of a second review later).
- Watching: Gmail `history.list` from the last `historyId` every 10 minutes for mailboxes with live
  conversations. Later, Gmail push (`users.watch` + Pub/Sub, renewed every 7 days). Shared reader
  with the Inbox Assistant (`mail-reader/` in that plan).

### B5.2 Fallback: IMAP with an app password (personal Gmail only, if customers ask)

An app password is a 16-character password the customer creates in their Google security settings
and pastes into another app. With it we can read mail over IMAP (`imap.gmail.com:993`) with no
Google review. Cold-email tools such as Smartlead and Instantly offer this beside "Sign in with
Google".

- **Who can use it:** personal Google accounts with 2-Step Verification on. Since 1 May 2025
  Google has blocked plain password sign-in for Workspace accounts, and whether a Workspace account
  can still create an app password depends on the account and its admin. So it can't be the route
  for most business mailboxes, which are our main customers.
- **Why fallback only:**
  - setup friction: turn on 2-Step Verification, find the app-passwords page, create, paste;
  - **we'd hold a password that opens the whole mailbox and can send from it.** An OAuth token is
    limited and revocable on its own; a leak of stored app passwords would be far worse;
  - it stops working, without warning, when they change their Google password or turn off 2-Step
    Verification.
- **If built:**
  - offered only for @gmail.com / @googlemail.com addresses, behind "Can't use Google sign-in?";
  - the password is encrypted in the vault (same as OAuth tokens: one key per workspace + service,
    see `meta-vault-key-collides-per-org`), never logged, never shown again;
  - read-only use: we never send through it (outreach keeps `gmail.send`);
  - an IMAP login failure pauses reading and tells the user once ("Your Gmail app password stopped
    working — create a new one or switch to Google sign-in");
  - same B2 limits on what we read, and the same erasure and disconnect rules;
  - the IMAP reader adds a long-lived connection we don't have today; run it as a scheduled poll
    (connect, fetch new UIDs since the last one, disconnect), not an always-on connection.
- **Not before B5.1 ships**, and only if customers who can't use Google sign-in ask for it.

### B5.3 Which customers each route serves

| Account | Google sign-in (B5.1) | App password (B5.2) |
| --- | --- | --- |
| Personal @gmail.com | ✅ | ✅ with 2-Step Verification |
| Workspace (own domain on Google) | ✅ unless admin blocks outside apps | ⚠️ often unavailable since May 2025 |
| Own domain on Microsoft 365 | — use Outlook (B4) | — (Microsoft has switched off password IMAP for work accounts) |

To size this from real data: when a Gmail mailbox connects, record whether it is a Workspace
account (the domain's mail servers point to Google, or Google's `hd` claim if we ask for the
`openid email` scopes) — counts only, no addresses.

## B6. How the user turns it on — GUI and chat

- The mailbox card (Connections, and the Outreach tab's "connect your inbox") gains a second
  switch: **"See replies and bounces"**, explaining exactly what is read (B2) in one paragraph.
- Off for every existing workspace until they turn it on. Offered once, at the moment it would
  have helped: "A follow-up went to someone who had already replied — turn on reply reading so
  this can't happen again." (Only shown when we actually know that happened.)
- Chat can explain it and hand over a "Turn on" button that opens the same consent step. Chat
  can't complete an OAuth sign-in itself.
- Disconnecting the reading grant stops reading at once and deletes the stored history position.
  Messages already recorded on leads stay, as SendGrid replies do today.

## B7. Privacy and paperwork

- Privacy policy: what we read from a connected mailbox, why, Limited Use statement, how to turn
  it off. Terms update if needed (and the in-app terms prompt, as with every terms change).
- `prospect-erasure.ts` covers bounce records and any replies read this way (same tables as
  today, plus the new message fields).
- `workspace-export.ts` includes the new message fields.
- No new subprocessor: Google and Microsoft are already the customer's own providers.

## B8. Tests

- A permanent bounce matched by `X-BMS-Ref` marks the address invalid, halts follow-ups with
  `bounced`, and notifies once; a temporary bounce doesn't, until the third.
- A bounce we can't match to one of our sends is ignored and never stored.
- A reply that arrived by both SendGrid and mailbox reading is recorded once.
- Out-of-office: not counted as a reply; follow-up moved to the stated return date; no date → the
  normal schedule.
- A message outside our conversations is never stored (assert on what the reader keeps).
- Turning the grant off stops the poller for that mailbox on the next run.

## B9. Phases (Part B)

1. **Groundwork** (B3): store message ids, add the reference header, new halt reasons. No new
   permission. Can ship with Part A Phase 1.
2. **Outlook reading** (B4) after the publisher check.
3. **Gmail reading** (B5.1): start the Google review and the CASA booking early, because they set
   the timeline; build alongside, on the reader shared with the Inbox Assistant.
5. **App-password fallback** (B5.2) — only if personal-Gmail customers ask.
4. **Out-of-office, "left the company", bounce rate on Results** (B1 points 3–5).

## Decisions for the owner (Part B)

1. **Gmail route** — ✅ owner 2026-11-12: Google sign-in + review + yearly CASA (B5.1), one review
   shared with the Inbox Assistant. App passwords (B5.2) as a personal-Gmail fallback only, built
   only if customers ask.
2. **Separate Google project for reading** — recommended (protects the approved send app). Open.
3. **Off by default, offered when it would have helped** — recommended. Open.
4. **Ship Part B's Gmail reading alone first, or wait for the shared review** — see
   `docs/inbox-assistant-plan.md` decision D2. Open.

## Release checklist

- `HUNTER_API_KEY` already set on both sites (same key).
- 30-day count of first emails done (A6) before Part A Phase 2 goes live.
- Help article SQL on both DBs at release (Part A, and again for Part B).
- Part B: Azure `Mail.Read` added to the app registration; the new Google project's consent screen
  and verification approved; privacy page updated **before** the Gmail review is submitted.
- Do not mention reading on public pages or `/connections` until it is live on prod.
