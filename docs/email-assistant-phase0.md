# Email Assistant: Phase 0 Pack (paperwork before any code)

2026-11-12. Phase 0 of `docs/email-assistant-plan.md` (§10). Everything here is a **draft for the owner to
approve**: nothing has been published, sent, created in a console or changed in the app.

| Phase 0 item | State |
| --- | --- |
| Confirm the scopes on Google's and Microsoft's own docs | ✅ Done (§1) |
| Azure verified publisher | ✅ **Verified** (owner checked 2026-11-13: MPN ID 7137838, domain bemoreswan.com) — §2 |
| Google "Be More Swan Mail" project, consent screen, scopes | Steps written (§6.2); owner creates it |
| Two CASA quotes | Request emails drafted (§7); owner sends |
| Privacy policy wording (Limited Use) | Drafted (§4) |
| DPA wording | Drafted as version 1.2 (§5); **needed**, the current DPA forbids what this does (§3.1) |
| DPIA | Drafted (§8) |
| Blockers found | 3 (§3): ✅ owner took all three recommendations, 2026-11-12 |

---

## 1. Facts confirmed on the official docs (2026-11-12)

| Question | Answer | Source |
| --- | --- | --- |
| Does `gmail.modify` allow sending? | **Yes.** `users.messages.send` accepts `mail.google.com`, `gmail.modify`, `gmail.compose` or `gmail.send`. No separate send scope needed. | developers.google.com … `users.messages/send` |
| Drafts? | `drafts.create` accepts `mail.google.com`, `gmail.modify`, `gmail.compose`. | … `users.drafts/create` |
| Trash vs permanent delete | `messages.trash`: `gmail.modify` works. `messages.delete` (permanent): **only** `https://mail.google.com/`. Google's own page says "Prefer messages.trash instead." Confirms D3. | … `users.messages/trash`, `/delete` |
| Push (`users.watch`) | Accepts `gmail.modify`, `gmail.readonly` (and metadata / full). So Part B's readonly grant can be watched too. | … `users/watch` |
| Outlook subscription lifetime | Messages: up to **10,080 minutes (just under 7 days)**; with resource data included: 1,440 minutes. Max 1,000 subscriptions per mailbox across all apps. **The plan said "under 3 days (4,230 minutes)"; corrected in the plan.** | learn.microsoft.com … change-notifications-overview |
| Outlook permission for notifications | `Mail.Read` or `Mail.ReadBasic` (delegated), so `Mail.ReadWrite` covers it. | … subscription-post-subscriptions |
| Can work tenants block unverified apps? | Admins can make publisher verification part of their user-consent policy, and with Microsoft's **risk-based step-up consent**, users "can't consent to most newly registered multitenant apps that aren't publisher verified" when the app asks for more than sign-in and profile. Mail permissions are more than that. | learn.microsoft.com … publisher-verification-overview |

## 2. Azure verified publisher

✅ **Verified** (owner checked Branding & properties, 2026-11-13): MPN ID 7137838, publisher domain
bemoreswan.com, publisher display name "Be More Swan". The repo-based guess below was wrong: the domain
was proven another way (DNS on the tenant), not by a hosted file. §6.1's partner steps are not needed.

What the repo showed (kept for the record):

- Publisher verification needs a **publisher domain** on the app, proven either by a file at
  `https://<domain>/.well-known/microsoft-identity-association.json` or by a DNS-verified custom domain
  on the Entra tenant.
- **The repo has no `microsoft-identity-association.json`**, and nothing references it. So the domain
  was not proven by file. It could still have been proven by DNS, so this isn't conclusive.
- How to check (owner, 2 minutes): Entra admin centre → App registrations → the Outlook app →
  **Branding & properties**. "Publisher verification" shows either a blue verified badge with the
  partner name, or "Add MPN ID to verify publisher".
- If not verified: steps in §6.1. Until it is, expect Microsoft 365 customers on tenants with step-up
  consent to see "Need admin approval" when they connect a mailbox. Outlook.com personal accounts are
  unaffected.

---

## 3. Blockers found (need the owner before Phase 1)

### 3.1 The DPA forbids special category data, and every mailbox has some

`get-dpa-content.ts` DPA 1.1, **clause 13**: "The platform is not designed for special category … data.
**You must not put it into the platform**, and our assistants are instructed not to use it. If it is put
in deliberately and repeatedly, we may suspend the account concerned." Annex 1 says "Special category
data: none intended".

Connecting a mailbox puts in whatever people email the business: a guest mentioning a disability, a
client's sick note, a doctor's appointment in the personal mailbox. A customer who connects their
mailbox would be in breach of clause 13 on day one, through no choice of theirs.

✅ **Decided (owner, 2026-11-12): DPA version 1.2 (§5).** It keeps the rule for what customers *put in on purpose*, and
adds a narrow exception for mail the Email Assistant reads: processed only to sort, summarise and draft
a reply at the customer's instruction; never used to infer or record a special category; never a
category or field of its own. DPA changes go to the workspace owner by email and through the
acceptance gate (`CURRENT_DPA_VERSION` in `accept-dpa.ts`), so the Email Assistant must only switch on
for a workspace that has accepted 1.2.

### 3.2 Every assistant's prompt refuses special category data, which would break this one

Two copies of a refusal clause are added to assistant prompts:
- `admin-api.ts` (~line 2287) appends `SPECIAL_CATEGORY_CLAUSE` from `get-dpa-content.ts` to **every
  master assistant system prompt**: if a message contains health information etc., reply exactly *"I
  cannot process sensitive personal information. Please remove it and resend your message."*
- `src/utils/go-live-fixes.ts` has a softer version (don't use it, carry on without it).

For the Email Assistant, the "message" is a stranger's email. With the strict clause, an email from a
guest saying "I use a wheelchair, is the cottage step-free?" would get the refusal sentence as its
summary, or as a drafted reply. The user didn't send it and can't "remove it and resend".

✅ **Decided (owner, 2026-11-12): a role-specific clause for `email_assistant` instead of the general one,** written
with the DPA 1.2 text: *"Emails you read may mention health, beliefs or other special category data
about the sender or others. Use it only as far as needed to sort the email, summarise it neutrally and
draft the reply the user asked for (for example, answering an accessibility question). Never infer a
special category that isn't stated, never put it in a category name, priority reason or note, and
never mention it anywhere except the summary and reply to that one email."* The marker check in
admin-api.ts must allow the role's own clause to replace the general one (build task for Phase 1, with
a test that the general clause never reaches the email triage/draft prompts and the role clause always
does).

### 3.3 Gmail push makes Google Cloud a new sub-processor

The Pub/Sub topic lives in **our** Google Cloud project, and each push carries the mailbox's email
address and a history number. That is personal data processed by Google Cloud on our behalf, so Google
Cloud becomes **our sub-processor**. It isn't on the list (`trust.html` sub-processors, which
`privacy.html` must match: Anthropic, OpenAI, Voyage AI, fal.ai, Stability AI, Neon, Cloudflare R2,
Netlify, AWS, Stripe, Resend, Twilio SendGrid, Serper, Pexels). DPA clause 5: **14 days' notice** to
every workspace owner before adding one. (Gmail and Microsoft themselves are not sub-processors: the
customer connected them, DPA clause 5 already says so.)

**Options:**
- (a) **Add Google Cloud (Pub/Sub, notifications only, US/EU)** with the 14-day notice, timed so it
  ends before Gmail goes to customers. ✅ **Decided (owner, 2026-11-12)**: push is near-instant and
  cheaper than polling.
- (b) No push for Gmail: poll `history.list` every 5–10 minutes. No new sub-processor, slower
  ("new mail" shows up to 10 minutes late), more function runs.

Phase 1 is Outlook only, so this doesn't block Phase 1. The notice must go out at least 14 days before
Gmail push is used with any customer mailbox (Phase 3).

### 3.4 (Check, not a blocker) Anthropic retention for email content

The privacy policy says AI providers are contractually bound not to train on our data. Email content is
more sensitive than drafts: confirm what retention applies to our Anthropic API calls (standard API
retention vs zero data retention) and state the retention period in the privacy wording (§4 has a
placeholder). If zero data retention is available on our account, recommend asking for it for the
Email Assistant's calls.

---

## 4. Draft privacy policy wording

To go into `privacy.html` §13 (the Google Limited Use section, as a sub-section like "YouTube API
Services" and "Google Calendar"), and a short Outlook paragraph. Same headings as those sub-sections.
**Publish before the Google submission** (Google reviews the live page). It is worded so it is true
before launch ("if you connect…").

> **Email Assistant (Gmail and Outlook mailboxes)**
>
> If you hire the Email Assistant, you can connect your business mailbox and, if you choose, your own
> personal mailbox, from Gmail or Outlook. You can also let the Lead Generator see replies and bounces
> to the outreach emails it sends for you. Google's and Microsoft's handling of your data is covered by
> their own privacy policies.
>
> **What we access.** For Gmail we ask Google for "Read, compose and send emails from your Gmail
> account" (`gmail.modify`), or, if you only want outreach replies and bounces, "View your email
> messages and settings" (`gmail.readonly`). For Outlook we ask Microsoft for "Read and write access to
> your mail" (`Mail.ReadWrite`) and "Send mail as you" (`Mail.Send`), or "Read your mail" (`Mail.Read`)
> for replies and bounces only. With these we read the emails in your inbox. We never permanently
> delete an email, we never change your mailbox settings, filters or forwarding, and we never read your
> contacts or calendar through this connection.
>
> **How we use it.** To sort each new email into a category, give it a priority and a one-line summary,
> draft a reply for you to approve, suggest emails to archive or move to trash, and, for the Lead
> Generator, to notice replies, bounces and out-of-office notes on outreach it sent. Nothing is sent,
> archived or moved to trash unless you approve it, either each time or through a rule you wrote and
> approved. Moving to trash can be undone for 30 days. We do nothing else with your email.
>
> **What we keep.** For each email: who sent it, the subject, the date, its category, priority and our
> one-line summary. We do **not** keep the body of your emails or any attachments: we fetch an email's
> text from your mailbox when you open it or when a reply is being drafted, and don't store it.
> Drafted replies are kept until you send or dismiss them, then for 30 days. Sorting details for emails
> older than 90 days are deleted.
>
> **AI processing.** To sort, summarise and draft, the sender, subject and text of an email (with
> quoted earlier messages and signatures removed) are sent to our AI provider, Anthropic. Newsletters
> and automatic notifications are recognised without AI and are not sent. Senders you mark as private
> are never sent to AI, not even the subject. Attachments are never sent. Anthropic is contractually
> bound not to train its models on this data [and keeps it for no longer than **{retention, §3.4}**].
>
> **Who can see it.** A personal mailbox can be seen only by you, not by your workspace's owner or
> admins. A business mailbox can be seen by you and, if you share it, the teammates you choose.
>
> **Who we share it with.** Nobody, except the service providers that run Be More Swan for us (hosting,
> our database, Google Cloud for new-mail notifications, which carry only your email address and a
> sequence number, and Anthropic as above). We never sell email data or use it for advertising, and no
> person at Be More Swan reads your email unless you ask our support team to look at a particular
> email, for security, or where the law requires it.
>
> **How we protect it.** Mailbox access tokens are encrypted with AES-256-GCM before they are stored,
> each mailbox with its own key; all traffic is encrypted with TLS; and email text is never written to
> our logs.
>
> **How long we keep it, and how to revoke access.** Press Disconnect on the mailbox (Connections ▸
> Mailboxes). We stop reading at once and delete your tokens and everything we stored from that mailbox
> straight away. Categories already written into your mailbox as labels stay, as they are yours; you
> can ask us to remove them before you disconnect. Replies and bounces already recorded on your leads
> stay with those leads. You can also remove Be More Swan's access in your Google account's third-party
> connections or at myapps.microsoft.com (account.live.com for Outlook.com). Deleting your account
> erases all of it, as described in the retention section above.

Also needed in `privacy.html`:
- §2 "What we collect" and §9 "How long we keep it": one line each pointing to the sub-section.
- §7 sub-processor table: Google Cloud row (§3.3 decided; keep identical to `trust.html`).
- The existing §13 opening sentence already lists Gmail; add "Outlook (Microsoft Graph)" in a sentence
  saying the same promises apply.

## 5. Draft DPA version 1.2 (changes only)

Version bump in `accept-dpa.ts` (`CURRENT_DPA_VERSION = '1.2'`), new `DPA_1_2_HTML` and
`DPA_EFFECTIVE_DATES['1.2']` in `get-dpa-content.ts`; 1.0 and 1.1 stay readable.

**Annex 1, Nature and purpose:** add after "reading data from the accounts you connect;":
> reading, sorting, summarising and drafting replies to the emails in mailboxes you or your users connect
> to the Email Assistant, and moving, labelling or sending them when you approve it;

**Annex 1, Categories of data subjects:** add:
> people who email you or your users at a mailbox connected to the Email Assistant, and people named in
> those emails;

**Annex 1, Types of personal data:** add:
> email headers (sender, recipients, subject, date) and the content of emails in connected mailboxes,
> which is read but not stored; summaries and categories we derive from them;

**Annex 1, Special category data:** replace "none intended — see clause 13." with:
> none intended, except as incidentally contained in emails read by the Email Assistant — see clause 13.

**Clause 13:** add a second paragraph:
> **Connected mailboxes.** Emails in a mailbox you connect to the Email Assistant may contain special
> category or criminal offence data that you did not choose to send us. Clause 13's first paragraph does
> not apply to that data. We process it only to sort the email, summarise it and draft the reply you ask
> for; we do not store email bodies; we instruct our assistants never to infer, record or label a
> special category; and senders you mark as private are never sent to an AI model. You remain
> responsible for having a lawful basis, and a condition under Article 9 where one is needed, for
> processing the emails you receive.

**Annex 2:** add:
> Mailbox access tokens encrypted with a separate key per mailbox; email bodies and attachments not
> stored; email text excluded from logs; mailbox data deleted at once when a mailbox is disconnected.

The Google Cloud sub-processor notice (§3.3, decided) goes out separately under clause 5 (14 days).

## 6. Console steps for the owner

### 6.1 Azure: publisher verification (if §2 shows it isn't verified)

1. **Microsoft AI Cloud Partner Program:** enrol at partner.microsoft.com with a work account on the
   bemoreswan.com tenant (free). Complete company verification. Note the **Partner One ID** (the
   partner *global* account, PGA).
2. **Publisher domain:** in the app registration → Branding & properties → Publisher domain, set
   `bemoreswan.com`. Either it's already a DNS-verified domain on the tenant, or Microsoft gives a JSON
   file to host at `https://bemoreswan.com/.well-known/microsoft-identity-association.json` (I can add
   that file and its Netlify route when you have the content; extensionless/dot-folder paths need a
   `netlify.toml` rule, as the waitlist work found).
3. The Partner Center verification email's domain must match the publisher domain.
4. Signed in with MFA, as Application Administrator (Entra) + Partner Admin (Partner Center): app
   registration → Branding & properties → **Add MPN ID to verify publisher** → enter the Partner One ID.
5. While there: API permissions → add delegated `Mail.ReadWrite`, `Mail.Read` (Part B) to the
   existing app (Mail.Send, User.Read, offline_access, Calendars.ReadWrite already present). No admin
   consent needed for delegated mail permissions in our own tenant; customers consent for themselves.

### 6.2 Google: the "Be More Swan Mail" project

1. console.cloud.google.com → New project **"Be More Swan Mail"** in the same organisation as the
   existing projects. Billing account linked (Pub/Sub needs it; cost is pennies).
2. APIs & Services → enable **Gmail API** and **Cloud Pub/Sub API**.
3. OAuth consent screen (Google Auth Platform): External; app name "Be More Swan"; support email; logo
   (same as the send app); app domain bemoreswan.com; privacy policy URL
   `https://bemoreswan.com/privacy.html`; terms URL; authorised domain bemoreswan.com.
4. **Data access → scopes, exactly these** (verification fails if code and console differ — the
   2026-08-26 rejection):
   - `openid`, `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.modify`
5. Audience → **Testing**, test users: our own mailboxes only (max 100). Do **not** submit for
   verification yet: that waits for the privacy page (§4) and the Phase 3 demo.
6. Credentials → OAuth client ID, Web application, redirect URIs for staging and prod (same callback
   path pattern as the existing Gmail client). Put the id/secret in Netlify as `GMAIL_MAIL_CLIENT_ID`
   / `GMAIL_MAIL_CLIENT_SECRET` on both sites (owner adds; never paste them into a chat).
7. Later (Phase 3): Pub/Sub topic `gmail-push`, grant
   `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it, push subscription
   to `https://<site>/.netlify/functions/mail-push-gmail` with authentication (service account OIDC
   token, audience = that URL).
8. Workspace admins: note the **OAuth client ID** for the admin guide (customers' admins allow it in
   Admin console → Security → API controls → App access control).

## 7. CASA quote requests (drafts, not sent)

Google's list of authorised CASA labs is on the App Defense Alliance site (appdefensealliance.dev →
CASA → authorised labs). Recommended: TAC Security (Google's negotiated rate) plus one other lab from
that list for comparison.

> **Subject:** CASA Tier 2 assessment quote: Gmail restricted scopes, web app
>
> Hello,
>
> We're Be More Swan Ltd (UK), a web app of AI assistants for small businesses. We're preparing a Google
> OAuth restricted-scope verification for a new Google Cloud project that will request
> `gmail.readonly` and `gmail.modify`, and we need a **CASA Tier 2** assessment.
>
> - App type: web application (vanilla JavaScript front end, serverless functions on Netlify, Postgres
>   on Neon). No mobile app.
> - Data: Gmail message headers and content are read on demand and not stored; derived summaries and
>   categories are stored; tokens encrypted at application level (AES-256-GCM).
> - Timing: we expect to submit to Google in [month]; assessment would follow Google's request.
> - We'd like this to renew yearly.
>
> Could you send: the price for the initial assessment and the yearly re-assessment, what's included
> (number of re-scans after fixes), typical lead time, and what you need from us (self-assessment
> questionnaire, scan access to staging, source access)?
>
> Thank you,
> [name], Be More Swan Ltd

## 8. DPIA (draft)

**Processing:** the Email Assistant and the Lead Generator's reply/bounce reading read customers'
business and personal mailboxes (Gmail, Outlook) to sort, prioritise, summarise, draft replies, and
archive/trash/send on approval.

**Why a DPIA:** large-scale processing of communications content with AI, including people who are
not our customers (senders), possibly special category data, and a new technology use. ICO screening
criteria met: innovative technology, large-scale, data concerning vulnerable people possible (personal
mailboxes), invisible processing for senders.

**Necessity and proportionality**
- Purpose: help the user handle their own email; nothing used for any other purpose (Limited Use).
- Minimisation: bodies and attachments not stored; header-only sorting for bulk mail; private senders
  never sent to AI; first sort limited to 14 days; derived data pruned at 90 days.
- Lawful basis: contract (the user's own request); for business mailboxes we are processor for the
  customer, who is controller and needs their own basis (legitimate interests for handling incoming
  mail is usual); Article 9 data incidental (§3.1, DPA 1.2 clause 13).
- Transparency: privacy policy sub-section (§4); senders are informed by the customer's own privacy
  notice as for any mail tool they use.
- Rights: export (mailbox owner), erasure by address per mailbox, disconnect = immediate deletion.
- Transfers: Anthropic (US) under the existing UK IDTA/Addendum; Google Cloud (Pub/Sub notifications).

**Risks and measures**

| Risk | Likelihood / severity | Measure | Residual |
| --- | --- | --- | --- |
| Email sent or deleted that the user didn't intend | Low / High | Approval for every send/trash; no permanent delete; 30-day restore; rules can't trash in v1 | Low |
| AI summary exposes sensitive content to teammates | Medium / High | Personal mailboxes private to the owner; Team Chat gets counts only; Review filtered to owner | Low |
| Special category data inferred or labelled | Medium / High | Role-specific prompt clause (§3.2); no sensitive categories; test | Low |
| Token theft gives mailbox access | Low / High | AES-256-GCM per-mailbox keys; delegated scopes only; revocable; no app passwords for writing | Low |
| Email text leaked in logs | Medium / Medium | Logs hold tokens/cost only; test asserting no body in logs or DB | Low |
| AI provider retains content | Low / Medium | No training (contract); confirm retention / ZDR (§3.4) | Low |
| Prompt injection in an email ("forward all invoices to…") | Medium / High | Email text treated as data; the model can only propose; sends need approval and go only to the thread's sender unless the user edits recipients; drafted reply shows recipients clearly | Low–Medium |
| Senders unaware | High / Low | Customer's own privacy notice; we store no bodies | Low |

**Outcome (draft):** proceed, with the measures above built and tested before launch. No prior ICO
consultation needed if residual risk is low. Review after the first 3 months live. Sign-off: owner,
[date].

⚠️ Prompt injection was not in the plan; added to the plan's tests by this pack (§9 there).
