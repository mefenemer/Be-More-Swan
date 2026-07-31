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
-- RUN ORDER: staging first, sections 1 → 2 → 3, then repeat on prod. Section 4 is optional and is a
-- judgement call, not a step. Every statement is idempotent.


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


-- ═══ SECTION 4 — OPTIONAL: give the existing backlog a fresh 30 days ════════════════════════════
-- A judgement call, not a required step, and the reason section 3 exists.
--
-- The rule promises a 30-day visible countdown. Cards that already exist have never had one — they
-- were created under the old "keeps for ever" behaviour, so a user who saw one in their library had
-- no reason to think it was temporary. If section 3's due_now is anything other than a handful of
-- obvious throwaways, run this ONCE, on the day you deploy, to stamp the backlog as kept. They then
-- behave exactly like a card the user pressed Keep on: permanent, and the new rule applies only to
-- cards generated from here on.
--
-- The conservative choice, and reversible in one statement (set library_kept_at back to NULL for
-- the ids you stamped). The alternative — letting the backlog go on the first run — reclaims
-- prod's ~26 cards immediately but removes assets nobody was warned about.
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
