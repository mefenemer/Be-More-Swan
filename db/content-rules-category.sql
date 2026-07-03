-- Assistant Rules → per-assistant Content Rules: add an optional `category` column.
--
-- "Assistant Rules" used to be an org-global, side-menu page (workspace_assets, asset_type='text')
-- that never reached the assistant's brief. Rules now live per-assistant in content_rules, which
-- IS injected into the brief (assemble-blueprint § 4-content-rules → process-content-jobs system
-- prompt). This column preserves the familiar 4-section grouping in the editor and lets the brief
-- label each rule by category.
--
-- Allowed values (enforced in the UI, not the DB, so legacy NULLs and future categories are fine):
--   tone_of_voice | response_formatting | core_knowledge | target_audience
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can propose
-- DISABLE ROW LEVEL SECURITY / DROP POLICY. This plain ALTER cannot touch RLS; the new column
-- inherits the table's grants + row policies automatically. Idempotent — safe to re-run.

ALTER TABLE content_rules ADD COLUMN IF NOT EXISTS category text;
