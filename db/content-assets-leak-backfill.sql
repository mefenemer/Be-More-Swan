-- db/content-assets-leak-backfill.sql
-- Identify and reclaim post media that leaked from R2 while archive-cleanup / reject-post were
-- soft-deleting the WRONG TABLE (workspace_assets, using content_assets ids, filtered on an
-- asset_type that table's post-media rows never hold). Fixed in code 2026-07-30; this script is for
-- the debt that accumulated before the fix.
--
-- ⚠️ NOTHING HERE DELETES ANYTHING. Reclamation is done by handing rows to the audited reclaimer:
-- content-retention.ts (05:00 UTC daily) deletes the R2 object by storage_key and only then stamps
-- purged_at. This script's single write sets `retention_delete_after`, i.e. it starts a clock. Rows
-- stay fully intact and recoverable until that date passes and the cron confirms each delete.
--
-- ══ ⚠️ READ THIS FIRST: SECTION 3 IS A CONFIRMED NO-OP IN BOTH ENVIRONMENTS (2026-07-31) ═════════
--
-- Measured fingerprint coverage across ALL content_assets rows:
--
--                        overlay_bakes   brand_cards   dangling scheduled_post_id   with storage_key   total
--   PROD                       0             26                    0                      30           115
--   STAGING                    0              0                    0                       3            33
--
-- Tier 1 needs a dangling `scheduled_post_id`; NO row in either database has that column set at all
-- (current code only ever CLEARS it, on detach — it is written by nothing). Tier 2 needs an
-- `overlay_bake` render_params; there are none. So the section 3 UPDATE matches zero rows on prod and
-- zero on staging. Running it is harmless but pointless — do not read a "0 rows" result as success.
--
-- Where prod's R2-backed rows actually are: 26 of 30 are brand cards, and those are NOT invisible
-- orphans. content-assets.ts (GET) lists every content_assets row the user owns, hides only
-- purged_at rows, and resolves a display URL for each — so an unreferenced brand card is sitting in
-- that user's "My Content" library as a reusable asset under a derived status. Reclaiming it would
-- delete something the user can currently see. That is a PRODUCT decision about whether
-- auto-generated cards accumulate in a library forever, not a storage bug, which is why brand cards
-- stay in the review tier and out of the UPDATE.
--
-- NET: the code fixes stop new leaks. The accumulated debt this script was written to reclaim is,
-- as measured, approximately nothing — most post media is Pexels hotlinks with no R2 bytes to leak
-- (85 of prod's 115 rows have no storage_key). Keep the script as the diagnostic; re-run section 1
-- after a few archive-cleanup cycles, when rows carrying the new fingerprints have had time to appear.
--
--
-- ── STAGING DRY RUN, 2026-07-31 (ep-blue-truth, assistant1_org=10) ──────────────────────────────
-- Every query below EXECUTED cleanly, and all four columns the reclaimer needs are present on the
-- live table (retention_delete_after, purged_at, render_params, storage_key) — so there is no DDL to
-- apply. But the run found NOTHING to remediate, and could not validate the predicate:
--
--   section 2 (the rows the UPDATE would clock)  →  0
--   overlay_bakes = 0   brand_cards = 0   rows with a dangling scheduled_post_id = 0
--   only 3 of 33 content_assets rows have a storage_key at all (the rest are Pexels hotlinks)
--   tier 4 "origin unprovable" = 2 rows / 1.48 MB — the bucket this script deliberately leaves alone
--
-- So staging proved the SQL runs and does not over-match. It did NOT prove tiers 1-2 select the right
-- rows, because staging holds no row exhibiting either fingerprint. PROD (115 content_assets vs
-- staging's 33) is where the debt is, which makes prod's section 2 the FIRST real dry run — read it
-- row by row before committing section 3, and do not treat "staging was clean" as reassurance.
--
-- RUN ORDER: staging first — sections 0 → 1 → 2 → 3 → 4, checking the output of each before the next
-- — then repeat the whole thing on prod once staging's numbers look right. Section 0 tells you which
-- DB you are in. Every statement is idempotent: re-running changes nothing it has already done.
--
-- ⚠️ Run ONE SECTION AT A TIME, not the whole file in one go. Section 3 opens a transaction and
-- deliberately leaves COMMIT commented out, so pasting everything at once would run sections 4-6
-- inside that open transaction and read your own uncommitted write as though it were done.
--
-- Each section stands alone: the leaked-set predicate is repeated in sections 2, 3 and 5 rather than
-- held in a temp view, because the Neon console does not guarantee one session across statements. If
-- you change the predicate, change all three — section 2 is the dry run for section 3, and they are
-- only meaningful while they match.
--
--
-- ══ WHAT COUNTS AS "LEAKED", AND WHY THIS IS NARROWER THAN IT LOOKS ═══════════════════════════════
--
-- An unreferenced content_assets row is NOT automatically an orphan. content_assets is ALSO the
-- user-facing media library ("My Content" / "My AI Uploads"), where an asset attached to no post is
-- the normal resting state. Sweeping every unreferenced row into a purge clock would delete users'
-- uploaded libraries. So the remediation below touches only rows that PROVE, from their own columns,
-- that the post they belonged to is gone:
--
--   TIER 1  content_assets.scheduled_post_id points at a scheduled_posts row that no longer exists.
--           That column has NO foreign key (db/schema.ts:1686 — a bare integer, unlike the junction's
--           .references(..., onDelete:'cascade')), so a post delete leaves the pointer dangling
--           instead of clearing it. A dangling pointer is direct evidence of attachment + deletion.
--
--   TIER 2  render_params->>'kind' = 'overlay_bake' and render_params->>'postId' names a post that no
--           longer exists. A baked overlay image is the flattened per-post artifact produced by
--           save-post-overlays / attach-draft-media; it exists to serve exactly ONE post and is never
--           library content. It conveniently records its own post id.
--
-- Everything else lands in the REVIEW list (section 5) and is deliberately NOT remediated in bulk,
-- because at that point a leaked asset and a library upload are genuinely indistinguishable:
-- content_assets.status never advances past 'pending'. The schema comments a lifecycle of
-- "pending → scheduled | posted", but no code path in the repo ever writes 'scheduled' or 'posted' to
-- this table — the only status writers set 'rejected' (rejection + release) or 'pending' (detach). So
-- status cannot be used to tell "was committed to a post" from "sits in the library", and any filter
-- that assumes otherwise silently matches nothing.
--
-- Also note what this script does NOT do: it does not touch storage_usage. Those counters are
-- incremented only by storage-confirm-upload.ts, which writes workspace_assets. No content_assets
-- upload path has ever added to used_bytes, so decrementing on purge would subtract bytes that were
-- never counted and understate every affected org's usage.


-- ══ 0. PREFLIGHT — confirm the environment and the columns ════════════════════════════════════════
-- ⚠️ WHICH DATABASE IS THIS? `current_database()` is USELESS here — staging and prod are BOTH named
-- `neondb`. Identify the environment from the DATA, and do it before section 3 writes anything.
--
--   PROD     assistant1_org = 37    orgs ≈ 3-4    ← prod is the SMALL one. Counter-intuitive.
--   STAGING  assistant1_org = 10    orgs ≈ 54     ← the big messy one, incl. the Willowbrook demo org
--
-- Read `assistant1_org`, NOT the org count: prod went 3 → 4 orgs in a single day (2026-07-31), so the
-- count drifts and proves nothing by itself. Prod also holds only ~115 content_assets / ~91
-- scheduled_posts, so a small row count is NOT evidence that you are in staging.
--
-- If assistant1_org is neither 37 nor 10, STOP and establish where you are — a previous session ran a
-- 118-row delete against prod believing it was a test environment.
SELECT (SELECT count(*) FROM organisations)                        AS orgs,
       (SELECT organisation_id FROM ai_assistants WHERE id = 1)    AS assistant1_org,
       (SELECT count(*) FROM content_assets)                       AS content_assets_rows,
       (SELECT count(*) FROM scheduled_posts)                      AS scheduled_posts_rows;

-- The live schema is the authority, never the TypeScript. All of these must be present; if
-- retention_delete_after / purged_at / render_params are missing, STOP — the reclaimer cannot work
-- and no clock should be set.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'content_assets'
  AND column_name IN ('storage_key','retention_delete_after','purged_at','render_params',
                      'scheduled_post_id','file_size','status')
ORDER BY column_name;


-- ══ 1. THE SUSPECT POPULATION, BY TIER ════════════════════════════════════════════════════════════
-- Read this before writing anything. `bytes` is indicative only: content_assets.file_size is
-- nullable and older rows often have none, so the true reclaim is >= what this reports.
WITH unreferenced AS (
    SELECT ca.*
    FROM content_assets ca
    WHERE ca.storage_key IS NOT NULL             -- real R2 bytes (hotlinks/links have none)
      AND ca.purged_at IS NULL                   -- not already reclaimed
      AND ca.retention_delete_after IS NULL      -- no clock running: a released row already has one
      -- referenced by no surviving post, via the junction …
      AND NOT EXISTS (
          SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ca.id
      )
      -- … and via the deprecated JSONB array that is still written alongside it.
      -- The CASE inside the call is load-bearing: jsonb_array_elements_text ERRORS on a non-array
      -- value, and because it sits in FROM it is evaluated BEFORE any WHERE clause could filter that
      -- row out. Guarding in the WHERE would still abort the whole query. (release-post-media.ts has
      -- the same shape with only a `<> '[]'` guard — theoretical there, since the app always writes an
      -- array, but do not copy that form into ad-hoc SQL.)
      AND NOT EXISTS (
          SELECT 1
          FROM scheduled_posts sp
          CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(sp.content_asset_ids) = 'array'
                   THEN sp.content_asset_ids ELSE '[]'::jsonb END
          ) AS x(id)
          WHERE x.id ~ '^[0-9]+$'
            AND x.id::int = ca.id
      )
)
SELECT
    CASE
        WHEN u.scheduled_post_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = u.scheduled_post_id)
            THEN '1 — dangling scheduled_post_id (post deleted)'
        WHEN u.render_params->>'kind' = 'overlay_bake'
             AND u.render_params->>'postId' ~ '^[0-9]+$'
             AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = (u.render_params->>'postId')::int)
            THEN '2 — orphaned overlay bake (post deleted)'
        WHEN u.provider = 'brand_card'
            THEN '3 — REVIEW: unreferenced brand card'
        ELSE '4 — REVIEW: unreferenced, origin unprovable (may be library)'
    END                                                    AS tier,
    count(*)                                               AS row_count,
    pg_size_pretty(COALESCE(SUM(u.file_size), 0)::bigint)   AS bytes,
    min(u.created_at)::date                                AS oldest,
    max(u.created_at)::date                                AS newest
FROM unreferenced u
GROUP BY 1
ORDER BY 1;


-- ══ 2. TIER 1 + TIER 2 DETAIL — exactly what section 3 will touch ═════════════════════════════════
-- The dry run. Eyeball this, and note the row count: section 3 must report the same number.
SELECT ca.id, ca.organisation_id, ca.user_id, ca.name, ca.asset_type, ca.provider,
       ca.storage_key, ca.file_size, ca.status, ca.created_at,
       ca.scheduled_post_id            AS dangling_post_id,
       ca.render_params->>'postId'     AS bake_post_id
FROM content_assets ca
WHERE ca.storage_key IS NOT NULL
  AND ca.purged_at IS NULL
  AND ca.retention_delete_after IS NULL
  AND NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ca.id)
  AND NOT EXISTS (
      SELECT 1
      FROM scheduled_posts sp
      CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(sp.content_asset_ids) = 'array'
               THEN sp.content_asset_ids ELSE '[]'::jsonb END
      ) AS x(id)
      WHERE x.id ~ '^[0-9]+$'
        AND x.id::int = ca.id
  )
  AND (
      -- TIER 1
      (ca.scheduled_post_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = ca.scheduled_post_id))
      OR
      -- TIER 2
      (ca.render_params->>'kind' = 'overlay_bake'
       AND ca.render_params->>'postId' ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = (ca.render_params->>'postId')::int))
  )
ORDER BY ca.organisation_id, ca.created_at;


-- ══ 3. REMEDIATION — start a 30-day retention clock ═══════════════════════════════════════════════
-- 30 days deliberately, not the 7 the live release path uses (REJECTED_RETENTION_MS in
-- release-post-media.ts): this is a bulk hand-driven reclassification of rows nobody has looked at in
-- months, so it gets the same generous grace workspace_assets gets in storage-lifecycle-cleanup. A
-- month of "wait, that was needed" is cheap; the bytes have already survived far longer.
--
-- status is left ALONE. Writing 'rejected' would mark assets as user-rejected in the media library UI,
-- which is a lie about history — content-retention keys off retention_delete_after, not status, so the
-- clock alone is sufficient.
--
-- Run inside the transaction, check the reported row count against section 2, then COMMIT — or
-- ROLLBACK if it disagrees.
BEGIN;

UPDATE content_assets ca
SET retention_delete_after = now() + INTERVAL '30 days',
    updated_at             = now()
WHERE ca.storage_key IS NOT NULL
  AND ca.purged_at IS NULL
  AND ca.retention_delete_after IS NULL
  AND NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ca.id)
  AND NOT EXISTS (
      SELECT 1
      FROM scheduled_posts sp
      CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(sp.content_asset_ids) = 'array'
               THEN sp.content_asset_ids ELSE '[]'::jsonb END
      ) AS x(id)
      WHERE x.id ~ '^[0-9]+$'
        AND x.id::int = ca.id
  )
  AND (
      (ca.scheduled_post_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = ca.scheduled_post_id))
      OR
      (ca.render_params->>'kind' = 'overlay_bake'
       AND ca.render_params->>'postId' ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = (ca.render_params->>'postId')::int))
  );

-- Expect: exactly the row count from section 2.
-- COMMIT;
-- ROLLBACK;


-- ══ 4. VERIFICATION — after COMMIT ════════════════════════════════════════════════════════════════
-- What is now queued, and when the cron will act on it.
SELECT count(*)                                            AS queued_for_reclaim,
       pg_size_pretty(COALESCE(SUM(file_size),0)::bigint)   AS bytes_queued,
       min(retention_delete_after)                         AS first_purge_due
FROM content_assets
WHERE retention_delete_after IS NOT NULL
  AND purged_at IS NULL
  AND storage_key IS NOT NULL;

-- Re-run section 1: tiers 1 and 2 must both report 0 rows (their clock is now set, so they no longer
-- satisfy `retention_delete_after IS NULL`). Tiers 3 and 4 are unchanged by design.
--
-- Then confirm the reclaimer actually drains it. content-retention runs at 05:00 UTC; 30 days after
-- this run the queue should trend to zero. If rows sit past their date with storage_key still
-- populated, the cron is deferring them — check the function logs for "R2 not configured" or a
-- per-key delete failure, and confirm the function is actually deployed.


-- ══ 5. THE REVIEW LIST — NOT for bulk remediation ═════════════════════════════════════════════════
-- Tiers 3 and 4: unreferenced, unpurged, no clock, real bytes, and no way to prove from the row
-- whether it was post media or something a user uploaded to their library and simply has not used.
-- Bounded to rows older than 37 days (the 30-day archive window plus the 7-day release grace) so
-- nothing still in flight appears here.
--
-- Look at this list, then decide per organisation — ideally with the workspace owner. Do NOT paste an
-- UPDATE over the whole thing.
SELECT ca.id, ca.organisation_id, ca.user_id, ca.name, ca.asset_type, ca.provider,
       ca.status, (ca.prompt IS NOT NULL) AS ai_generated,
       ca.render_params->>'kind'          AS render_kind,
       ca.file_size, ca.created_at
FROM content_assets ca
WHERE ca.storage_key IS NOT NULL
  AND ca.purged_at IS NULL
  AND ca.retention_delete_after IS NULL
  AND ca.created_at < now() - INTERVAL '37 days'
  AND NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ca.id)
  AND NOT EXISTS (
      SELECT 1
      FROM scheduled_posts sp
      CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(sp.content_asset_ids) = 'array'
               THEN sp.content_asset_ids ELSE '[]'::jsonb END
      ) AS x(id)
      WHERE x.id ~ '^[0-9]+$'
        AND x.id::int = ca.id
  )
  -- exclude tiers 1-2, which section 3 has already given a clock (belt and braces: after a COMMIT
  -- the retention_delete_after IS NULL test above already excludes them)
  AND NOT (
      (ca.scheduled_post_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = ca.scheduled_post_id))
      OR
      (ca.render_params->>'kind' = 'overlay_bake'
       AND ca.render_params->>'postId' ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.id = (ca.render_params->>'postId')::int))
  )
ORDER BY ca.file_size DESC NULLS LAST, ca.created_at
LIMIT 500;


-- ══ 6. A LOOSE END WORTH KNOWING ABOUT ════════════════════════════════════════════════════════════
-- Rows already stamped purged_at whose storage_key was nulled while the R2 object survived. That was
-- content-retention's second historical bug (it stamped purged regardless of whether the S3 delete —
-- against a bucket that was never configured — had done anything), and it is UNFIXABLE from the
-- database: the key was the only record of where the object lived. These bytes can only be found by
-- listing the bucket and diffing against live storage_keys, which is an R2-side job, not a SQL one.
SELECT count(*)             AS purged_rows_with_no_key_record,
       min(purged_at)::date AS earliest,
       max(purged_at)::date AS latest
FROM content_assets
WHERE purged_at IS NOT NULL
  AND storage_key IS NULL;
