# Production environment-variable checklist

Set these in **Netlify → Site configuration → Environment variables** for the production context
before the first prod deploy. After deploying, the live source of truth is the super-admin screen
**Admin → System status**, which reports per-environment whether each is configured (value never
shown) and, where possible, reachable — plus a **launch-ready** verdict.

The code **silently falls back to mock/disabled mode** when a key is absent — nothing crashes, so a
missing key is invisible until a user hits the broken path. That's exactly what this list guards
against. Registry of record: `netlify/functions/admin-system-status.ts`.

## 🔴 Critical — must be set, or the app is broken/insecure

| Service | Env vars | Without it |
|---------|----------|-----------|
| Session signing | `JWT_SECRET` | Auth fails closed — nobody can log in (no fallback). |
| Database | `NETLIFY_DATABASE_URL` | No database. |
| Credential vault | `VAULT_KEK`, `VAULT_KEK_VERSION` | Stored OAuth tokens / connection secrets can't be decrypted. |
| Anthropic | `ANTHROPIC_API_KEY` | Assistants don't work. |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | No billing / no revenue; webhooks unverified. |
| Resend | `RESEND_API_KEY`, `FROM_EMAIL` | No verification / invite / reset email — signup can't complete. |
| App base URL | `BASE_URL` | Links in outgoing emails & OAuth redirects break (falls back to empty string). |

## 🟠 Core — a headline feature silently runs in mock/disabled mode

| Service | Env vars | Degraded behaviour if missing |
|---------|----------|-------------------------------|
| Cloudflare R2 | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | Uploads return 501; media falls back to mock/placeholder URLs. |
| Fal.ai | `FAL_KEY` | AI image/video generation returns placeholder assets. |
| Embeddings & moderation | `VOYAGE_API_KEY` **or** `OPENAI_API_KEY` | KB search + content moderation degrade. |
| Pexels | `PEXELS_API_KEY` | Stock media search unavailable. |
| Serper | `SERPER_API_KEY` | Lead Generator outbound discovery can't run. |

### Newsletter dispatch (Phase 4 — docs/newsletter-assistant-plan.md)

| Service | Env vars | Degraded behaviour if missing |
|---------|----------|-------------------------------|
| Resend domain management | `RESEND_DOMAINS_API_KEY` | Tenants cannot verify their own sending domain, so every newsletter falls back to the connected-mailbox route and is capped at 200 recipients. ⚠️ Must be a **full-access** key — the least-privilege sending key returns `restricted_api_key` on `/domains`. |
| Resend delivery events | `RESEND_WEBHOOK_SECRET` | Every bounce and spam complaint is rejected 401. The audience never learns an address is dead, `newsletter_sends` never advances past `sent`, and a complaint never reaches `lead_opt_outs` — the list degrades with nothing on screen to show it. |

⚠️ **The webhook endpoint URL must be the APEX with no `www`:**
`https://bemoreswan.com/api/newsletter/webhook`. The site 308-redirects `www` → apex for every
path, and webhook senders do not follow redirects — the same trap that kept every Stripe webhook
failing for a day.

⚠️ **`BASE_URL` must differ per context.** It is what builds the unsubscribe link in every footer.
If the production value is inherited by `branch-deploy`, a staging test send emails links pointing
at production, where the token does not exist — the recipient gets "we couldn't find that
subscription" and stays subscribed. Leave `BASE_URL` unset on `branch-deploy` (`resolveBaseUrl`
then falls back to `DEPLOY_PRIME_URL`, which is correct per deploy) or set it to the staging URL.

## ⚙️ Infra — operational hardening (set in prod even though not user-visible)

`CRON_TRIGGER_SECRET`, `WORKER_SECRET`, `NETLIFY_CRON_SECRET` — authenticate internal cron/worker
endpoints so they can't be invoked publicly.

## 🔌 Connectors — optional; only needed for the integrations you offer at launch

Each is a `<PREFIX>_CLIENT_ID` + `<PREFIX>_CLIENT_SECRET` pair. A missing pair only means that one
connector can't be linked — never a launch blocker. Prefixes:
`GMAIL, META, X, LINKEDIN, TIKTOK, THREADS, YOUTUBE, SLACK, NOTION, HUBSPOT, SALESFORCE, JIRA,
ASANA, ZENDESK, INTERCOM, XERO, QUICKBOOKS, SEARCHCONSOLE, WORDPRESSCOM`.

> Decide which connectors are in-scope for launch and set only those; the System-status screen's
> "Connectors live" line shows exactly which are wired in each environment.
