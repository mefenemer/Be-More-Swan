# Database migrations — tracked apply workflow

**Problem this solves:** the 70+ `db/*.sql` files are idempotent and applied **by hand** (Neon SQL
editor / psql as owner — never `drizzle-kit push`, which would drop the raw-SQL RLS policies Drizzle
can't see). Until now there was no record of which files each database had actually seen, so "did we
run that one on prod?" was answered from memory. `scripts/db-migrate.mjs` + the `schema_migrations`
ledger make schema state **verifiable per environment**.

## The tool

`scripts/db-migrate.mjs` connects with `NETLIFY_DATABASE_URL` (from `.env`, like `drizzle.config.ts`),
ensures a `schema_migrations` ledger exists (DDL: `db/_migrations-tracking.sql`), and compares every
`db/*.sql` file against it by **sha256 checksum**.

Each managed file is one of:

| State | Meaning |
|-------|---------|
| `APPLIED` | Recorded in the ledger; checksum matches the file on disk. |
| `PENDING` | On disk, never recorded — this DB has (probably) not run it. |
| `DRIFTED` | Recorded, but the file changed since — decide whether to re-apply. |
| `ORPHAN`  | In the ledger but the file is gone from disk (renamed/deleted). |

The tool does **not** wrap files in an outer transaction (~15 files run their own `BEGIN/COMMIT`).
It runs each file as-is, then writes the ledger row separately. Files are idempotent, so a mid-file
failure just leaves it `PENDING` and it retries next run. On any failure it **halts** and writes no
ledger row for the failed file.

## Commands

```bash
npm run db:migrate:status     # read-only audit: APPLIED / PENDING / DRIFTED / ORPHAN counts
npm run db:migrate            # DRY RUN — list the pending files it would apply, in order
npm run db:migrate:apply      # actually apply pending files (prompts to confirm)
npm run db:migrate:baseline   # (careful) record all files as applied WITHOUT running them
```

Direct invocation exposes more flags:

```bash
node scripts/db-migrate.mjs status --url-var APP_DATABASE_URL   # audit a different DB
node scripts/db-migrate.mjs apply --only goals --execute        # apply just matching files
node scripts/db-migrate.mjs apply --execute --yes               # skip the confirm prompt (CI)
node scripts/db-migrate.mjs status --include-rls                # also track db/rls/*.sql
```

## Adopting this on an already-live database

Prod/staging already contain most of these objects. Because every file is idempotent
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), the safe adoption path is:

1. `npm run db:migrate:status` — see what the ledger thinks (initially: everything `PENDING`).
2. `npm run db:migrate` — dry run; review the ordered list.
3. `npm run db:migrate:apply` — re-runs every file. Existing objects are no-ops; genuinely-missing
   ones get created; the ledger is populated. This both **heals drift and establishes the record**
   in one pass.

> `baseline` is the escape hatch for a DB you have *independently verified* already has everything
> and do not want to re-run. It records reality without creating objects. Prefer the `apply` path
> above unless you have a specific reason — re-running idempotent files is safe and proves state.

## Going forward

- New schema change → add a `db/<name>.sql` file (idempotent, as today) and its `db/schema.ts` mirror.
- Apply it everywhere with `npm run db:migrate:apply` instead of pasting into the Neon editor.
- CI can gate on `npm run db:migrate:status` to flag environments with `PENDING`/`DRIFTED` files.
