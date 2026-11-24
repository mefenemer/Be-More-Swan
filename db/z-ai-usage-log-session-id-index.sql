-- db/z-ai-usage-log-session-id-index.sql — index ai_usage_log.session_id (cost audit, docs/cost-logging-audit.md).
--
-- Why: a Remotion render whose worker was killed is logged by the stuck sweeps, which first check whether a cost row
-- for that render already exists, by its per-render session id (src/utils/render-cost.ts logOrphanedRenderCost,
-- PR #844). ai_usage_log had no index at all, so that check read the whole table. The Video Producer sweep runs
-- inside user requests (the Videos tab, each chat turn).
--
-- Run on BOTH databases. Additive and idempotent (IF NOT EXISTS). Partial: only rows that carry a session id.
--
-- ⚠️ ONE statement, on purpose: CREATE INDEX CONCURRENTLY can't run inside a transaction block, and db-migrate.mjs
-- sends a file as one query (several statements in one query are one implicit transaction). CONCURRENTLY builds the
-- index without locking ai_usage_log against the inserts every AI call makes. In the Neon SQL editor, run it on its own.
-- If a build is interrupted it can leave an INVALID index of this name. Then run DROP INDEX CONCURRENTLY
-- ai_usage_log_session_id_idx on its own and run this again (IF NOT EXISTS would otherwise skip it).

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_log_session_id_idx ON ai_usage_log (session_id) WHERE session_id IS NOT NULL
