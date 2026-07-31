-- db/brand-card-lifecycle.sql
-- Lifecycle for auto-generated brand cards: "unused expires, edited is kept."
--
-- ⚠️ APPLY THIS BEFORE THE CODE DEPLOYS. content-assets.ts (GET) and content-retention.ts both
-- SELECT library_kept_at by name. Deploying the code first makes My Content fail its listing query
-- until the column exists — the handler degrades to an empty library rather than a 500, but the
-- user sees nothing in their content hub, so do not rely on that as a grace period.
--
-- ── What the rule is ────────────────────────────────────────────────────────────────────────────
-- A brand card that was NEVER attached to a post and has NEVER been opened in the card editor is
-- removed 30 days after it was generated. My Content shows the countdown on the card from the day
-- it appears, with a Keep action that makes it permanent.
--
-- Everything else stays exactly as it was:
--   • attached to a post (ever, any status) → follows the post's own retention (posted 30d /
--     rejected 7d), which already existed
--   • saved in the review-time card editor, or Kept from My Content → library_kept_at is stamped
--     and the card never expires
--
-- Why an exemption column rather than "just expire unused media": edit-brand-card.ts exists
-- precisely so a user can tweak a generated card, and users do reuse cards from My Content. A rule
-- that silently removed a card someone had adjusted by hand would delete real work. NULL vs
-- NOT NULL on this column is the whole difference between machine output and a person's edit.
--
-- Why cards needed a rule at all: measured on PROD 2026-07-31, of 115 content_assets rows only 30
-- had a storage_key (real R2 bytes) and 26 of those 30 were provider='brand_card'. Cards were
-- effectively the entire R2 footprint of post media, and nothing ever set retention_delete_after on
-- one, so content-retention.ts could never reclaim any of them. See the header of
-- db/content-assets-leak-backfill.sql, which deliberately left brand cards in its REVIEW tier and
-- out of its UPDATE, pending this decision.
--
-- ⚠️ This file does NOT purge anything, and nothing here is retroactive in the destructive sense you
-- might fear: it adds one nullable column. The reclaiming is done by the audited reclaimer,
-- content-retention.ts (05:00 UTC daily), which deletes the R2 object by storage_key and only then
-- stamps purged_at. Section 3 below is the read-only preview of what that job will pick up on its
-- first run after this ships — READ IT before you deploy, because every card older than 30 days
-- becomes due immediately (see section 4 for how to give existing cards a fresh window instead).
--
-- RUN ORDER: staging first, sections 1 → 2 → 3, then repeat on prod. Every statement is idempotent.
--
-- ── DRY RUN RESULTS, 2026-07-31 ─────────────────────────────────────────────────────────────────
-- STAGING (ep-blue-truth, assistant1_org=10): 33 content_assets, 3 with a storage_key, and ZERO
--   brand cards. Section 3 executed cleanly and returned all zeros — which proves the SQL parses
--   and does not over-match, and proves nothing else. Do not read it as reassurance.
-- PROD (assistant1_org=37): 7 unused cards out of 26 brand cards; 19 correctly excluded by the
--   attachment checks; NONE due on the first sweep (earliest expiry 2026-08-23). This was the only
--   real dry run. See section 4 — it is not needed, and why.


-- ═══ SECTION 0 — which database am I in? ════════════════════════════════════════════════════════
-- Assistant #1's organisation is the tell (see the local-env-points-at-stale-db note): staging is
-- ep-blue-truth with assistant 1 in org 10.
SELECT current_database(),
       (SELECT organisation_id FROM ai_assistants ORDER BY id LIMIT 1) AS first_assistant_org;


-- ═══ SECTION 1 — the column ═════════════════════════════════════════════════════════════════════
ALTER TABLE content_assets
  ADD COLUMN IF NOT EXISTS library_kept_at timestamp;

COMMENT ON COLUMN content_assets.library_kept_at IS
  'Set when a human saved this asset in the brand-card editor or pressed Keep in My Content. Read only as an exemption from the 30-day unused-brand-card expiry (src/utils/brand-card-lifecycle.ts).';


-- ═══ SECTION 2 — confirm it landed ══════════════════════════════════════════════════════════════
-- All four columns the lifecycle needs must be present. If any row is missing, STOP.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'content_assets'
  AND column_name IN ('library_kept_at','retention_delete_after','purged_at','render_params','storage_key','provider')
ORDER BY column_name;


-- ═══ SECTION 3 — READ-ONLY PREVIEW: what will the first sweep pick up? ══════════════════════════
-- This is the same predicate content-retention.ts applies (provider='brand_card', not purged, no
-- library_kept_at, no clock already running, older than 30 days, and referenced by NO post through
-- either the junction table or the legacy content_asset_ids array).
--
-- Read this row by row before deploying. "due_now" is the count that becomes purgeable on the very
-- first 05:00 UTC run — these cards will have had NO visible countdown, because the countdown only
-- starts appearing in My Content once the code ships.
WITH candidates AS (
  SELECT ca.id, ca.organisation_id, ca.name, ca.created_at, ca.file_size, ca.storage_key
  FROM content_assets ca
  WHERE ca.provider = 'brand_card'
    AND ca.purged_at IS NULL
    AND ca.library_kept_at IS NULL
    AND ca.retention_delete_after IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ca.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_posts sp
      WHERE sp.organisation_id = ca.organisation_id
        AND sp.content_asset_ids @> to_jsonb(ARRAY[ca.id])
    )
)
SELECT count(*)                                                              AS unused_cards,
       count(*) FILTER (WHERE created_at <= now() - INTERVAL '30 days')      AS due_now,
       count(*) FILTER (WHERE created_at >  now() - INTERVAL '30 days')      AS still_in_window,
       pg_size_pretty(coalesce(sum(file_size) FILTER (WHERE created_at <= now() - INTERVAL '30 days'), 0)) AS bytes_due_now
FROM candidates;

-- The individual rows behind that count. Look at the names — the headline is in there, so you can
-- see whether these read as abandoned machine output or as something a user would miss.
WITH candidates AS (
  SELECT ca.id, ca.organisation_id, ca.name, ca.created_at, ca.file_size
  FROM content_assets ca
  WHERE ca.provider = 'brand_card'
    AND ca.purged_at IS NULL
    AND ca.library_kept_at IS NULL
    AND ca.retention_delete_after IS NULL
    AND NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ca.id)
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_posts sp
      WHERE sp.organisation_id = ca.organisation_id
        AND sp.content_asset_ids @> to_jsonb(ARRAY[ca.id])
    )
)
SELECT id, organisation_id, name, created_at,
       (created_at + INTERVAL '30 days') AS expires_at,
       created_at <= now() - INTERVAL '30 days' AS due_on_first_run
FROM candidates
ORDER BY created_at;


-- ═══ SECTION 4 — NOT NEEDED. Measured on PROD 2026-07-31 — do not run. ═════════════════════════
--
-- This section existed as a safety valve: the rule promises a 30-day VISIBLE countdown, and cards
-- created under the old "keeps for ever" behaviour never had one, so anything already past 30 days
-- would have been deleted with no warning ever shown. The fix would have been to stamp the whole
-- backlog as kept.
--
-- ── The prod dry run says that cannot happen ────────────────────────────────────────────────────
-- Section 3, run against prod (organisation_id 37) on 2026-07-31:
--
--   7 unused cards, ALL with due_on_first_run = false
--   created 2026-07-24 → 2026-07-27, expiring 2026-08-23 → 2026-08-26
--
-- Not one is due on the first sweep. The earliest removal is 23 days after the decision date, so
-- every existing card gets a full countdown in My Content from the moment the code ships — which is
-- exactly the fairness condition this section was written to guarantee. Running it anyway would
-- make 7 cards permanently exempt to prevent a harm that cannot occur.
--
-- ── The other thing that run established ────────────────────────────────────────────────────────
-- 7 of prod's 26 brand cards matched; 19 were excluded by the two NOT EXISTS attachment checks. The
-- predicate DISCRIMINATES — it is not just selecting every row with provider='brand_card'. Staging
-- could never show this (it holds 0 brand cards, so its section 3 returned zeros that proved only
-- that the SQL parses). Prod was the first and only real dry run.
--
-- ⚠️ RE-RUN SECTION 3 BEFORE DEPLOYING if that is more than a few weeks after 2026-07-31. The
-- "nothing is due" finding has a shelf life measured in days: these cards start becoming due on
-- 2026-08-23. Deploy after that date and the first sweep WILL reclaim some of them, and the
-- judgement below has to be made again on fresh numbers.
--
-- The statement is kept, commented, for that case only.
--
-- UPDATE content_assets
-- SET library_kept_at = now(), updated_at = now()
-- WHERE provider = 'brand_card'
--   AND purged_at IS NULL
--   AND library_kept_at IS NULL
--   AND created_at <= now();   -- everything that predates the deploy


-- ═══ SECTION 5 — after the first sweep, what happened? ══════════════════════════════════════════
-- Cards the sweep put on the clock, and cards the reclaimer has since purged.
SELECT count(*) FILTER (WHERE retention_delete_after IS NOT NULL AND purged_at IS NULL) AS clocked_not_yet_purged,
       count(*) FILTER (WHERE purged_at IS NOT NULL)                                    AS purged,
       count(*) FILTER (WHERE library_kept_at IS NOT NULL)                              AS exempt_kept_or_edited,
       count(*)                                                                          AS all_brand_cards,
       min(retention_delete_after) FILTER (WHERE purged_at IS NULL)                      AS next_purge_due
FROM content_assets
WHERE provider = 'brand_card';
