-- One-time data preservation: copy the old org-global "Assistant Rules"
-- (workspace_assets, asset_type='text') into per-assistant content_rules.
--
-- WHY: the side-menu "Assistant Rules" page is being removed. Those rules lived in
-- workspace_assets and were applied to assistants only via a per-assistant on/off toggle map
-- stored in ai_assistants.configuration->'appliedDefaults'->'assistantRules' (key = workspace_assets.id).
-- They never actually reached the brief. Per-assistant rules now live in content_rules, which IS
-- injected into the brief. This script materialises each assistant's effective rule set so users
-- don't lose anything when the global page goes away.
--
-- Rules:
--   * only globally-active text rules with non-empty text are copied
--   * an assistant gets a rule UNLESS its toggle for that rule is explicitly 'false'
--     (default ON, matching the old UI behaviour)
--   * category carries over verbatim (same keys: tone_of_voice | response_formatting | core_knowledge | target_audience)
--   * note = 'migrated_from_global' marks the row for idempotency (safe to re-run; won't duplicate)
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) AFTER db/content-rules-category.sql.
-- Idempotent — safe to re-run.

INSERT INTO content_rules
    (assistant_id, workspace_id, rule_text, category, platform, is_active, origin, note, created_at)
SELECT
    a.id,
    a.organisation_id,
    wa.extracted_text,
    wa.category,
    NULL,
    true,
    'manual',
    'migrated_from_global',
    now()
FROM workspace_assets wa
JOIN ai_assistants a
    ON a.organisation_id = wa.organisation_id
WHERE wa.asset_type = 'text'
  AND wa.is_active = true
  AND NULLIF(TRIM(wa.extracted_text), '') IS NOT NULL
  -- honour an explicit per-assistant OFF toggle; default to ON
  AND COALESCE(
        a.configuration -> 'appliedDefaults' -> 'assistantRules' ->> (wa.id::text),
        'true'
      ) <> 'false'
  -- idempotency: don't re-copy a rule already migrated for this assistant
  AND NOT EXISTS (
        SELECT 1 FROM content_rules cr
        WHERE cr.assistant_id = a.id
          AND cr.note = 'migrated_from_global'
          AND cr.rule_text = wa.extracted_text
      );
