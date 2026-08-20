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
