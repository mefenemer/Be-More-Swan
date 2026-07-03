# Staging & release workflow

A separate staging environment so changes are tested on a staging URL backed by a
**staging database** before anything reaches production. Production only ever changes
via a deliberate `staging → main` merge.

## Topology

| Layer | Production | Staging |
|---|---|---|
| Git branch | `main` | `staging` |
| Netlify | one site — `main` = **Production branch** | same site — `staging` = **branch deploy** (stable URL, e.g. `staging--<site>.netlify.app`) |
| Neon DB | production branch | a separate persistent Neon **`staging`** branch |
| App role | `app_user` on prod DB (RLS) | `app_user` on staging DB (RLS) |

Because env vars are **scoped per deploy context**, the staging build talks to the
staging database and uses the staging URL — production is never touched by a staging deploy.

## Day-to-day workflow

1. Branch off `staging`: `git checkout staging && git pull && git checkout -b feature/x`
2. Open a PR **into `staging`**. Netlify builds a deploy preview; merging to `staging`
   updates the staging site. Test against the staging URL + staging DB.
3. When staging looks good, open a PR **`staging → main`**. Merging deploys to production.
4. Never push directly to `main` (branch protection enforces this — see setup).

Rule of thumb: **if a change isn't on `main`, it isn't in production.**

## One-time setup (dashboard — not in code)

### Netlify (Site configuration)
1. **Build & deploy → Branches and deploy contexts**: Production branch = `main`.
   Branch deploys = "Let me add individual branches" → add `staging`.
2. **Environment variables** — for each secret/URL below, use *"different value for each
   deploy context"* and set a distinct **Branch deploys** (or branch-specific `staging`)
   value pointing at staging:
   - `NETLIFY_DATABASE_URL` → staging Neon branch (owner role)
   - `APP_DATABASE_URL` → staging Neon branch (`app_user` role)
   - `BASE_URL` → the staging site URL  ⚠️ critical: if this stays the production URL,
     magic-link / verification emails sent from staging will point users at production.
   - Any other environment-specific secrets (Stripe **test** keys on staging, etc.)

### Neon (database)
- Reuse the existing **`rls-test`** branch as staging: rename it `staging`
  (Branches → rls-test → Rename). It already has the `app_user` role + RLS policy from
  the R1 validation, so no re-provisioning needed.
- For any *new* RLS work, apply the same `db/rls/*.sql` to the `staging` branch first,
  validate with `npm run test:rls` (pointing `.env` at staging), then to production.

### GitHub (protect production)
- Settings → Branches → add a rule for `main`: **Require a pull request before merging**,
  and disallow direct pushes. This makes "deploy to prod" an explicit, reviewed action.

## Local testing
`.env` (gitignored) points at whichever DB you're testing — use the **staging** Neon
strings for routine local work; only point at production for read-only diagnostics.

## Promotion checklist (`staging → main`)
- [ ] Feature verified on the staging URL (staging DB)
- [ ] Any DB migrations / RLS SQL already applied to **production** (or included in the deploy)
- [ ] Stripe/email/etc. behaved with staging credentials
- [ ] PR `staging → main` reviewed, then merge → production deploy
