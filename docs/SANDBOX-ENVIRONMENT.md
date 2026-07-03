# Superadmin Live / Sandbox Environment

A super-admin-only toggle in the Admin Portal that routes all admin data reads/writes
and Stripe calls to either the **live** production stack or an isolated **sandbox**
stack — a second Neon database and the Stripe **test** account. Sandbox actions can
never bleed into production.

## How it works

| Layer | Live | Sandbox |
|---|---|---|
| Database (owner) | `NETLIFY_DATABASE_URL` | `SANDBOX_DATABASE_URL` |
| Database (RLS `app_user`) | `APP_DATABASE_URL` | `SANDBOX_APP_DATABASE_URL` (falls back to `SANDBOX_DATABASE_URL`) |
| Stripe | `STRIPE_SECRET_KEY` (`sk_live_…`) | `STRIPE_SECRET_KEY_TEST` (`sk_test_…`) |

- **Frontend** ([admin.html](../admin.html)) — a Live/Sandbox toggle in the topbar
  (super_admin only). State persists in `localStorage['aura_admin_env']`. A global
  `fetch` shim adds `X-Environment: <env>` to every `/.netlify/functions/` request.
  Sandbox mode applies a `body[data-env="sandbox"]` orange/hazard theme. Flipping the
  toggle re-runs the active section loader, swapping the data instantly.
- **Backend** — [`src/utils/env-context.ts`](../src/utils/env-context.ts) resolves the
  header into an `AsyncLocalStorage` context. [`db/client.ts`](../db/client.ts) and
  [`src/utils/stripe.ts`](../src/utils/stripe.ts) read that context to pick the right
  connection / API key. **Strict default:** a missing/malformed header, a
  non-super-admin, or an unprovisioned sandbox all resolve to **live**.
- **Auth & audit always use live.** Role lookups run before the env context is set;
  `insertAdminAuditLog` forces the live connection so the compliance log records every
  admin action regardless of environment.

## Environment variables (set in Netlify)

```
SANDBOX_DATABASE_URL=postgres://…        # second Neon database (REQUIRED for sandbox)
SANDBOX_APP_DATABASE_URL=postgres://…    # optional: app_user role on the sandbox DB (RLS)
STRIPE_SECRET_KEY_TEST=sk_test_…         # Stripe test secret key
```

## First-time setup

1. Provision a second Neon database and set `SANDBOX_DATABASE_URL`.
2. Create the schema in it: point drizzle at the sandbox URL and run `npm run db:push`.
   (e.g. `NETLIFY_DATABASE_URL=$SANDBOX_DATABASE_URL npm run db:push`)
3. Add `STRIPE_SECRET_KEY_TEST`.
4. Seed it: `npm run db:seed:sandbox` (CLI) or use **Platform → Sandbox Environment →
   Seed Master Data** in the Admin Portal.

## Master data source of truth (US6)

Baseline platform data is version-controlled JSON in [`seed/data/`](../seed/data):
`master_plans.json`, `plan_prices.json`, `master_assistants.json`,
`master_benchmarks.json`. Files are validated against Zod schemas
([`seed/schemas.ts`](../seed/schemas.ts)) **before** any insert. The shared seed core
([`seed/run-seed.ts`](../seed/run-seed.ts)) upserts by natural key (idempotent) and
syncs Stripe Products/Prices. **Change defaults by editing the JSON and opening a PR.**

### CLI

```
npm run db:seed                 # seed LIVE
npm run db:seed:sandbox         # seed SANDBOX
npm run db:seed -- --no-stripe  # skip Stripe sync
```

## Sandbox data management (Admin Portal → Platform → Sandbox Environment)

Visible to super_admins; the action buttons appear **only in Sandbox mode**.

- **Seed Master Data** → `POST /.netlify/functions/sandbox-seed`
- **Purge Sandbox Data** → `POST /.netlify/functions/sandbox-purge` — typed
  confirmation (`PURGE SANDBOX`), with an optional "reseed after purge" checkbox.
  TRUNCATEs all sandbox tables and deactivates Stripe test products/prices/test-clocks.

### Purge safety (three independent guards — all must hold)

1. caller is `super_admin`
2. the resolved request environment is `sandbox`
3. `SANDBOX_DATABASE_URL` is set **and differs** from `NETLIFY_DATABASE_URL`

## Scope note

Environment routing currently covers the **Admin Portal** surface (`admin-api`, the
sandbox functions). Customer-facing endpoints remain live-only by design.

## Tests

`npm run test:env-routing` — strict header resolution + context nesting.
