-- docs/ops/2026-10-18-discard-non-company-leads.sql
-- One-off cleanup: move pre-fix non-company leads out of the Leads tab.
--
-- ⚠️ NOT a migration — it lives outside db/ on purpose so the migrate runner never picks it up.
-- Paste each step into the Neon SQL Editor yourself: STAGING first, then PROD.
--
-- ⚠️ ORDER: deploy the code that adds the 'not_a_business' retention reason FIRST (the PR this
-- file ships in). Before that deploy, the Deleted section shows an unknown reason as "Dropped".
--
-- ── Why ─────────────────────────────────────────────────────────────────────
-- Until PR #416 (2026-10-18), every scored search result went into the Leads tab, including the
-- ones the scorer had already classified as NOT a business: articles/blog posts (content_page),
-- directories (aggregator), publishers (media), suppliers (supplier_to_target) and platforms.
-- The worker now discards these before they become leads. This cleans up the ones that got in
-- before the fix.
--
-- ── What it does (the same as pressing Delete, apart from the reason) ───────
--   • assistant_records: approval_status → 'rejected', scheduled_for → NULL, and
--     data.retention = { deletedAt, reason: 'not_a_business' }. The lead moves to the Deleted
--     section, where "Send back for enrichment" can still restore it.
--   • discovered_leads (its linked rows) → status 'discarded'.
--   Nothing is hard-deleted.
--
-- ── What it deliberately leaves alone ───────────────────────────────────────
--   • Anything a person has already acted on: approved / scheduled / rejected, already in Deleted,
--     outreach marked sent, moved by hand (outreachStage), a deal outcome, an email thread, or
--     "Send back for enrichment" pressed (retention.returnedAt) — someone chose to keep that one.
--   • Hand-added leads (source <> 'integration'): a person said those were prospects.
--   • Real businesses that are merely a poor fit (prospectType 'target_business').
--   • Leads with no prospectType at all (scored before the gate existed, or never scored).
--   • Out-of-area leads: cards written before the fix carry no outsideArea, and guessing location
--     after the fact from a stored snippet is exactly the kind of judgement SQL should not make.
--   • NO revenue-ledger 'lead_rejected' events are written. Those are read as a USER rejecting a
--     lead (the Strategy Agent clusters on them); this is a system correction, not that.


-- ═══ STEP 1 — counts per workspace (read-only) ═══════════════════════════════
SELECT ar.organisation_id,
       o.name                                   AS workspace,
       ar.data ->> 'prospectType'               AS prospect_type,
       count(*)                                 AS leads_to_move
FROM assistant_records ar
JOIN organisations o ON o.id = ar.organisation_id
WHERE ar.record_type = 'lead'
  AND ar.source = 'integration'
  AND ar.data ->> 'prospectType' IN ('supplier_to_target', 'aggregator', 'media', 'content_page', 'platform')
  AND COALESCE(ar.approval_status, '') NOT IN ('approved', 'scheduled', 'rejected')
  AND ar.data #>> '{retention,deletedAt}' IS NULL
  AND ar.data #>> '{retention,returnedAt}' IS NULL
  AND NOT (ar.data ? 'outreachSentAt')
  AND NOT (ar.data ? 'outreachStage')
  AND NOT (ar.data ? 'dealOutcome')
  AND NOT EXISTS (SELECT 1 FROM lead_threads lt WHERE lt.assistant_record_id = ar.id)
GROUP BY ar.organisation_id, o.name, ar.data ->> 'prospectType'
ORDER BY ar.organisation_id, leads_to_move DESC;


-- ═══ STEP 2 — the rows themselves, to eyeball before changing anything (read-only) ═══
SELECT ar.id,
       ar.organisation_id,
       ar.title,
       ar.status                                AS rating,
       ar.approval_status,
       ar.data ->> 'prospectType'               AS prospect_type,
       (SELECT string_agg(DISTINCT dl.domain, ', ')
          FROM discovered_leads dl
         WHERE dl.assistant_record_id = ar.id
           AND dl.organisation_id = ar.organisation_id) AS domains,
       ar.data -> 'reasons' ->> 0               AS first_reason
FROM assistant_records ar
WHERE ar.record_type = 'lead'
  AND ar.source = 'integration'
  AND ar.data ->> 'prospectType' IN ('supplier_to_target', 'aggregator', 'media', 'content_page', 'platform')
  AND COALESCE(ar.approval_status, '') NOT IN ('approved', 'scheduled', 'rejected')
  AND ar.data #>> '{retention,deletedAt}' IS NULL
  AND ar.data #>> '{retention,returnedAt}' IS NULL
  AND NOT (ar.data ? 'outreachSentAt')
  AND NOT (ar.data ? 'outreachStage')
  AND NOT (ar.data ? 'dealOutcome')
  AND NOT EXISTS (SELECT 1 FROM lead_threads lt WHERE lt.assistant_record_id = ar.id)
ORDER BY ar.organisation_id, ar.id;


-- ═══ STEP 3 — the cleanup (CHANGES DATA) ═════════════════════════════════════
-- One statement, so it all applies or none of it does. The WHERE clause is the same as steps 1–2;
-- the row counts it returns should match step 1's total.
WITH targets AS (
    SELECT ar.id, ar.organisation_id
    FROM assistant_records ar
    WHERE ar.record_type = 'lead'
      AND ar.source = 'integration'
      AND ar.data ->> 'prospectType' IN ('supplier_to_target', 'aggregator', 'media', 'content_page', 'platform')
      AND COALESCE(ar.approval_status, '') NOT IN ('approved', 'scheduled', 'rejected')
      AND ar.data #>> '{retention,deletedAt}' IS NULL
      AND ar.data #>> '{retention,returnedAt}' IS NULL
      AND NOT (ar.data ? 'outreachSentAt')
      AND NOT (ar.data ? 'outreachStage')
      AND NOT (ar.data ? 'dealOutcome')
      AND NOT EXISTS (SELECT 1 FROM lead_threads lt WHERE lt.assistant_record_id = ar.id)
),
discarded AS (
    UPDATE discovered_leads dl
       SET status = 'discarded', updated_at = now()
      FROM targets t
     WHERE dl.assistant_record_id = t.id
       AND dl.organisation_id = t.organisation_id
    RETURNING dl.id
),
moved AS (
    -- jsonb_set on the retention key ONLY, never a rewrite of data: the same rule the Delete button
    -- and the retention sweep follow, so enrichment state and the scoring card stay intact.
    UPDATE assistant_records ar
       SET approval_status = 'rejected',
           scheduled_for   = NULL,
           updated_at      = now(),
           data = jsonb_set(
               COALESCE(ar.data, '{}'::jsonb),
               '{retention}',
               COALESCE(ar.data -> 'retention', '{}'::jsonb)
                   || jsonb_build_object(
                          'deletedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                          'reason', 'not_a_business'),
               true)
      FROM targets t
     WHERE ar.id = t.id
       AND ar.organisation_id = t.organisation_id
    RETURNING ar.id
)
SELECT (SELECT count(*) FROM moved)     AS leads_moved_to_deleted,
       (SELECT count(*) FROM discarded) AS discovery_rows_discarded;


-- ═══ STEP 4 — check (read-only): should return 0 ═════════════════════════════
SELECT count(*) AS still_in_leads_tab
FROM assistant_records ar
WHERE ar.record_type = 'lead'
  AND ar.source = 'integration'
  AND ar.data ->> 'prospectType' IN ('supplier_to_target', 'aggregator', 'media', 'content_page', 'platform')
  AND COALESCE(ar.approval_status, '') NOT IN ('approved', 'scheduled', 'rejected')
  AND ar.data #>> '{retention,deletedAt}' IS NULL
  AND ar.data #>> '{retention,returnedAt}' IS NULL
  AND NOT (ar.data ? 'outreachSentAt')
  AND NOT (ar.data ? 'outreachStage')
  AND NOT (ar.data ? 'dealOutcome')
  AND NOT EXISTS (SELECT 1 FROM lead_threads lt WHERE lt.assistant_record_id = ar.id);
