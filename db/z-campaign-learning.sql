-- db/z-campaign-learning.sql — A/B tests and what a campaign taught. Plan §9.8.
-- Code: src/utils/campaign-learning.ts. Drizzle mirror: db/schema.ts (campaignExperiments,
-- campaignExperimentJobs, campaignLearnings).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-learning                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-learning --url-var DATABASE_URL_PROD  (prod)
--
-- New tables only — nothing existing is altered, so no current read can break before this lands.
-- (The order action `ab_test_posts` needs no constraint change: campaign_orders.action is unchecked.)
--
-- ── campaign_experiments + campaign_experiment_jobs ─────────────────────────
-- "Test angle X vs Y." One order drafts N posts per angle; each drafting job is tagged with its
-- variant HERE rather than in a new content_generation_jobs column, because that table is read by
-- several workers and a new column there is a deploy-order hazard for all of them. The tag is what
-- the drafting worker reads to give each job ITS angle — without it both halves of the test would
-- be drafted with whichever angle the blueprint picked, and the "test" would compare a thing to
-- itself.
--
-- ── campaign_learnings ──────────────────────────────────────────────────────
-- What the user chose to keep from a finished campaign or a concluded test. Read by the Campaign
-- Assistant's chat when it plans the NEXT campaign (so nobody starts from zero). If the user also
-- applies one to drafting, it is written as a content_rules row on each writing assistant the
-- campaign briefed — visible and deletable in that assistant's Rules tab — and the id is kept here.
-- campaign_id is SET NULL: a lesson outlives the campaign it came from.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_experiments (
    id                 SERIAL PRIMARY KEY,
    organisation_id    INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    campaign_id        INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    order_id           INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL,
    hypothesis         TEXT NOT NULL,
    angle_a            TEXT NOT NULL,
    angle_b            TEXT NOT NULL,
    posts_per_variant  INTEGER NOT NULL CHECK (posts_per_variant BETWEEN 1 AND 20),
    created_at         TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_experiments_campaign_idx ON campaign_experiments (campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_experiments_order_uidx ON campaign_experiments (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_experiment_jobs (
    job_id         INTEGER PRIMARY KEY REFERENCES content_generation_jobs(id) ON DELETE CASCADE,
    experiment_id  INTEGER NOT NULL REFERENCES campaign_experiments(id) ON DELETE CASCADE,
    variant        TEXT NOT NULL CHECK (variant IN ('A','B'))
);
CREATE INDEX IF NOT EXISTS campaign_experiment_jobs_exp_idx ON campaign_experiment_jobs (experiment_id, variant);

CREATE TABLE IF NOT EXISTS campaign_learnings (
    id                    SERIAL PRIMARY KEY,
    organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    campaign_id           INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    learning              TEXT NOT NULL,
    source                TEXT NOT NULL CHECK (source IN ('summary','test','user')),
    applied_to_drafting   BOOLEAN NOT NULL DEFAULT FALSE,
    created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_learnings_org_idx ON campaign_learnings (organisation_id, created_at DESC);

COMMIT;

-- RLS: deliberately not enabled, as for every campaign table — see the foot of db/campaigns.sql.
