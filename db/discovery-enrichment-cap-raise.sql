-- db/discovery-enrichment-cap-raise.sql
-- Raise the per-run paid-enrichment cap, 25 → 200.  §5 of docs/lead-generator-completeness-plan.md
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- §5 removed RATING from the contact-lookup rule: every company gets its site read, and every
-- confirmed company is worth buying an address for, whatever it scored. At a cap of 25 that change
-- does almost nothing — the cap simply becomes the new gate. Measured on prod 2026-08-25: job 23
-- found 120 leads and made NINE paid lookups, because so little was eligible to begin with.
--
-- 200 × £0.008 ≈ £1.60 per run, against ~£0.20 today. It is a ceiling, not a target: the waterfall
-- only pays for leads the free scrape missed, and that has been running at roughly two in three.
--
-- ⚠️ THE DEFAULT ALONE IS NOT ENOUGH. Changing the column default affects only rows inserted after
-- it. Every existing campaign holds a literal 25, so without the UPDATE below the change reaches
-- new campaigns and silently rations every campaign a customer already has — which is exactly the
-- population this was built for.
--
-- ── Apply ────────────────────────────────────────────────────────────────────
--   staging:  npm run db:migrate:apply -- --only discovery-enrichment-cap-raise.sql
--   prod:     npm run db:migrate:apply -- --only discovery-enrichment-cap-raise.sql --url-var DATABASE_URL_PROD
--
-- Idempotent and re-runnable: the UPDATE is guarded on the OLD value, so a second run is a no-op
-- and an operator who has since tuned a campaign by hand does not have their number overwritten.

-- ⚠️ ORDER-INDEPENDENT ON PURPOSE. The runner applies db/*.sql ALPHABETICALLY, and
-- "discovery-enrichment-cap-raise.sql" sorts BEFORE "discovery-enrichment-cap.sql" — hyphen (0x2D)
-- precedes dot (0x2E). So on any database where the original cap migration has not run, this file
-- would execute FIRST and die on a column that does not exist yet, taking the rest of the batch
-- with it. As of 2026-08-25 the staging ledger lists discovery-enrichment-cap.sql as pending, and
-- that ledger has been wrong in both directions before — so this must not depend on it either way.
--
-- ADD COLUMN IF NOT EXISTS is a no-op when the column is already there, and creates it correctly
-- when it is not. The SET DEFAULT below then applies whichever branch was taken.
ALTER TABLE discovery_guardrails
    ADD COLUMN IF NOT EXISTS max_enrichment_calls_per_run integer NOT NULL DEFAULT 200;

ALTER TABLE discovery_guardrails
    ALTER COLUMN max_enrichment_calls_per_run SET DEFAULT 200;

-- Only rows still sitting on the old default. A campaign someone deliberately set to 40 keeps 40.
UPDATE discovery_guardrails
   SET max_enrichment_calls_per_run = 200
 WHERE max_enrichment_calls_per_run = 25;

-- Report what moved, so the operator sees it rather than trusting a silent success.
SELECT count(*) FILTER (WHERE max_enrichment_calls_per_run = 200) AS at_new_cap,
       count(*) FILTER (WHERE max_enrichment_calls_per_run NOT IN (200)) AS hand_tuned,
       count(*) AS total
  FROM discovery_guardrails;
