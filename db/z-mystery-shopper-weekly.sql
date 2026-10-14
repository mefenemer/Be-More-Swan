-- db/z-mystery-shopper-weekly.sql — Mystery Shopper step 4 (docs/mystery-shopper-plan.md §4.5).
-- Code: src/utils/site-audit-schedule.ts, src/utils/site-audit.ts, src/utils/site-audit-setup.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys — the pipeline
-- writes page_url on every new fix, so the insert fails without it. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-mystery-shopper-weekly                              (staging)
--   npm run db:migrate:apply -- --only z-mystery-shopper-weekly --url-var DATABASE_URL_PROD  (prod)
--
-- page_url: which page a fix was suggested for. A fix is verified ("done") when a later check no
-- longer finds its old wording — which is only meaningful on the SAME page. Without this, moving the
-- audit to the pricing page would mark every homepage fix done, because none of the homepage's old
-- wording is on the pricing page. NULL (fixes written before this column) = the audit's page at the
-- time, which is what they were.
--
-- The index serves the daily dispatcher: active audits by check day.

BEGIN;

ALTER TABLE site_audit_fixes ADD COLUMN IF NOT EXISTS page_url TEXT;

UPDATE site_audit_fixes f
   SET page_url = a.url
  FROM site_audits a
 WHERE a.id = f.audit_id AND f.page_url IS NULL;

CREATE INDEX IF NOT EXISTS site_audits_dispatch_idx ON site_audits (status, check_weekday);

COMMIT;
