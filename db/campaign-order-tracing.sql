-- db/campaign-order-tracing.sql
-- Links a content generation job back to the campaign order that commissioned it.
--
-- ── Why this column has to exist ────────────────────────────────────────────────────────────────
-- `draft_social_posts` and `draft_blog_pillar` are the only two orders that produce real work, and
-- until now they recorded NOTHING about what they produced: the executors insert N
-- content_generation_jobs rows and return a prose summary, leaving artefact_kind/artefact_id null.
-- That made the order → artefact direction unanswerable, so nothing could ever move an order off
-- 'issued'. The Orders tab is described to the user as "where you check whether a campaign actually
-- produced anything" and it could not answer, because the join did not exist.
--
-- artefact_id on campaign_orders is deliberately NOT the place for this: it is a single integer and
-- one order fans out to as many as 20 jobs. The link belongs on the many side.
--
-- ── Idempotent, and safe on a table with rows ───────────────────────────────────────────────────
-- Nullable with no default and no backfill. Every existing job row keeps campaign_order_id = NULL,
-- which reads correctly: those jobs were not commissioned by a campaign. Orders placed BEFORE this
-- column existed therefore have no jobs pointing at them, and the reconciler leaves them alone
-- rather than guessing — see the `unknowable` branch in src/utils/campaign-reconciler.ts. Both
-- environments have zero campaign_orders rows as of 2026-08-07, so in practice there is nothing to
-- strand.
--
-- ⚠️ Apply to STAGING and PROD separately — they are different Neon branches.

ALTER TABLE content_generation_jobs
    ADD COLUMN IF NOT EXISTS campaign_order_id integer;

DO $$
BEGIN
    -- ON DELETE SET NULL, not CASCADE: deleting an order must never delete the drafting work it
    -- commissioned. The posts are the user's, and they outlive the campaign that asked for them.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'content_generation_jobs_campaign_order_id_fkey'
    ) THEN
        ALTER TABLE content_generation_jobs
            ADD CONSTRAINT content_generation_jobs_campaign_order_id_fkey
            FOREIGN KEY (campaign_order_id) REFERENCES campaign_orders(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Partial: the overwhelming majority of jobs are not campaign work, and the reconciler only ever
-- selects rows WHERE campaign_order_id IS NOT NULL.
CREATE INDEX IF NOT EXISTS content_generation_jobs_campaign_order_idx
    ON content_generation_jobs (campaign_order_id)
 WHERE campaign_order_id IS NOT NULL;

COMMENT ON COLUMN content_generation_jobs.campaign_order_id IS
  'The campaign_orders row that commissioned this job, or NULL for ordinary (non-campaign) drafting. Read by src/utils/campaign-reconciler.ts to decide when an order has been delivered.';

-- ── Verify (run after applying, on each environment) ────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'content_generation_jobs' AND column_name = 'campaign_order_id';
-- SELECT conname FROM pg_constraint
--  WHERE conname = 'content_generation_jobs_campaign_order_id_fkey';
-- SELECT indexname FROM pg_indexes
--  WHERE indexname = 'content_generation_jobs_campaign_order_idx';
