-- Per-run ceiling on PAID contact lookups (tier-2 enrichment).
--
-- ⚠️ MANUAL APPLY (npm run db:migrate:apply). No drizzle-kit push — see docs/db-migrations.md.
-- The matching column in db/schema.ts MUST stay in sync or a future push drops this.
--
-- ── Why a dedicated cap ──────────────────────────────────────────────────────
-- max_cost_gbp_per_run already exists and defaults to £2.00, which at a typical per-lookup price
-- is several hundred purchases — far too loose to be the only thing standing between a
-- misconfigured campaign and a bill. Search calls have had their own cap since day one for the
-- same reason; buying third-party data about named individuals deserves at least as much.
--
-- 25 is deliberately smaller than max_leads_per_run (50): the free scraper handles roughly a third
-- of hot/warm leads on its own, so a run that needs more than 25 purchases is a run whose
-- targeting is wrong, and the right response is to notice that rather than to spend through it.
--
-- ⚠️ This cap only ever binds when DISCOVERY_ENRICH_PROVIDER names a provider AND its key is set.
-- Unconfigured — the default — nothing is bought and the column is inert, so this migration is
-- safe to apply well ahead of any decision about a vendor.
--
-- Attempts are counted from a `paidLookupAt` stamp in discovered_leads.signals rather than a new
-- counter on discovery_jobs, mirroring how `enrichAttemptedAt` already works: the stamp is written
-- on a MISS as well as a hit, so the cap counts what was SPENT rather than what was found.
--
-- Additive with a default: every existing campaign gets 25 without a backfill. Idempotent.

ALTER TABLE discovery_guardrails
    ADD COLUMN IF NOT EXISTS max_enrichment_calls_per_run integer NOT NULL DEFAULT 25;

COMMENT ON COLUMN discovery_guardrails.max_enrichment_calls_per_run IS
    'Ceiling on PAID contact lookups per run (tier-2 enrichment). Counts attempts, not hits. Inert unless DISCOVERY_ENRICH_PROVIDER is configured.';
