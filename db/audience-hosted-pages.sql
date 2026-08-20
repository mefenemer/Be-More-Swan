-- db/audience-hosted-pages.sql
-- A sign-up page we host, for the customers who have no website to embed a form in.
-- Requires db/audience.sql.
--
-- ── Why this is three columns and not a table ───────────────────────────────────────────────────
-- A hosted page is not a new thing to sign up to — it is a second way to reach a form that already
-- exists, with its own consent text, its own double opt-in setting, its own segment and its own
-- key. Giving it a table of its own would mean two records that both decide what a subscriber
-- agreed to, and the one that drifts is the one shown to the person signing up.
--
-- ⚠️ OFF BY DEFAULT, and that is the point of the flag rather than inferring it from the form
-- existing. A public URL on our domain, carrying a tenant's name and collecting real addresses, is
-- something they should switch on deliberately — and a form built for an embed on a locked-down
-- site should not silently become a page anyone can post to.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE: audience-forms.ts reads these columns with a bare
-- db.select().

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audience_forms') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/audience-hosted-pages.sql requires db/audience.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

-- ⚠️ The switch that makes /s/<public_key> answer at all. It is ALSO what lets the page post to a
-- form whose allowed_origins lock it to the tenant's own site: the origin check accepts our own
-- base url only when this is true, rather than being relaxed for everybody.
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS hosted_enabled  BOOLEAN NOT NULL DEFAULT false;

-- What the page says above the form. Optional: the form's own name is the fallback heading, so a
-- tenant who switches it on without writing anything still gets a page that reads properly.
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS hosted_headline TEXT;
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS hosted_intro    TEXT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'audience_forms' AND column_name LIKE 'hosted_%';
