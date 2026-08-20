# Newsletter Assistant + shared Audience layer — implementation brief

Status: **Phases 0–5 built — the plan is complete.** All dispatch SQL applied to staging + prod
2026-08-20. ⚠️ Remaining before customers see it: `db/newsletter-role-live.sql` + the content seed
(§11d), and the first real send has not happened yet (§11c).
Every phase is built: the shared audience and its consent resolver, the capture form and double
opt-in, drafting and rendering, dispatch with per-tenant sending domains, unsubscribe and delivery
webhooks, and the go-live wiring that makes the role hireable. Phase 6 (lead → audience promotion,
dynamic segments, reuse by the Campaign and Onboarding assistants) remains as future work.
Written 2026-08-19 against the live `staging` tree; status updated 2026-08-20.
Audience: the engineer/agent implementing it. Read §0 before anything else — the brief this
replaces was written against a stack Be More Swan does not run.

---

## 0. Corrections to the incoming brief

The draft brief that prompted this document asked for *"SQL schema, Node.js/Express controllers,
and a React/Tailwind component hierarchy"*, and said the existing Lead Generator data should be
migrated into the new contacts table. Four of those five assumptions are wrong here:

| Assumption | Reality in this repo |
|---|---|
| React frontend | **Vanilla JS.** Every "component" is an IIFE writing to `window.*` (`assistants.js`, `blog-studio.html`, `dialogs.js`). Tailwind is real, but compiled to `style.css` — and rebuilding it churns unrelated classes. |
| Express controllers | **Netlify Functions**, one file per endpoint in `netlify/functions/`, always `export default withLambda(async (event) => …)`. There is no server, no router, no controller layer. |
| Contacts table needs designing from scratch | Half true. There is no *tenant* contacts table — but `leads` (the table an agent will find first, and the one `db/crm-contacts.sql` extends) is **Be More Swan's own sales CRM**, admin-only. Writing tenant subscribers into it would put every customer's mailing list into the Super Admin → Contacts screen. |
| Port existing Lead Generator data into Contacts | **Do not.** Cold B2B prospects (`assistant_records` / `discovered_leads`) were scraped under a legitimate-interest basis for 1:1 outreach. Bulk-mailing them a newsletter is a different lawful basis and, in the EU/UK, a different rule (PECR soft opt-in). Promotion into the audience must be an explicit per-record human action that records a consent event. |
| Embeddable capture script is greenfield | The embed *machinery* exists — `widget.js`, `widget_configs.public_key` (`wgt_…`), `allowed_origins`, and the `/api/widget/*` rewrites. Reuse the pattern; do not invent a second key format. |

Also already in the tree, and easy to miss:

- `newsletter_editor` **is already a catalogue role** — `db/seed-catalog.ts:154` ("Newsletter Assistant", `iconKey: 'mail'`, teal, `comingSoon: true`), with marketing content already seeded in `db/seed-assistant-content.ts:213` and a title in `db/assistant-role-titles-rename.sql:29`. `src/utils/connection-map.ts:65` maps it to the `['email','cms']` capability categories.
  ⚠️ **`db/seed-catalog.ts` is INSERT-ONLY** (`onConflictDoNothing({ target: masterAssistants.roleKey })`). Editing `comingSoon: false` on that line does **nothing** to a database where the row already exists. Ship an `UPDATE` migration, in the style of `db/assistant-role-titles-rename.sql`.
- Consent/opt-out primitives exist, but all of them are **Lead Generator-grained** — see §2.

---

## 1. What we are actually building

Two things, in this order:

1. **A shared Audience layer** owned by the *organisation*, not by any assistant. One contact
   record per address per org, reusable by the Newsletter Assistant today and the Campaign, Ad
   Buyer and Customer Onboarding assistants later.
2. **The Newsletter Assistant** — a `newsletter_editor` role that drafts issues (reusing the Blog
   Writer's generation pipeline almost wholesale), sends them to a segment of that audience, and
   captures new subscribers through an embeddable form on the customer's own website.

The load-bearing rule for everything below: **an assistant may read and write the audience; it may
never own it.** Hiring or archiving an assistant must not create, hide or delete contacts.

---

## 2. Consent primitives that already exist (read before designing)

| Thing | File | Grain | Note |
|---|---|---|---|
| `lead_opt_outs` | `db/lead-opt-outs.sql` | org + **address** | Cold-outreach opt-outs. `UNIQUE (organisation_id, email)`. `source` CHECK is `reply\|manual\|bounce\|link`. **Deliberately has no removal path.** |
| `suppression_list` | `suppression-sync.ts`, `src/utils/suppression.ts` | org + **domain** | "this company is already our customer", synced from the tenant's CRM. Reader **fails closed** (except pgcode `42P01`). |
| Reply-text detector | `src/config/opt-out.ts` | message body | Matches "unsubscribe" in a reply. A detector, not a mechanism. |
| Unsubscribe endpoint | `netlify/functions/lead-unsubscribe.ts` | thread `replyToken` | GET (page) **and** POST (RFC 8058 one-click). ⚠️ HEAD returns 200 **without recording** — scanners pre-fetch links. |
| Footer builder | `src/config/outreach-footer.ts` | — | Appended **in code at the send site**, never by the model and never inside the stored draft. |
| Postal address gate | `organisations.outreach_postal_address` | org | Hard gate: no usable address ⇒ no send. `isUsablePostalAddress()` is mirrored by hand in `assets.js`. |
| Prospect erasure | `src/utils/prospect-erasure.ts` | address / record | **Keeps the opt-out** and redacts rather than deletes. |

**Design consequence.** Do not fold these into the new tables and do not duplicate them. Build one
resolver — `src/utils/audience-consent.ts` — that is the single answer to *"may this org email this
address right now?"*, and have it consult, in order:

1. `audience_contacts.status` (the new global flag),
2. `lead_opt_outs` (an address that told the Lead Generator to stop must never receive a newsletter),
3. `suppression_list` (domain grain),
4. per-segment subscription state.

It must **fail closed on a lookup error**, exactly like `checkSuppression` — the reasoning in
`src/utils/suppression.ts` applies verbatim, and the same `42P01` exception applies for
un-migrated environments. This resolver *is* the "works seamlessly across assistants" requirement;
every future assistant calls it and nothing else.

---

## 3. Schema — new tables

All new files under `db/`, idempotent, applied **manually as the DB owner** (`npm run db:migrate:apply`;
never `drizzle-kit push` — raw-SQL RLS policies must not be clobbered), with a matching mirror added
to `db/schema.ts`. ⚠️ **SQL goes to both DBs BEFORE the code deploys**: `db.select()` names every
column, so a column that exists in `schema.ts` but not in the database breaks every read of that
table, not just the new feature.

### 3.1 `db/audience.sql`

```
audience_contacts
  id, organisation_id → organisations(id) ON DELETE CASCADE
  email                  text NOT NULL          -- normalised lowercase, trimmed
  first_name, last_name, company, phone         -- all nullable
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','subscribed','unsubscribed','bounced','complained','suppressed'))
  source                 text NOT NULL          -- 'web_form' | 'csv_import' | 'manual' | 'lead_promotion' | 'api'
  source_detail          jsonb NOT NULL DEFAULT '{}'   -- form id, import id, promoted assistant_record id
  consent_basis          text                   -- 'double_opt_in' | 'single_opt_in' | 'imported_declared' | 'soft_opt_in'
  confirmed_at           timestamp              -- double opt-in completion; NULL while 'pending'
  unsubscribed_at        timestamp
  last_sent_at           timestamp
  custom_fields          jsonb NOT NULL DEFAULT '{}'
  created_at, updated_at
  UNIQUE (organisation_id, email)               -- the grain. One contact per address per tenant.

audience_segments
  id, organisation_id, name, description
  kind                   text NOT NULL DEFAULT 'manual'   -- 'manual' | 'dynamic'
  rules                  jsonb NOT NULL DEFAULT '{}'      -- reserved for 'dynamic'; ship 'manual' first
  created_by, created_at, updated_at
  UNIQUE (organisation_id, lower(name))

audience_contact_segments        -- join
  contact_id → audience_contacts(id) ON DELETE CASCADE
  segment_id → audience_segments(id) ON DELETE CASCADE
  added_at, added_by
  PRIMARY KEY (contact_id, segment_id)

audience_consent_events          -- append-only proof, never updated or deleted
  id, organisation_id, contact_id (ON DELETE SET NULL), email
  event      text NOT NULL   -- 'subscribe_requested' | 'confirmed' | 'unsubscribed' | 'bounced' | 'complained' | 'imported' | 'promoted' | 'erased'
  channel    text            -- 'web_form' | 'email_link' | 'one_click' | 'reply' | 'admin' | 'webhook'
  source_url text            -- the page the form was on
  ip_hash    text            -- pseudonymised; see db/ip-pseudonymise-migration.sql for the existing convention
  user_agent text
  form_id, issue_id, evidence text
  created_at

audience_import_jobs
  id, organisation_id, filename, row_count, imported, skipped, failed,
  status text CHECK (status IN ('queued','running','completed','failed')),
  error_summary jsonb, declared_consent boolean NOT NULL, created_by, created_at, completed_at
```

Indexes that are load-bearing, not decorative:
`audience_contacts (organisation_id, status)`, `audience_contacts (organisation_id, email)`,
`audience_contact_segments (segment_id)`, `audience_consent_events (organisation_id, email, created_at DESC)`.

**Why `audience_consent_events` is separate from the contact row:** a contact row is mutable and a
consent record is evidence. When someone complains to a regulator, "when did they opt in, from what
page, and what did the form say" is the question, and it cannot be answered by a row that has been
updated four times since.

### 3.2 `db/newsletter.sql`

Mirror `db/blog-posts.sql` deliberately — same workflow vocabulary, same reused infrastructure:

```
newsletter_issues
  id, organisation_id, user_id, assistant_id → ai_assistants(id) ON DELETE SET NULL
  owner_id, owner_label
  subject                text NOT NULL
  preheader              text
  body_markdown          text NOT NULL DEFAULT ''
  rendered_payload       jsonb          -- sanitised HTML + plain-text part, snapshot at approval
  segment_id             → audience_segments(id) ON DELETE SET NULL   -- null = whole subscribed audience
  status                 text NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','pending_approval','in_review','approved','scheduled',
                        'sending','sent','paused','failed','rejected','archived'))
  scheduled_for, sent_at
  is_autonomous          boolean NOT NULL DEFAULT false
  generation_reason      text
  provenance_content_id  text
  confidence_score       text
  factual_claims         jsonb
  job_id                 text          -- content_generation_jobs
  blueprint_id           → ai_blueprints(id) ON DELETE SET NULL
  recipient_count, delivered_count, opened_count, clicked_count,
  bounced_count, complained_count, unsubscribed_count   -- integers, default 0
  created_at, updated_at

newsletter_sends              -- one row per recipient per issue
  id, organisation_id, issue_id → newsletter_issues(id) ON DELETE CASCADE
  contact_id → audience_contacts(id) ON DELETE SET NULL
  email text NOT NULL
  status text NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','sent','delivered','bounced','complained','failed','skipped'))
  skip_reason text          -- 'opted_out' | 'suppressed' | 'unconfirmed' | 'bounced_previously' | 'consent_check_failed'
  provider_message_id text
  unsubscribe_token text NOT NULL      -- unique; per (issue, contact). Rotate, never clear.
  error text, sent_at, updated_at
  UNIQUE (issue_id, email)

audience_forms                -- the embeddable capture form
  id, organisation_id
  public_key text NOT NULL UNIQUE      -- 'aud_<nanoid>' — a WRITE key; see §5 for why not wgt_
  name text NOT NULL DEFAULT 'Default'
  allowed_origins text[]               -- ⚠️ see §5: empty vs null must not mean the same thing
  segment_id → audience_segments(id) ON DELETE SET NULL
  double_opt_in boolean NOT NULL DEFAULT true
  fields jsonb NOT NULL DEFAULT '["email","first_name"]'
  theme jsonb NOT NULL DEFAULT '{}'
  success_message, redirect_url, consent_text text
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
  created_by, created_at, updated_at

audience_confirmations        -- double opt-in pending tokens
  id, organisation_id, contact_id, form_id
  token text NOT NULL UNIQUE           -- 32+ bytes of CSPRNG, stored hashed (sha256) — see §4
  expires_at timestamp NOT NULL
  confirmed_at timestamp
  sent_count integer NOT NULL DEFAULT 1
  last_sent_at timestamp NOT NULL DEFAULT now()
  created_at
```

⚠️ **Do not reuse `assistant_records` for newsletter issues or subscribers.** Its CHECK constraint
is `record_type IN ('lead','enrichment','meeting','invoice','ticket')` — an insert with a new type
raises, and widening that constraint to hold a mailing list would put audience data back inside a
per-assistant table, which is the exact coupling this work exists to remove.

RLS: only `ai_assistants` currently has a policy (`db/rls/R1-crown-jewels.sql`). Follow the house
pattern — `organisation_id` on every table, user-facing reads through `withTenant`, and add the
tables to the crown-jewel array in the same slice that wraps their callers, not before.

---

## 4. Double opt-in flow (specified)

```
visitor submits form
   └─ POST /api/audience/subscribe        (public, no auth — §5)
        ├─ resolve public_key → org + form           (unknown/disabled key → 404, no detail)
        ├─ origin allowlist / honeypot / rate limit  (§5)
        ├─ normalise email; reject syntactically invalid
        ├─ audience-consent.ts check
        │     ├─ already 'subscribed'      → return the SAME 200 as a new signup (no enumeration)
        │     ├─ 'unsubscribed'/'complained' → return the same 200, record nothing, send nothing
        │     └─ otherwise continue
        ├─ upsert audience_contacts (status 'pending', source 'web_form', consent_basis 'double_opt_in')
        ├─ insert audience_consent_events 'subscribe_requested' (ip_hash, user_agent, source_url)
        ├─ mint confirmation token, store SHA-256 of it, expiry now() + 7 days
        └─ send the confirmation email  ── §6 dispatch decision
   visitor clicks "Confirm my subscription"
   └─ GET  /api/audience/confirm?t=<token>          → confirmation page
      POST /api/audience/confirm                     → the actual write
        ├─ HEAD → 200, records NOTHING   (scanner pre-fetch — same trap as lead-unsubscribe.ts)
        ├─ token lookup by hash; expired or already used → friendly page, no state change
        ├─ contact.status = 'subscribed', confirmed_at = now()
        ├─ attach form.segment_id
        └─ audience_consent_events 'confirmed' (channel 'email_link')
```

**Decisions, with the reasoning, because each has a wrong-looking-but-right shape:**

- **The click that confirms must not be a bare GET write.** Mail scanners, corporate link
  rewriters and antivirus proxies fetch every URL in an email. `lead-unsubscribe.ts` already solved
  the mirror-image problem (HEAD must not opt out); here the same class of client would
  auto-confirm subscriptions nobody consented to. Render a page on GET; write on POST from a form
  button. The one exception is the *unsubscribe* direction, where RFC 8058 one-click POST is
  required and a false positive costs one lost subscriber rather than one unlawful send.
- **Store the token hashed.** It is the entire credential and it sits in an email inbox and in
  server logs. `newsletter_sends.unsubscribe_token` follows the `replyToken` precedent: unique, NOT
  NULL, **rotated rather than cleared** when revoked.
- **Confirmation resend is throttled** (`sent_count`, `last_sent_at`): at most 3, at most one per
  hour. An unthrottled resend endpoint keyed on an arbitrary address is an email-bombing tool
  pointed at strangers, from your sending domain.
- **Unconfirmed contacts are never sent an issue.** `audience-consent.ts` treats `pending` as
  no-send, so a stalled double opt-in fails safe. Sweep `pending` rows older than 30 days to
  `unsubscribed` (a nightly cron; ⚠️ two nightly sweeps in this repo silently never ran because a
  failing cron is invisible — add a log line and a counter you can actually query).
- **Double opt-in is per-form and defaults ON.** Let a tenant turn it off for a single form, warn
  in the UI, and record `consent_basis: 'single_opt_in'` so the difference is provable later.
- **CSV import never confirms anyone.** Imported rows land `status: 'subscribed'`,
  `consent_basis: 'imported_declared'`, and the importer must tick a declaration that they hold
  consent; the declaration goes in `audience_import_jobs.declared_consent` and one
  `audience_consent_events` row per contact. The tenant's assertion is the record, and it is
  their liability, but it has to *exist*.

---

## 5. The embeddable capture form

Ship `subscribe.js` at the repo root, served static and cache-busted, mirroring `widget.js` —
Shadow DOM, no dependencies, resolves its API origin from `document.currentScript.src`:

```html
<script async src="https://bemoreswan.com/subscribe.js"
        data-bms-form="aud_ab12…" data-bms-mount="#bms-subscribe"></script>
```

**Why a new `aud_` key instead of reusing `wgt_`:** `widget_configs.public_key` is a *read* key for
CDN-cacheable published content. A form key authorises **writes** from an anonymous browser. They
need different rotation, different rate limits and different blast radius when leaked. One table,
one meaning.

Endpoint `netlify/functions/audience-subscribe.ts`, exposed via a rewrite in `netlify.toml`:

```
[[redirects]]
  from = "/api/audience/*"
  to   = "/.netlify/functions/audience-public"
  status = 200
```

⚠️ **Rewrite order matters and has bitten this repo before** — `/api/widget/:key/rss` has to precede
`/api/widget/*` or RSS 404s. Place the audience rules above any existing catch-all that could
swallow them, and parse the real path from `event.rawUrl` (the pattern `widget-api.ts` uses).

Abuse controls, all of which are required, none of which are optional:

| Control | Implementation |
|---|---|
| Origin allowlist | `allowed_origins` on the form. ⚠️ **NULL = any origin** (matching `widget_configs`), but an **empty array must mean "nothing allowed"**, not "everything" — the two are different states and conflating them turns a tenant's "I cleared this list" into a wide-open endpoint. |
| CORS | Echo only an allowlisted origin, handle `OPTIONS` preflight, `Vary: Origin`. |
| Honeypot | A visually hidden field; a filled one returns the normal 200 and writes nothing. |
| Timing | Reject submissions faster than ~1.5s after mount (bot tell), same silent-200 response. |
| Rate limit | Per `public_key` and per IP hash — e.g. 10/min, 100/hour per key. Reject with 429 above it. |
| No enumeration | Every outcome that isn't a hard input error returns the identical body. "That address is already subscribed" leaks a tenant's customer list to anyone with the snippet. |
| No CAPTCHA in v1 | It costs conversion and a third-party dependency; revisit only if the controls above measurably fail. |
| IP handling | Store a **hash**, never the raw address; follow `db/ip-pseudonymise-migration.sql`. |

The Newsletter Assistant's settings tab shows the snippet, the allowlisted-origin editor, a live
preview, and a "test submission" button that writes a contact tagged `source_detail.test: true`.

---

## 6. Dispatch — the one decision that needs the founder's answer

There are two email paths in the product today and **neither is a newsletter sender**:

- `src/utils/email.ts` → **Resend**, hard-coded `from: 'Be More Swan <noreply@bemoreswan.com>'`.
  This is BMS → its own users (magic links, receipts, notifications). Sending tenants' marketing
  mail from it would put every tenant's complaint rate onto Be More Swan's own sending reputation,
  and the `From:` would be wrong.
- `src/utils/gmail.ts` → the **tenant's own connected mailbox** (`MAILBOX_PROVIDERS = ['gmail','outlook']`),
  used for 1:1 cold outreach. Gmail caps around 500 recipients/day, gives no bounce or complaint
  webhooks, and a bulk send from a personal mailbox damages the address the tenant uses for real
  business.

Three options:

| | Approach | Pros | Cons |
|---|---|---|---|
| **A (recommended)** | **Resend with a per-tenant verified sending domain.** Tenant adds SPF/DKIM/DMARC records for e.g. `mail.theirdomain.com`; issues send from their domain through the account BMS already has. `admin-system-status.ts:134` already calls the Resend Domains API, so the verification plumbing is a short step. | Correct `From:`, per-domain reputation, bulk-capable, bounce/complaint webhooks, `List-Unsubscribe` support, one integration to operate. | DNS setup friction per tenant; shared IP pool means one abusive tenant can still affect others — needs a complaint-rate kill switch. |
| **B** | Send via the tenant's Gmail/Outlook grant. | Zero new setup; reuses `gmail.ts`. | Hard daily caps, no delivery telemetry, no bounce handling, reputational damage lands on the tenant's real mailbox. |
| **C** | Bring-your-own ESP key (tenant's own Resend/SendGrid). | Zero reputation exposure for BMS; unlimited scale. | Every tenant needs an ESP account; support burden; keys to store in `vault_secrets`. |

**DECIDED 2026-08-20 (founder): option 2 — A as the default, B as an explicit small-list fallback.**
A verified per-tenant sending domain is the industry-standard answer for broadcast, and the
tenant's own mailbox is the industry-standard answer for 1:1 outreach; Be More Swan does both, so
each half keeps the send path its own job calls for. The mailbox route is hard-capped and blocked
above it, which is what lets a tenant send their first issue on the day they hire the assistant
rather than after a DNS round trip. C deferred.

⚠️ **Two traps found while specifying A, both to be handled when it is built:**
- A least-privilege Resend "Sending access" key is REJECTED on `/domains` (`restricted_api_key`) —
  `admin-system-status.ts` already documents this. Domain provisioning needs a fuller-scoped key;
  keep the send path on the restricted one.
- ⚠️ Do NOT reuse `organisations.domain_verified` (db/org-business-domain.sql). It already means
  "verified for same-domain org auto-join". Sending-domain verification is a different claim and
  needs its own columns — one boolean with two meanings is the shape of several bugs already in
  this codebase's history.

Whichever is chosen, these are non-negotiable:

- **Bounces and complaints write back to `audience_contacts.status`.** A hard bounce ⇒ `bounced`
  (never emailed again). A spam complaint ⇒ `complained` **and** an `audience_consent_events` row
  **and** a `lead_opt_outs` row, because a complaint is the strongest possible opt-out signal and
  must bind the Lead Generator too. This is the whole cross-assistant promise, tested.
- **`List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`** on every issue.
  Gmail and Yahoo require it for bulk senders; `lead-unsubscribe.ts` already implements the POST
  side and is the model to copy.
- **The footer is appended in code at the send site**, never by the model, never stored in the
  draft body — the reasoning in `src/config/outreach-footer.ts` applies unchanged (a reviewer
  editing the draft would otherwise delete the legally required part without knowing what it is).
- **The postal address gate applies.** `organisations.outreach_postal_address` is already a hard
  gate for outreach and is a CAN-SPAM requirement for bulk mail too. Reuse `isUsablePostalAddress()`;
  do not write a second copy of the rule.
- **Sending is batched and resumable.** A cron (`process-newsletter-sends.ts`, `*/5 * * * *`)
  claims work **atomically** — ⚠️ `SKIP LOCKED` outside a transaction guards nothing; five jobs
  became nine posts in production once already. `newsletter_sends` rows are the claim unit and the
  idempotency key, which is what makes a partial failure resumable rather than duplicative.
- **Consent is re-checked per recipient at send time**, not once at approval. Approval and send are
  minutes-to-days apart, and someone unsubscribing in between must not receive the issue.

---

## 7. Drafting the issue — reuse, do not rebuild

The Blog Writer pipeline is the template and most of it is content-type-agnostic:

| Need | Reuse |
|---|---|
| Generation job queue | `content_generation_jobs`, `process-content-jobs.ts` |
| Prompt assembly | `assemble-blueprint.ts`, `ai_blueprints`, `src/utils/blueprint-prompt.ts` |
| Draft → approve → publish | `pending_actions`, review queue, `src/utils/quality-review.ts` |
| Provenance / AI disclosure | `content_provenance`, `src/utils/disclosure-footer.ts` |
| Editor + sanitiser | Blog Studio's Markdown editor; ⚠️ a new inline mark needs the **server** `ALLOWED_TAGS` or it is stripped on publish |
| Autopilot cadence | `blog-horizon-fill.ts` / `blog-autopilot.sql` patterns |
| Current date in prompts | `src/utils/current-date-prompt.ts` — without it drafts self-date to 2025 |

**Personalisation is a merge-var render at send time, in code** — `renderMergeVars` /
`sanitiseBodyHtml` / `htmlToPlainText` in `src/utils/email-template.ts`. The model writes
`{{first_name}}`; it never sees the recipient list. Generating 5,000 per-recipient drafts would be
5,000 model calls, would break the approval model (a human approved *an* issue, not 5,000 unseen
variants) and would make the provenance record meaningless. Every merge var needs a fallback
("there" / "" ) — `Hi ,` is the classic tell of a broken newsletter.

Prompt inputs come from the org's own material: business profile, brand kit, knowledge base
articles, recent blog posts. ⚠️ The Blog Writer originally shipped fed with Instagram insights and
follower counts on a blog role; do not hand the Newsletter Assistant social surfaces it has no use
for. Its `connection-map.ts` categories are already `['email','cms']` — respect that.

---

## 8. Surfaces (vanilla JS)

**New top-level page: `audience.html` + `audience.js`.** It belongs outside any assistant, in the
main nav next to My Content. ⚠️ Org-wide views have **no assistant context** — resolve the
organisation from the session; never inherit an `assistantId` (a page that expects one renders
blank without it). Contents: contact list with filter/sort/bulk actions, segment manager, CSV
import, per-contact detail with the consent timeline (straight off `audience_consent_events` — it
is the answer to "why is this person on my list?"), and a global "do not email" toggle.

- Lists are **client-paged** through `ListPager` — never add a server `LIMIT`.
- Every dialog goes through `dialogs.js`; there is no other dialog implementation.
- Tailwind: `emerald-*` is remapped to neon pink in `input.css`; a `*/` inside a CSS comment
  deletes the `:root` token block. Prefer existing utility combinations over a `style.css` rebuild.
- `hidden` loses to `inline-flex` — set `style.display = 'none'` as well.

**Assistant detail** follows the standard four-tab template (Overview · Data Hub · Review Queue ·
Calendar) and its copy is **DB-driven** (`window.AssistantContent`, seeded from
`db/seed-assistant-content.ts`) — grepping the source for the strings will find nothing. The Data
Hub tab for this role lists **Issues**; the audience deliberately lives on the shared page instead,
with a link from the tab.

**Capture Form tab**: snippet, origin allowlist, double-opt-in toggle, field selection, consent
text, live preview, test submission.

---

## 9. Gating, plans, catalogue

1. `UPDATE master_assistants SET coming_soon = false WHERE role_key = 'newsletter_editor'` in a
   migration (the seed will not do it — §0).
2. Any new capability keys (`newsletter_send`, `audience_import`) need `assistant_feature_defs`
   rows **and** `assistant_features` rows per role. ⚠️ A feature key with no row is **off**:
   `assistant_features` was empty in production and AI image generation 403'd for every org for
   months without a single error report.
3. Plan features are DB-driven and `npm run db:seed` **overwrites** them — diff before seeding.
4. `roleKey` is snake_case and must match `db/seed-catalog.ts` verbatim.
5. Task/quota accounting: decide whether an issue *send* consumes tasks per issue or per recipient.
   Recommend **per issue** — per-recipient billing turns a task cap into a hard stop mid-send, and
   the cap is a hard stop, never an overage charge.

---

## 10. Build order

| Phase | Scope | Done when |
|---|---|---|
| **0 ✅** | `db/audience.sql` + `db/newsletter.sql` written; `db/schema.ts` mirror; `src/utils/audience-consent.ts` + `audience-contacts.ts` + `audience-store.ts`; `tests/audience-consent.test.ts` (17 checks) | Resolver returns no-send for an address in `lead_opt_outs`, a suppressed domain, and on a forced DB error — ⚠️ **SQL still to be applied** |
| **1 ✅** | `audience.html` / `audience.js`, `audience-contacts.ts`, `audience-segments.ts`, segments, CSV import, nav entry in `workspace.html` + `components/sidebar.html` | A contact added by hand appears, can be segmented, and shows a consent timeline |
| **2 ✅** | `subscribe.js`, `audience-public.ts`, `audience-forms.ts`, double opt-in, `audience-email.ts`, `/api/audience/*` rewrite; `tests/audience-capture.test.ts` (24 checks) | A form on an unrelated test page produces a `pending` contact that becomes `subscribed` only after a POST confirm; HEAD changes nothing |
| **3 ✅** | `newsletter-generate.ts` (drafting), `newsletter-render.ts` (snapshot + per-recipient merge), `src/config/newsletter-merge-vars.ts`, `newsletter-issues.ts`, `newsletter.html` / `newsletter.js` (Studio); `tests/newsletter-drafting.test.ts` (23 checks) | An issue drafts, previews as the email a subscriber receives, and approval freezes a `rendered_payload` with the merge tags still unresolved |
| **4 ✅** | `newsletter-send.ts` (claim, materialise, batch), `sending-domain.ts`, `process-newsletter-sends.ts` (cron `*/5`), `newsletter-unsubscribe.ts`, `newsletter-webhook.ts`, `newsletter-sending-domain.ts`, HTML/header support on all three senders, Studio sending setup + Send now; `db/newsletter-dispatch.sql`; `tests/newsletter-dispatch.test.ts` (27 checks) | ⚠️ **Not yet proven against a real send** — see §11c |

⚠️ **Phase 5 still owes the Studio its real entry point.** It is routed at `?view=newsletter` with no
nav item; it belongs on the Newsletter Assistant's detail page when the role goes live.
| **5 ✅** | Catalogue flip (`db/newsletter-role-live.sql` + seed), onboarding schema, dashboard registry + `get-newsletter-performance.ts`, goal metrics, starter prompts, mandate chips, notification categories, Studio entry point, autopilot cron `draft-newsletter-issues.ts`; `tests/newsletter-role-live.test.ts` (17 checks) | The role is hireable and its Overview cards read from real counts. ⚠️ Needs `db/newsletter-role-live.sql` applied + the content seed re-run |

⚠️ **KPIs are four cards, not five.** Opens and clicks are deliberately absent: measuring either
needs a tracking pixel or link rewriting, neither is built, and a card that can never populate is
the failure the Blog Writer's KPI grid had to be rebuilt to fix. The four are Subscribers, Issues
Sent, Delivery Rate and Unsubscribe Rate — the last being the quality counterweight, since the
first three can all look healthy while the writing wears people out.
| **6** (later) | Lead → audience promotion action, dynamic segments, Campaign/Ad Buyer/Onboarding reuse | Promotion writes a `promoted` consent event and requires an explicit human click |

---

## 11. Repo rules the implementer must not discover the hard way

- **SQL before code, on staging and prod both.** New `db/*.sql` files are applied manually; the
  migration runner defaults to staging and needs `--url-var` (a variable *name*) for prod.
- Every function is `export default withLambda(async (event) => …)`.
- `git push` on `staging` **auto-deploys production**. Promote to `main` via PR; never
  `push origin staging:main`.
- Tests live in `tests/*.test.ts`. Source-scan tests read the HTML directly — typecheck is not
  enough, markers must be unique, and a stale marker yields an empty slice that still "passes".
- Ask before running ad-hoc SQL against either database; hand over SQL text rather than `psql`
  commands, with ids hardcoded (no `:param`).
- `local .env points at staging` — a "local" test run is writing to the staging database.

---

## 11b. Pending deploy steps (nothing here is in a database yet)

1. **Apply `db/audience.sql`, then `db/newsletter.sql`** — staging first, then prod, as the DB owner
   (`npm run db:migrate:apply`; prod needs `--url-var`). Both are idempotent. Until this runs, the
   Audience page reports "not set up on this environment" rather than failing — `audience-contacts`
   catches 42P01 and returns `needsSetup: true` — but nothing can be captured or stored.
2. **Deploy the code** (this is a `staging` push, which auto-releases prod — promote via PR).
3. **Create a sign-up form** from Audience → Sign-up form, and paste the snippet on a test page
   before giving it to a customer.
4. **Check `RESEND_API_KEY` and `BASE_URL`** are set in the target environment. Without the key the
   confirmation email is skipped in dev-mode and every sign-up stays `pending`, i.e. unmailable;
   without `BASE_URL` the endpoint refuses rather than emailing an unusable link.
5. Nothing new is required for `lead_opt_outs` / `suppression_list` — the resolver reads what is
   already there, and treats either missing table as empty.

---

## 11s. Deliverability tooling (2026-08-20)

**No migration.** Everything here is computed from data we already hold, plus one DNS lookup.

### ⚠️ What this deliberately is NOT

**There is no spam score, and there must not be one.** A number out of ten implies a model of the
receiving filter, and nobody outside Google has one: Gmail is not SpamAssassin, it is not public,
and it weighs sender reputation far above anything visible in the message. A score would be ACTED
ON — somebody would rewrite working copy to move it — which makes inventing one worse than saying
nothing. The panel says so in those words rather than quietly omitting it.

**There is no trigger-word list.** "Free", "act now" and the rest are folklore from filters retired
a decade ago. A warning about the word "free" makes a tenant rewrite a good offer for no benefit.
A test sends a subject stuffed with all of them and asserts nothing is reported.

**There is no seed testing.** Real seed testing needs mailboxes at every major provider that
somebody owns, monitors and keeps warm; a fake version that checks one address proves nothing. It
is not built rather than half-built.

### What IS here, because we genuinely know it

**1. List health, against the thresholds the gatekeepers published.** Complaint rate against
Gmail's stated 0.3% limit and 0.1% target; bounce rate graded at 2% and 5%. Quoting somebody else's
published line is the difference between "this looks high to us" and "this is above the level Gmail
says it will filter you at". ⚠️ Below about 200 sends the rates are not shown at all — two bounces
out of thirty is 6.7%, which reads as a crisis and is two bounces. Counted from the send LEDGER
rather than the denormalised issue counters, because a tenant would act on this by deleting part of
their list.

**2. DMARC, by plain DNS lookup.** SPF and DKIM are set up as part of verifying a domain and the
provider refuses to verify without them; DMARC is the one nobody adds, because nothing forces it —
and since 2024 Gmail and Yahoo require bulk senders to publish one. ⚠️ Looked up on the ROOT domain
as well as the sending subdomain, since a record on `acme.com` covers `mail.acme.com` and reporting
"none" would send a tenant to add something they do not need. ⚠️ A failed lookup is reported as OUR
failure, never as a missing record.

**3. Warm-up guidance for a new domain.** A first send of ten thousand from a domain verified
yesterday looks exactly like a spammer who has just bought one, and the damage lands on the domain
rather than the campaign. The ceiling starts around 200/day and doubles every couple of days,
stopping being mentioned after three weeks. ⚠️ **Nothing enforces it** — it is a warning with a
number, never a refusal, because the tenant may have a genuinely engaged list and we cannot see that
from here.

**4. Structural findings on the issue itself**, shown while it is still a DRAFT — on a sent issue
the same words are a post-mortem, on a draft they are a decision. Shouting subject, repeated
punctuation, an almost-empty body, image-heavy layout, link density. Each is named and explained;
none is totalled.

The health report is a GET readable by **any role**, not just owner/admin: the person who acts on
"2.1% of your emails bounced" is usually the one writing the issues, not the one who owns billing.

---

## 11r. Tenant-facing API (2026-08-20)

1. **Apply `db/tenant-api-keys.sql`** — staging, then prod. One table, `api_keys`.
2. ⚠️ **SQL first, then deploy.**
3. The `/api/v1/*` rewrite ships in `netlify.toml` with the code.

**What it unlocks.** A subscriber could arrive two ways: the sign-up form, or a CSV. A shop taking a
marketing tick at checkout, a booking system, a Zapier step — all of them had to become a person
exporting a spreadsheet once a week, which is how a list goes stale and how the consent evidence
gets lost between the tick and the import.

    GET    /api/v1                             what this API can do — no key needed
    POST   /api/v1/contacts                    add or update one subscriber
    GET    /api/v1/contacts/{email}            their status, source and consent basis
    POST   /api/v1/contacts/{email}/unsubscribe
    DELETE /api/v1/contacts/{email}            refused — see below

### ⚠️ The one rule this exists to not break

**A call can never resurrect an unsubscribe.** The characteristic disaster of every subscriber API
is a nightly sync from a CRM that does not know who opted out, posting the whole customer table as
`subscribed` and quietly re-subscribing everybody who left. That is not hypothetical — it is the
default behaviour of a naive integration, and it emails people who said no from the tenant's own
domain.

`upsertContact`'s status ratchet already refuses it, and the API does not carry a second copy of
that rule. What it adds is that it **reports** the refusal: the response returns the status the
contact actually has, plus `statusHonoured: false` and a sentence, so the caller's own system can
see its request was declined instead of assuming it landed. The index says so before anybody
integrates.

A caller also cannot announce `bounced` or `complained`. Those are things that HAPPENED to a
contact; a caller asserting one would be writing a fact it cannot know.

### Consent is declared per call

`consent.basis` is required on every write, from the same closed list the rest of the product uses.
Same rule as the CSV import, for the same reason: "who said these people agreed?" has to have an
answer attached to the ACT, not to a setting somebody ticked in March. Every write records a consent
event with `channel: 'api'` and the key's id, and the event names what actually happened
(`confirmed` vs `subscribe_requested`) rather than what was asked for.

### The key

⚠️ **Stored as a sha256 hash, shown once at creation, and returned by no endpoint afterwards** —
that is arithmetic, not policy. `key_prefix` is kept in clear only so two keys can be told apart in
a list. A plain hash rather than bcrypt is deliberate and justified in the code: 32 bytes of CSPRNG
output has nothing to brute-force, and a slow hash on the hot path of a checkout would be a
self-inflicted rate limit.

⚠️ **A key cannot mint another key.** Key management is session-authenticated and owner/admin only —
otherwise one leak is permanent. **Revoked, never deleted**: "this key existed and was turned off on
the 3rd" is the question asked after something goes wrong.

⚠️ **Every authentication failure is the same 401 with the same body.** "That key is revoked" tells
the holder of a stolen key that it was real; "no such key" tells them to keep looking. The tenant
gets the diagnostic value from their own key list instead.

Rate limited **per key**, not per IP: a tenant's server has one address and may legitimately be
busy, while a runaway loop is the thing actually being bounded.

### What it refuses to do

**DELETE is refused with a 405 that names the alternative.** Erasing a contact also writes a
permanent block on that address (THE DELETE RULE in audience-contacts.ts), and doing that silently
from a nightly sync would leave a tenant with a growing opt-out list they never chose and cannot
explain. Erasure is a decision, not a sync artefact.

**Unsubscribing an address we do not hold is a success, not a 404.** "Make sure this person is not
subscribed" is satisfied by an address we never had, and a 404 there pushes callers into ignoring
the response entirely.

### ⚠️ Outbound webhooks are NOT in this

Appendix B's row names an API *or webhooks*, and only the API is built. Webhooks need an endpoint
registry, a signing secret, delivery attempts with backoff, and a retry worker — and a retry worker
is a schedule whose failure is silent, which is the thing this codebase has been bitten by twice.
The inbound half is what the row's own description asks for ("subscribers can only arrive through
the form or a CSV"), and it stands on its own. The outbound half should be built when somebody
actually needs it, with the retry story designed first rather than bolted on.

---

## 11q. Send time and timezones (2026-08-20)

1. **Apply `db/newsletter-send-time.sql`** — staging, then prod. `send_timezone`, `send_mode` and
   `send_local_time` on `newsletter_issues`; `due_at` on `newsletter_sends`; `timezone` on
   `audience_contacts`.
2. ⚠️ **SQL first, then deploy.**
3. **No new scheduled function**, again.

### The bug half

A tenant who scheduled "9:00" got **09:00 UTC**, because the server parsed the bare wall-clock
string a `datetime-local` input produces with no zone attached to it. For a British sender in summer
that is ten in the morning; for one in Sydney it is the evening of the day before. Nothing anywhere
said so, which is what made it a bug rather than a setting.

Now the typed time is read in the tenant's zone, and ⚠️ **that zone is STAMPED on the issue** rather
than resolved at send time — an assistant's `posting_timezone` can change between scheduling and
sending, and "9am on Tuesday" has to stay the moment the human agreed to. The browser is sent both
the zone and the wall-clock and converts neither: somebody editing from another country would
otherwise see, and re-save, a different time from the one the issue goes out at. The zone is named
under the field, because "9:00" with nothing beside it is the whole ambiguity.

### The feature half

An issue can be sent **at each subscriber's own local time** instead of all at once. Each
`newsletter_sends` row carries its own `due_at`; the batch query takes only rows that are due; the
issue stays in `'sending'` until none are left. That is the same mechanism the A/B wait uses, and it
needs no new worker.

⚠️ **We know a subscriber's timezone only if their browser told us at sign-up.** It cannot be read
from an email address, and reading it from a sign-up IP would be a guess presented as a fact in the
one place where being wrong means arriving at three in the morning. So "unknown" is a first-class
answer: those people are sent at the SENDER's chosen time, and the count of how many that is goes in
front of the tenant as soon as they switch the mode on. Both sign-up surfaces (the hosted page and
the embeddable widget) now report `Intl.DateTimeFormat().resolvedOptions().timeZone`, best-effort
and never fatal, and the value is VALIDATED before storage — an unknown zone reaching `Intl` inside
the send worker would throw and fail a whole batch over one row.

**Two rules in `dueAtForRecipient`:**

- ⚠️ **It never goes backwards.** If the target hour has already passed where they are, they are
  sent as the issue starts, not tomorrow. An issue being sent now is news now; holding it 23 hours
  to hit a nicer clock face would deliver yesterday's newsletter.
- ⚠️ **It never runs away.** Anything beyond 24 hours from the start is clamped, so one odd zone
  cannot leave a copy queued for days.

**A newer zone replaces an older one** (people move, and a stale zone sends confidently at the wrong
hour), but an absent one erases nothing — `COALESCE(EXCLUDED.timezone, existing)`.

**A local-time send freezes its audience** once it starts, like an A/B test: it stays open for up to
a day, and re-scanning would sweep in people who subscribed after the issue began.

⚠️ **A local-time send and an A/B test refuse to run together**, in both directions. A test decides
from the first few hours of opens; a local-time send spreads the sample across a day. Individually
sound, together they produce something that looks like a subject-line finding and is really a map of
where a list lives.

---

## 11p. Hosted sign-up page (2026-08-20)

1. **Apply `db/audience-hosted-pages.sql`** — staging, then prod. Three columns on
   `audience_forms`: `hosted_enabled`, `hosted_headline`, `hosted_intro`.
2. ⚠️ **SQL first, then deploy** — `audience-forms.ts` reads them with a bare `db.select()`.
3. The `/s/*` rewrite ships in `netlify.toml` with the code.

**What it is.** `/s/<public_key>` — a page we serve, for the customers who have no website to paste
the snippet into. A link for a bio, a poster, a QR code.

⚠️ **THERE IS NO SECOND FORM RECORD.** The page is another way to reach a form that already exists,
with its own consent text, double opt-in setting, segment and key. A hosted-page table would mean
two records that both decide what a subscriber agreed to, and the one that drifts is the one shown
to the person signing up. It is rendered by `audience-public.ts` — the file that already holds the
one description of what a form says — and posts to the same `/api/audience/subscribe` endpoint the
embeddable widget does.

⚠️ **OFF BY DEFAULT, and the flag does two jobs.** It is what makes `/s/<key>` answer at all, and it
is what lets that page past `allowed_origins`. A tenant who locked their form to their own website
would otherwise find the page we serve for them refused — but relaxing the origin check for our own
domain *unconditionally* would mean any form, including one deliberately locked to an intranet,
could be posted to from a page anyone can open. So our origin is accepted only for a form whose
owner switched the page on.

⚠️ **A switched-off page answers exactly like a key that never existed** — same 404 body, same
function. Otherwise the URL is an oracle for which tenants have a sign-up page.

⚠️ **It carries the SAME anti-bot pair as the embed**: the honeypot field and the minimum fill time.
A public URL on our own domain is a *more* attractive target than a form on one small business's
website, not a less attractive one, so the protections cannot be the ones the embed happens to have
and this page happens to skip.

**noindex, deliberately.** The value is a link somebody shares, and search adds nothing a bare form
page could realistically rank for — while an abandoned or half-configured page indexed under our
domain, carrying a tenant's name, is a real cost. The link works exactly as well either way.

**Every tenant-written string on the page is escaped** — org name, headline, intro, consent text.
They all land in a page served from our domain, where one unescaped angle bracket is stored XSS.
The tests render the page and read the output rather than scanning the source for the escape calls.

**The page loads nothing from anywhere else**: `default-src 'none'`, `connect-src 'self'`, no remote
script, no web font, no analytics.

---

## 11o. A/B subject testing (2026-08-20)

1. **Apply `db/newsletter-ab-subjects.sql`** — staging, then prod. Columns on `newsletter_issues`
   (`subject_b`, `ab_state`, sample size, decision delay, winner, note), `variant` on
   `newsletter_sends`, and it widens the send-status vocabulary with `'held'`.
2. ⚠️ **SQL first, then deploy.** The status CHECK is re-created with DROP + ADD, and the send
   worker writes `'held'` the first time a test runs.
3. **No new scheduled function.** Deliberately — see below.

**The shape.** A sample of the list (10–50%, default 30%) is split evenly between two subject
lines. After a wait (1–72 hours, default 4) whichever was opened by more PEOPLE goes to everyone
held back.

⚠️ **THE DECISION RUNS INSIDE `sendDueIssues`.** An A/B decider on a cron of its own would be a
single point of failure whose failure mode is *70% of a list never receives the issue* — and this
codebase has had two nightly sweeps that never ran once. The issue stays in `'sending'` between the
sample and the decision, which is exactly what brings it back to the sweep every few minutes. If
sending works, deciding works.

⚠️ **The remainder is materialised up front as `'held'` rows.** They could have been created after
the decision instead — but then "who is this issue going to" would have two answers depending on
when you asked, the recipient count would jump mid-send, and a list edited during the wait would
change the audience underneath the test. Held rows freeze the audience at approval, which is what a
tenant thinks approving means. The audience is not re-scanned while the test waits, for the same
reason (and because a four-hour wait would otherwise walk the whole audience every few minutes).

**It always decides.** There is no path that leaves an issue half-sent: a tie decides, no opens at
all decides, and an issue that could not measure opens decides. The fallback is always variant A —
the subject the human wrote first — and the reason is written to `ab_note` in words the tenant can
read.

⚠️ **It never claims more than it knows.** A lead under 3 opens, or under 1.2×, is reported as *"too
close to call"* and subject A is sent. This is a rule of thumb and the code says so in those words:
opens are inflated for some recipients and invisible for others, so the input is not clean enough
for a significance test to mean what it would appear to mean. A tenant told "B won" writes next
month's subject that way, so a small difference must not be dressed up as a finding.

**The subject each person received comes from their own `newsletter_sends.variant`, not from the
issue.** The row is the record of what was sent, and it has to survive the issue being edited
afterwards. The winner is stamped onto the held rows when they are released, rather than inferred.

**Two smaller decisions:**

- The sample is **interleaved** (`i % 2`), not halved. Send ids follow contact ids, which follow
  subscription order — giving the first half of the list one subject and the second half the other
  would compare two audiences rather than two subject lines.
- Setting up a test on an org with **no verified sending domain** returns a warning at SETUP: that
  route cannot report opens, so there would be nothing to decide on and everyone held back would get
  subject A. Said now rather than discovered four hours later.

---

## 11n. Per-link click reporting (2026-08-20)

1. **Apply `db/newsletter-link-clicks.sql`** — staging, then prod. One table,
   `newsletter_link_clicks`.
2. ⚠️ **SQL first, then deploy** — though this one degrades rather than breaks: the recorder and the
   report both treat 42P01 as "no data yet", so the newsletter page still opens on an environment
   without it.

**What was missing.** `newsletter_sends.last_clicked_url` holds ONE url per recipient — deliberately,
because a single column pretending to be a click history would mislead. So "3.4% clicked" was
answerable and "clicked WHAT" was not, which is the half a tenant can act on: the answer decides
what goes at the top of the next issue.

**One row per (recipient, link), not per event.** The row IS the unique click — `UNIQUE (send_id,
url_hash)` — and a repeat increments `click_count` on it. So `count(*)` is how many PEOPLE and
`sum(click_count)` is how many TIMES, both exact, and the table is bounded by the people who
actually clicked rather than by everyone who was sent the issue. Same reasoning that made opens a
first-touch timestamp rather than a counter.

⚠️ **THE UNSUBSCRIBE COLLAPSE IS THE POINT OF THE NORMALISER.** Every recipient's unsubscribe url
carries their own token, so a five-thousand-person issue would produce up to five thousand DISTINCT
one-click rows — burying the three links the tenant actually wrote, in exactly the report built to
surface them. They collapse to one row, and are KEPT rather than dropped: how many people went
looking for the way out is worth knowing, and hiding it would be its own kind of dishonest. The row
is labelled rather than shown as a url, since the url is per-recipient and not a destination.

**Everything else is left alone, including utm parameters.** Two urls differing only by campaign tag
are two links the tenant chose to distinguish; merging them would answer a question they did not ask.

⚠️ **The hash is the key, not the url.** A btree entry is capped near 2704 bytes and a real campaign
url with tracking parameters gets long — an index that works in testing and throws on a customer's
link is not a thing to leave to chance. The url is stored alongside for display, and the hash is
taken OF the stored url so the two cannot disagree.

⚠️ **It can never break the webhook.** `recordLinkClick` swallows every failure. A 500 there makes
the provider retry the whole event, and the bounce and complaint writes beside it are what stop us
emailing people who asked us not to — a report is not worth risking those.

**The report is aggregate by choice.** The rows underneath name a recipient, because that is what
makes "unique" exact rather than estimated — but "who clicked what" is a different feature with
different consent questions, and nothing here builds a view of it.

**Zero and unmeasurable stay distinct**, as everywhere else in this feature: an issue sent from a
tenant's own mailbox rewrites no links, and says so rather than reporting no clicks.

⚠️ **And so does "sent before we were recording".** An issue with clicks on the ledger but no link
rows predates this feature, and telling its owner "nobody clicked a link" would be the same lie as
reporting 0% opens on a mailbox send — a statement about our instrumentation dressed as one about
the reader. The issue's own `clicked_count` is what tells the two apart, so it costs nothing to be
honest about it. (Caught after the migration was already applied, which is exactly when a tenant
would have hit it.)

---

## 11m. Custom fields (2026-08-20)

1. **Apply `db/audience-custom-fields.sql`** — staging, then prod. One new table,
   `audience_custom_fields`: the LIST of what a tenant's own columns are called. The values have
   always had a home (`audience_contacts.custom_fields`) and nothing ever wrote to them.
2. ⚠️ **SQL first, then deploy.**

⚠️ **The key is permanent; the label is not.** `key` is the JSONB key on every contact row and the
value inside every saved segment rule, so it is derived once from the label and never renamed — a
rename would orphan the values on thousands of rows and silently empty any rule naming it. The API's
`rename` accepts a label and nothing else, rather than accepting a key and ignoring it. The key is
shown to the tenant at creation, because it is what they will type inside `{{contact.custom.…}}`.

**Text only, and the reservation is deliberate.** The CHECK allows `'text' | 'number' | 'date'`; the
API accepts `text`. ⚠️ Numbers and dates are deferred for a reason rather than for time: comparing
them means casting tenant-entered JSONB text, `(custom_fields->>'age')::numeric` throws 22P02 on the
first contact who typed "about 40", and Postgres does not guarantee a guard in the same `AND` runs
first. Doing it safely needs a fenced subquery; doing it unsafely breaks a SEND.

**Three places tenant-supplied keys now reach, and the guard on each:**

- **Into every contact's JSONB.** An ALLOW-LIST, not a filter of obviously-bad keys: the import and
  the contact editor keep only keys this org has defined. Anything else would be written where
  nothing lists it and nothing can clean it up. A blank cell is not a value — storing `''` would
  make "has a city" true for somebody whose column was empty.
- **Into an email.** `{{contact.custom.city | "your area"}}` works; a bare `{{contact.custom.city}}`
  is REMOVED at save time and the author is told. ⚠️ There is no honest default for a field called
  "City", and an empty render is "our new shop in ." in every inbox where we hold no value — so a
  custom tag is treated exactly like an unknown one rather than defaulted to blank.
- **Into the WHERE clause of a send.** ⚠️ `is_not` also matches the people we hold NO value for.
  Without that arm, "plan is not premium" excludes everyone with no plan on file — usually most of
  the list, and exactly the people the tenant meant to include. Comparisons are case-insensitive on
  both sides, and the key is a bound parameter, never spliced into SQL text.

**Both upsert paths merge, rather than replacing or ignoring.** `custom_fields || EXCLUDED.custom_fields`
in the single-contact upsert AND the bulk import: replacing would erase every field not in the new
file, and ignoring — which is what both did until now — would mean a second import could never fill
anything in. Only the bulk path was fixed at first; the test that reads *both* blocks is what caught
the other one.

**Capture and use, so it is not a column with a UI:** CSV import matches a column by the field's
exact name and says when none matched; the contact panel edits them (a blank clears one); segment
rules filter on them; the newsletter editor offers them as insert-tags with the fallback already
written in.

---

## 11l. Tags (2026-08-20)

1. **Apply `db/audience-tags.sql`** — staging, then prod. It widens one CHECK constraint
   (`audience_segments_kind_check` gains `'tag'`) with DROP + ADD, and adds an
   `(organisation_id, kind)` index.
2. ⚠️ **SQL first, then deploy.** The app writes `kind = 'tag'` as soon as it ships, and a bare
   `db.select()` on audience_segments names every column.

⚠️ **THERE IS NO `audience_tags` TABLE, and that is the decision.** A tag is a label attached to
some contacts. A manual segment is a label attached to some contacts. They are the same data, and
`audience_contact_segments` already stores it — with the tenancy re-check on every write, the
cascade rules, and the four readers that answer "who is in this group" already built against it. A
second table would be a second answer to that question, and here that question means *who receives
an email*. So a tag is a segment with `kind = 'tag'`, and the new kind changes only presentation.

**What it buys.** "Everyone tagged *bought something* who has not opened an email in 60 days" is a
dynamic segment with two conditions — Kit's model (tags are the primitive, segments are saved rules
over them) reached without a new table. The rule builder gains a **Tagged is / is not** condition.

⚠️ **A rule may not be built on a dynamic segment.** A rule over a rule is a cycle waiting to be
written, and the first one would be found by whichever send hit it. `checkRuleReferences` refuses it
with a sentence naming the segment, on all three write paths (preview, create, setRules) — a shape
check alone would let it through, because the id is structurally valid.

⚠️ **The tag subquery re-asserts the organisation inside the EXISTS**, through the segment row. A
rule carrying another tenant's id would match nobody today, because membership is written
org-checked on both sides — but "safe because of what another file does" is not a guarantee the
rule compiler should rely on.

**Presentation, which is the only thing the new kind changes:**

- The Audience page draws Segments and Tags as two rows, rendered by one function from one list.
- The newsletter's audience picker groups them — and a tag remains fully selectable, because a tag
  IS a valid audience. Grouping is for the person choosing, not a restriction.
- "Add to segment" offers manual segments only. A tag has its own button, and a dynamic segment
  works its own members out — offering either would be a control that reports success and does
  nothing.

---

## 11k. Dynamic segments (2026-08-20)

**No migration.** `audience_segments.kind` already allowed `'dynamic'` and `rules JSONB` already
existed — reserved when the table was written precisely so this would not be a migration of every
existing row. It is code only, and ships with the next push.

**What a tenant gets.** Audience → *+ Rule-based segment*: match all or any of up to ten
conditions over how somebody joined, which form they used, how long ago, whether they have opened
an email in the last N days, whether they have ever been emailed, and their email domain. The
builder shows the live count and the rule as an English sentence before it is saved.

**Nothing is materialised.** There is no membership table for a dynamic segment: the rule is
compiled to a WHERE clause at the moment somebody asks. A stored membership would need a refresh,
and a refresh that stops running leaves a segment quietly describing last month — ⚠️ this codebase
has already had two nightly sweeps that never ran once. A dynamic segment cannot be stale because
there is nothing to be stale.

⚠️ **Every refusal points the same way: never wider than the tenant believes.** This compiles the
audience of a send, so the two rules below are the opposite of what an ordinary parser does.

- **An empty rule set is refused, not read as "everyone".** Someone who deletes their last
  condition and presses save has not asked to email their whole list.
- **A condition we cannot read fails the WHOLE rule**, naming which one. Skipping it is the
  dangerous default: dropping "opened in the last 90 days" from a three-condition rule silently
  triples the audience. Same reasoning as the CSV import status (§11f).
- **`match` defaults to `all`**, the narrower joiner, when it is absent or unrecognised.
- **A missing segment, or rules that will not compile, FAIL the send** with the reason written to
  `failure_reason` — never a fallback to the whole audience.
- **A broken rule lists nobody** in the audience page rather than everybody, and the segment chip
  says "rules broken" instead of showing a count.

**One compiler, four callers** — the send, the pre-send estimate, the segment list count, and
browsing the segment all call `buildSegmentCondition`. A preview that disagrees with the send is
only ever discovered by the recipients.

⚠️ **Contacts cannot be added to a dynamic segment by hand.** Membership rows are not read for one,
so the button would report success and change nothing — the API refuses with a sentence naming the
segment.

⚠️ **The engagement condition is org-scoped INSIDE the EXISTS subquery.** `newsletter_sends` carries
its own `organisation_id`, and a segment that could see another tenant's ledger would be a
cross-tenant read in the one place nobody would think to look for one.

---

## 11j. Preference centre (2026-08-20)

1. **Apply `db/newsletter-preferences.sql`** — staging, then prod. Adds `paused_until`,
   `email_frequency` and `preferences_updated_at` to `audience_contacts`, and **widens two existing
   CHECK constraints**.
2. ⚠️ **SQL first, then deploy.** The contact-detail GET in `audience-contacts.ts` uses a bare
   `db.select()`, so it names every column of `audience_contacts`.
3. ⚠️ **Two vocabularies are re-created, not appended to** — `audience_consent_events_event_check`
   and `newsletter_sends_skip_reason_check` already exist with narrower lists, and their home files
   add them only `IF NOT EXISTS`, so a plain "add if missing" here would silently do nothing and the
   first pause would fail at 23514. A test extracts both original lists from `db/audience.sql` and
   `db/newsletter.sql` and asserts every value survives the widening.
4. ⚠️ **Fresh-install order:** alphabetically this file sorts before `newsletter.sql`, so on a brand
   new database apply `audience.sql` and `newsletter.sql` first. The guard refuses to run otherwise.

**What the reader gets.** The unsubscribe link now opens a preference page with four choices on one
page: pause 30 days, pause 3 months, at most one email a month, or stop all emails.

⚠️ **The exit is not hidden, moved, or made to look like the lesser option.** A preference centre
that makes leaving harder than it was is worse than none at all: the reader who cannot find the exit
presses "report spam" instead, and that costs the sending domain far more than one lost subscriber.

⚠️ **The one-click POST still unsubscribes, unconditionally.** RFC 8058 requires a
List-Unsubscribe-Post request to unsubscribe with no further interaction, and mail clients fire it
from a button labelled "unsubscribe". Answering it with a menu would be a spec violation and a dark
pattern in one move. The choices exist on the GET page only, and an unrecognised choice on the form
unsubscribes rather than being ignored.

**Three things that make the pause real rather than cosmetic:**

- **It binds every assistant.** Enforced in `src/utils/audience-consent.ts` — the one place that
  answers "may this organisation email this address right now" — so the welcome sequence and Lead
  Generator outreach stop too. Somebody who asks for quiet and gets a "welcome!" two days later has
  been told no.
- **It ends by itself.** `paused_until` is a timestamp every reader compares against the clock, not
  a flag some sweep has to clear. Two nightly sweeps in this codebase never ran once; a pause that
  depended on one would mute people permanently.
- **A welcome sequence DEFERS rather than halts.** A halted enrolment is never resumed by anything,
  so the verdict carries `retryAfter` and the worker reschedules to the moment the pause lifts.

**And the frequency cap is newsletter-only**, applied when recipients are materialised — a capped
subscriber never gets a ledger row, so `recipient_count` stays an honest count of who this send
actually reached. "At most one a month" is measured from `last_sent_at`; a contact we have never
emailed is due by definition.

⚠️ **Deliberately NOT a topic picker.** Segments here are hand-maintained, so "only send me the
product news" would be a promise whose accuracy depends on somebody keeping a list up to date. That
becomes honest when dynamic segments exist, and not before.

---

## 11i. Resend to non-openers (2026-08-20)

1. ⚠️ **`db/newsletter-engagement.sql` must be applied first** (§11e). Without `newsletter_sends.
   opened_at` there is no such thing as "did not open", so `db/newsletter-resend.sql` refuses to
   run and names it in the hint rather than leaving a half-built feature.
2. **Apply `db/newsletter-resend.sql`** — staging, then prod. Adds
   `newsletter_issues.resend_of_issue_id`, the unique index that makes one resend per issue
   structural, and a partial index for the "sent but never opened" lookup.
3. ⚠️ **SQL first, then deploy** — same reason as §11h: two bare `db.select()` reads on
   newsletter_issues name every column.
4. No new function and no new schedule. A resend is an ordinary issue with `scheduled_for = now`,
   so `process-newsletter-sends` picks it up on its next tick.

**What it does.** On a sent issue, an owner or admin sees how many people were sent it and never
opened it, edits the subject line, and confirms. That creates a NEW issue that copies the approved
snapshot verbatim, targets only those people, and sends. Its own counters make "did the second
subject line do better?" a comparison of two rows.

⚠️ **The guard that matters most: `engagement_tracked`.** An issue sent from a tenant's own Gmail or
Outlook mailbox rewrites no links and embeds no pixel, so every recipient looks unopened. Resending
that is not a resend to non-openers — it is a second unrequested email to the entire list, sent in
the belief that nobody read the first. The panel refuses with the reason and points at verifying a
sending domain.

⚠️ **And tracking being switched on is not the same as opens arriving.** `engagement_tracked` records
that we asked the provider to track this domain; subscribing the webhook to `email.opened` /
`email.clicked` is a separate manual step (§11e step 2). Miss it and every recipient of every issue
reads as a non-opener — the same whole-list resend, through a door the flag does not watch. So a
resend is also refused when the account has **never recorded a single open on any issue**, after the
48-hour wait so a new tenant is told to wait rather than shown a warning about instrumentation they
cannot see. The refusal is logged as an error, because the fix is ours; the tenant is asked to get in
touch rather than sent hunting through settings they have no access to.

**The other four rules, all enforced rather than advised:**

- **48 hours minimum.** Opens arrive over days; somebody who reads on Sunday has not declined it on
  Friday. The refusal says when it becomes available.
- **One resend per issue, ever** — a unique index, not a check a double-click can get around — and a
  resend can never itself be resent.
- **Only recipients whose send actually succeeded.** A `skipped` or `failed` row never received the
  email, so it is not a non-opener; sweeping those in would quietly turn this into "retry the
  addresses that bounced".
- **The segment is not re-applied.** "Who did not open" is already the intersection of the segment
  and the people we reached, and re-applying a segment somebody has edited since would drop
  recipients the original did reach.

**The count on the button and the rows the worker materialises come from one predicate**
(`unopenedFilter` in `src/utils/newsletter-resend.ts`). A preview that disagrees with the send is
only ever discovered by the recipients.

---

## 11h. Blog post → newsletter issue (2026-08-20)

1. **Apply `db/newsletter-from-blog.sql`** — staging, then prod, as the DB owner. It adds
   `newsletter_issues.source_blog_post_id` and a unique index on
   `(assistant_id, source_blog_post_id)`.
2. ⚠️ **SQL FIRST, then deploy.** `db/schema.ts` names the new column, and two reads in
   `newsletter-issues.ts` use a bare `db.select()`, which names every column in the table: opening
   an issue and saving one. On an environment where the column does not exist both 500, and the
   symptom is "the newsletter page won't open an issue", not "a migration is missing".
3. Nothing else. No new function, no new schedule: the hand-off runs inside the publish that
   triggers it.

**How a tenant switches it on.** Orchestrations → *New workflow*: "When **Blog Writer** publishes a
post, send to **Newsletter Assistant** to *write a short issue about it*". The freeform action is
passed into the brief, so it is the tenant's own instruction that steers the draft.

⚠️ **A Newsletter Assistant target only accepts "publishes a post".** An issue drafted at
*drafts_a_post* would point at a URL that does not exist yet. The API refuses to create such a link
(the hub disables the other two events when the target is a newsletter role), and the runtime
refuses it again for links built before that rule existed.

⚠️ **The target's ROLE decides what a hand-off produces.** Every other target enqueues a
`content_generation_jobs` row, which drafts a SOCIAL post. The hub has always offered every
assistant as a target, so a Blog Writer → Newsletter Assistant link could already be built — and
until now it produced a social draft in a newsletter assistant's queue, which is not a thing that
surface even shows.

**What is guaranteed:**

- **It drafts; it never sends.** The issue lands in `pending_approval` like every other draft.
- **The link to the post is appended in code**, and the model is told not to write one — the same
  rule as the unsubscribe footer. An issue about a post that does not link to the post is the one
  outcome that makes the feature pointless, and models paraphrase URLs.
- **One issue per post per assistant, enforced by the index.** Unpublish → republish is a supported
  round trip and fires the hand-off again; without the index the second publish drafts a duplicate
  of an email the tenant already reviewed.
- **A failed draft leaves nothing behind** — the placeholder row is deleted, which also frees the
  unique key so the next republish can try again.
- **A hand-off that drafted nothing is recorded as `skipped`**, not as a hand-off, and gives the
  daily cap back.

**Interaction with the autopilot, worth knowing:** `draft-newsletter-issues.ts` skips an assistant
that already has an issue awaiting a human, and `pending_approval` counts. So a blog hand-off
suppresses that period's autopilot draft rather than stacking a second one on top of it.

---

## 11g. Welcome sequence deploy steps (2026-08-20)

1. **Apply `db/newsletter-sequences.sql`** — staging, then prod, as the DB owner. Three tables:
   `newsletter_sequences`, `newsletter_sequence_steps`, `newsletter_sequence_enrolments`. It guards
   on `audience_contacts` existing and raises with a hint if the audience migration has not run.
2. **Nothing else.** The `*/15` schedule for `process-newsletter-sequences` is in `netlify.toml` and
   ships with the deploy; the function degrades to `{ due: 0, needsSetup: true }` on `42P01`, so
   deploying the code before applying the SQL is safe and quiet.

The file creates a unique index on `(organisation_id, trigger_event)` — nothing to de-duplicate
first, because these tables are new in this migration.

⚠️ **Nothing sends until a human switches a sequence on**, and the switch refuses while the
sequence has no steps. An org that never opens the panel is exactly as it was before this shipped:
`enrolInWelcomeSequence` finds no sequence and returns.

⚠️ **Existing subscribers are not enrolled retroactively, deliberately.** Enrolment hangs off the
double opt-in confirmation. Back-filling everyone who ever subscribed would send "welcome, thanks
for subscribing" to a list that has been reading you for a year.

⚠️ **`unsubscribe_token` lives on the enrolment**, not on a send — a sequence step writes no
`newsletter_sends` row. `newsletter-unsubscribe.ts` resolves `newsletter_sends` first and then
enrolments, so both link shapes work through the same endpoint and the same one-click POST.

---
## 11f. CSV import status (2026-08-20)

**No migration.** The importer now reads a subscription-status column from the file and writes each
row's own state. Nothing to apply — it is code only.

⚠️ **Behaviour change worth knowing about.** A file that carries a status column the importer
cannot read no longer imports those rows at all: it reports the values it did not understand and
asks for a corrected file. Guessing "subscribed" would re-open the breach this closes; guessing
"unsubscribed" would silently bin an import over one unexpected column match. Refusing the row and
naming the value is the only option that does neither.

Recognised out of the box: Mailchimp (`subscribed` / `unsubscribed` / `cleaned` / `pending`), Kit
(`active` / `unsubscribed` / `bounced` / `complained`), Shopify (`not_subscribed`), and the
yes/no/true/false/1/0 columns a hand-kept spreadsheet produces. ⚠️ `cleaned` is Mailchimp's word for
a HARD BOUNCE — reading it as a healthy subscriber is the single most likely way to import a dead
address and then damage a sending domain with it.

---

## 11e. Engagement + chat-draft deploy steps (2026-08-20, after Phase 5)

1. **Apply `db/newsletter-engagement.sql`** — staging, then prod. Adds per-recipient `opened_at` /
   `clicked_at` (first touch), the repeat counters, `newsletter_issues.engagement_tracked` and the
   per-domain tracking switches. It guards on `newsletter_sends` existing.
2. **Add `email.opened` and `email.clicked`** to the Resend webhook's event list. Without them the
   columns stay empty and both cards read "not measurable".
3. Nothing else. Tracking is requested from the provider at domain creation; existing domains keep
   whatever they were created with until the tenant toggles it.

⚠️ **Existing sent issues will show no engagement, correctly.** `engagement_tracked` defaults to
false, so issues sent before this shipped report "not measurable" rather than a misleading 0%.

---

## 11d. Phase 5 deploy steps

1. **Apply `db/newsletter-role-live.sql`** — staging, then prod. Until this runs the role stays
   "Coming Soon" in the catalogue on every existing database, because `db/seed-catalog.ts` is
   INSERT-ONLY and the flag edit there only affects a fresh one.
2. **Apply `db/newsletter-role-copy.sql`** so the corrected card copy lands. ⚠️ Do this INSTEAD of
   re-running `db/seed-assistant-content.ts`: that seed rewrites the copy of all 24 roles it carries,
   unconditionally, and its own header warns that re-running "restores any admin edit back to these
   values" — so it would silently revert anything edited in Master Data → Assistants. It also
   targets `NETLIFY_DATABASE_URL`, which locally points at staging, so it would not have reached
   production regardless. The previous copy promised "Curated Industry Round-Ups" and a Mailchimp
   integration — neither exists, and the assistant's own prompt forbids inventing the industry news
   that first phrase implies.
3. Two new crons register themselves on deploy: `process-newsletter-sends` (`*/5`) and
   `draft-newsletter-issues` (daily 06:20 UTC). Check for their single log line per tick before
   trusting either.
4. Nothing else. Phase 5 added no new tables.

---

## 11c. Phase 4 deploy steps

1. **Apply `db/newsletter-dispatch.sql`** — staging, then prod. It guards on `newsletter_issues`
   existing and refuses with an instruction rather than a foreign-key error.
2. **`RESEND_DOMAINS_API_KEY`** — a FULL-ACCESS Resend key, separate from the sending key. Without
   it, domain setup returns "the key in use can send email but cannot manage domains" (a 503, since
   it is our misconfiguration and not the tenant's DNS). The send path keeps using `RESEND_API_KEY`.
3. **`RESEND_WEBHOOK_SECRET`** (`whsec_…`) and point a Resend webhook at
   `https://bemoreswan.com/api/newsletter/webhook` for `email.delivered`, `email.bounced` and
   `email.complained`. ⚠️ Until this exists every event is rejected 401 and no bounce or complaint
   ever reaches the audience — the list degrades silently, which is the exact failure the mailbox
   route was rejected for.
4. **Confirm `BASE_URL`** in each environment. The worker refuses to send without it rather than
   guessing a host, because every footer needs an absolute unsubscribe link.
5. The `process-newsletter-sends` cron registers itself from `netlify.toml` on deploy (`*/5`,
   sharing the warm-compute window with `publish-blog-posts`). ⚠️ GitHub-style throttling does not
   apply — these are Netlify scheduled functions — but check the function log for the single
   `[process-newsletter-sends]` line per tick before trusting it.

**Not yet proven end to end.** Everything is unit-tested and the UI is verified against fixtures,
but no real email has been sent through either route. The first live test should be: verify a
domain, create an issue, approve it, send it to a segment containing only your own address, and
confirm (a) it arrives, (b) the one-click unsubscribe in Gmail flips the contact to `unsubscribed`
**and** writes a `lead_opt_outs` row, (c) `email.delivered` lands on the webhook and moves the
ledger row to `delivered`.

---

## 12. Open questions for the founder

1. ~~**Dispatch: A, B or C in §6?**~~ **ANSWERED 2026-08-20: option 2** — verified per-tenant domain
   by default, tenant mailbox as a hard-capped small-list fallback. See §6.
2. **Is the Audience a top-level nav item now**, or does it stay inside the Newsletter Assistant
   until the Campaign Assistant lands? (Recommend top-level immediately — retro-fitting shared data
   into a shared surface is the expensive version.)
3. **Volume expectations per tenant** — 500 subscribers or 50,000? It changes batching, the send
   cron budget, and whether option B is ever acceptable.
4. **Free-plan abuse posture**: an anonymous-write public endpoint on a low-cost plan is a spam
   vector. Minimum: verified sending domain required before the first send, and a per-plan
   recipients/month ceiling.
5. **Lead → audience promotion**: single-record button only, or a bulk action with a consent
   declaration? (Recommend single-record for launch.)

---

## Appendix B — measured against Kit (ConvertKit)

Written 2026-08-20. ⚠️ Vendor specifics move; this describes Kit's *model* — the shape of what it
does — rather than a feature list captured on a date. Re-check before quoting any of it publicly.

Kit is the closest comparator to what the Newsletter Assistant is becoming: not a campaign blaster
like Mailchimp, but a subscriber-centric tool where the list, the automations and the content are
one product. Its model has four parts worth naming, because three of them we do not have.

**1. Tags, not lists.** ✅ **Closed 2026-08-20** (§11k, §11l). A Kit subscriber is one record
carrying tags and "segments" are saved rules over those tags — which is now exactly what this is: a
tag is a label (`kind = 'tag'`), and a dynamic segment is a rule that can compose tags with the
columns we hold. The example this paragraph originally used to describe the gap — "everyone who
signed up through the shop form and has opened something in 90 days" — is two conditions in the
builder — and since §11m the rules reach the tenant's own columns too, which was the last piece of
Kit's model we were missing.

**2. Sequences, not just broadcasts.** Kit's centre of gravity is the automated series — above all
the welcome sequence that fires when someone subscribes. ✅ **Built 2026-08-20** (§11g): confirming
a subscription now enrols the contact, and the steps go out on their own schedule.

⚠️ It is NOT built on `outreach_sequences`, which the row below originally proposed. That table's
`sequence_enrolments.lead_thread_id` is NOT NULL and is the halt key the outreach worker re-reads
inside its claiming transaction so a follow-up cannot land after a prospect replied. An audience
contact has no thread, so reusing it meant either making that key nullable — weakening a guarantee
another product depends on — or minting fake threads for subscribers. A second, simpler set of
tables for a genuinely different job was cheaper than either.

**3. Hosted landing pages.** ✅ **Closed 2026-08-20** (§11p). Kit hosts the sign-up page so a creator
with no website can still collect subscribers; any form here can now be switched on as a page at
`/s/<key>`. ⚠️ What Kit still has and we do not is a page BUILDER — theirs are designed, ours is one
layout with a headline and an intro. That is the right trade for now: a business with no website
needs a working link far more than it needs a layout editor.

**4. Creator Network / recommendations.** Cross-promotion between senders. Out of scope for a
business tool and not worth chasing.

### Gaps, ordered by what they cost the customer

| Gap | Why it matters | Cost to close |
|---|---|---|
| ~~**No welcome sequence**~~ ✅ **CLOSED 2026-08-20** | The moment of maximum interest was the moment we said nothing. Confirming a subscription now enrols the contact; steps are written once, approved once, and then fixed. Off until an owner or admin switches it on, and the worker re-reads that switch on every send so switching it off stops mail already queued. Consent is re-resolved per step, so leaving on day two stops step three. | Done — `db/newsletter-sequences.sql`, `src/utils/newsletter-sequence.ts` |
| ~~**Imports do not carry unsubscribe status**~~ ✅ **CLOSED 2026-08-20** | Was a correctness gap, not a feature gap: a tenant migrating from Mailchimp would have had their *unsubscribes* silently become subscribed again. The importer now reads the status column (`src/config/audience-import-status.ts`), refuses values it cannot recognise rather than guessing, and reports carried-over opt-outs as their own number. | Done |
| ~~**No dynamic segments**~~ ✅ **CLOSED 2026-08-20** | Every segment was hand-maintained, so they rotted. A segment can now be a saved rule — including "opened something in the last 90 days" — evaluated at the moment it is asked, so it cannot go stale. No migration: the column was reserved when the table was written. | Done — `src/utils/audience-segment-rules.ts` |
| ~~**No resend-to-unopens**~~ ✅ **CLOSED 2026-08-20** | The cheapest reach increase in email. Same approved words, new subject line, only the people who never opened it — refused outright on an issue that could not measure opens, because there "unopened" means the whole list. | Done — `db/newsletter-resend.sql`, `src/utils/newsletter-resend.ts` |
| ~~**No preference centre**~~ ✅ **CLOSED 2026-08-20** | The only exit was total unsubscribe. The link now offers a 30-day or 3-month pause and an at-most-monthly cap alongside it — the pause binding every assistant, not just the newsletter, and lifting itself. The exit stays on the same page, in the same words. | Done — `db/newsletter-preferences.sql`, `src/utils/audience-preferences.ts` |
| ~~**No hosted sign-up page**~~ ✅ **CLOSED 2026-08-20** | Customers without a website could not collect subscribers at all. Any sign-up form can now be switched on as a page at `/s/<key>` — the same form, the same consent text, reached by a link instead of an embed. | Done — `db/audience-hosted-pages.sql` |
| ~~**No A/B subject testing**~~ ✅ **CLOSED 2026-08-20** | Two subject lines, a sample split evenly between them, and the winner to everyone held back — decided on unique opens inside the existing send sweep rather than on a cron of its own. A margin too small to mean anything is reported as "too close to call" rather than as a winner. | Done — `db/newsletter-ab-subjects.sql`, `src/utils/newsletter-ab.ts` |
| ~~**No per-link click reporting**~~ ✅ **CLOSED 2026-08-20** | `last_clicked_url` held one url per recipient, so "which link worked" was unanswerable. Every issue now reports its links by how many PEOPLE clicked each (and how many times), with every recipient's unsubscribe url collapsed to a single labelled row rather than thousands. | Done — `db/newsletter-link-clicks.sql` |
| ~~**No custom fields in practice**~~ ✅ **CLOSED 2026-08-20** | `custom_fields` existed on the contact and nothing read or wrote it. A tenant can now define their own columns, fill them from an import or by hand, filter segments on them, and personalise an email with them — with a bare custom merge tag refused rather than rendered blank. Text only; number and date are reserved in the schema and refused by the API. | Done — `db/audience-custom-fields.sql` |
| ~~**No send-time/timezone handling**~~ ✅ **CLOSED 2026-08-20** | Everything sent on a UTC clock, so a scheduled "9:00" was 09:00 UTC and nothing said so. A scheduled time is now read and stamped in the tenant's own zone, and an issue can optionally be delivered at each subscriber's local time — with "we do not know their zone" kept as an honest, counted answer rather than guessed from an IP. | Done — `db/newsletter-send-time.sql`, `src/utils/newsletter-schedule.ts` |
| **No tenant-facing API or webhooks** → ✅ **API BUILT 2026-08-20**, webhooks deliberately not | Subscribers could only arrive through the form or a CSV. `/api/v1/contacts` now takes them from a shop, a booking system or a Zapier step — with a declared consent basis on every write, and a refusal to resurrect anybody who opted out that is REPORTED rather than silent. ⚠️ Outbound webhooks are still open: they need a retry worker, and a retry worker is a schedule whose failure is silent. | API done — `db/tenant-api-keys.sql`; webhooks unbuilt |
| **No deliverability tooling** → ✅ **the honest half BUILT 2026-08-20** | List health against Gmail's published complaint and bounce thresholds, a DMARC lookup, warm-up guidance for a new domain, and named structural findings on a draft. ⚠️ Deliberately NOT built: a spam score (implies a model of a filter nobody outside Google has) and seed testing (needs real mailboxes somebody owns and warms). Saying so beats shipping a number people would act on. | Done — `src/utils/deliverability.ts`, `src/utils/dmarc-check.ts` |

### Where we are already ahead, and should stay

- **The assistant writes the issue.** Kit gives you a blank editor with AI assistance around the
  edges; here the draft exists before you sit down. That is the product.
- **One audience across every assistant.** An unsubscribe binds the Lead Generator too. Kit has no
  equivalent because Kit is not also doing your cold outreach.
- **Consent evidence as a first-class record.** `audience_consent_events` answers "when did they
  agree, from what page, and what did the form say". Most ESPs answer that with a timestamp.

### The three I would build next, and why in this order

1. ~~**Import unsubscribe status.**~~ ✅ **Built 2026-08-20** — see the table above.
2. ~~**Welcome sequence.**~~ ✅ **Built 2026-08-20** — see §11g. It reused less than expected (see
   the note under *Sequences* above) and was worth building anyway.
3. ~~**Blog post → newsletter issue.**~~ ✅ **Built 2026-08-20** — see §11h. ⚠️ This one is not on Kit's list at all, which is the point:
   `orchestration_links` already exists, the Blog Writer already produces the content, and "your
   blog post went out to your subscribers on Thursday without you doing anything" is a sentence Kit
   structurally cannot say. Chasing Kit's roadmap wins parity; this wins the argument.

   What it cost, now that it is built: one column, one index, and a branch in the orchestration
   runtime. `orchestration_links` did carry it — but only after the runtime learned that the
   TARGET'S ROLE decides what a hand-off produces. Reusing the links table was right; assuming
   every hand-off ends in a `content_generation_job` was the part that was wrong.

---

## Appendix A — competitive parity checklist

Not a market report; a checklist of what a paying customer coming from Mailchimp, Kit, Beehiiv or
Substack will expect to find, scored against this plan. The point is to be explicit about what we
are deliberately *not* shipping in v1, so the marketing copy doesn't promise it.

| Capability | Category | This plan |
|---|---|---|
| List import, segmentation, tagging | Table stakes | ✅ Phase 1 |
| Embeddable signup form / hosted landing page | Table stakes | ✅ form in Phase 2; hosted page **not** in scope |
| Double opt-in + one-click unsubscribe + consent audit | Table stakes / legal | ✅ Phases 2 & 4 |
| Authenticated sending domain (SPF/DKIM/DMARC) | Table stakes | ✅ if option A |
| Bounce & complaint handling with automatic suppression | Table stakes | ✅ Phase 4 |
| Open / click / unsubscribe analytics | Table stakes | ✅ Phase 5 (counters on the issue) |
| Drag-and-drop visual email builder | Expected | ❌ Markdown + a themed template. A real gap vs Mailchimp; state it plainly rather than implying otherwise |
| Automations / drip sequences on triggers | Expected | ❌ v1. `outreach_sequences` already exists for the Lead Generator and is the obvious base when it comes |
| A/B testing subject lines | Expected | ❌ v1, but `blog_ab_stats` + the widget A/B machinery is the pattern to copy |
| Paid subscriptions / monetisation | Differentiator for creator tools | ❌ out of scope; BMS sells to businesses, not newsletter creators |
| Referral / recommendation network | Differentiator for creator tools | ❌ out of scope |
| **Content drafted for you on a cadence, from your own business context** | **BMS's actual edge** | ✅ Phase 3/5 — this is the Blog Writer pipeline, and it is the thing the incumbents do not do |
| **One audience shared across every assistant, with consent that binds all of them** | **BMS's actual edge** | ✅ Phase 0 — `audience-consent.ts` is the whole claim in one module |

The honest positioning: BMS is not a better email builder, and shouldn't claim to be. It is the
only one of these where the list, the drafting and the other channels are the same product — an
unsubscribe here stops the cold outreach there, and next week's issue writes itself from the same
brand context the blog and social posts use. That is a real, demonstrable difference; the builder,
the automations and the A/B tests are the parity gaps to close afterwards.

⚠️ **Do not put any of the ❌ rows into public copy.** There is an existing pattern in this product
of marketing claims the code does not honour; check `docs/` and the site copy against this table
before the role is flipped live.
