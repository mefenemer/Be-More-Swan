-- db/ops/backfill-athena-guardrails.sql
-- ONE-OFF OPERATIONAL SCRIPT — run in the Neon console, against PRODUCTION.
-- Not a migration. Nothing here runs automatically; nothing imports it.
--
-- Purpose: assistants onboarded BEFORE the onboarding.ts guardrails fix never had their
-- '- NON-NEGOTIABLE:' strict rules written to content_rules — they only ever went into the
-- (unused-at-generation) system prompt. So the setup wizard's "Guardrails & rules set" item
-- (get-assistant-readiness.ts → hasRule, a content_rules existence check) reads red, and the rules
-- steer nothing. This lifts the rules already stored on the assistant (configuration.inputs.strictRules)
-- into content_rules, mirroring exactly what the code fix now does for new onboardings.
--
-- What it does NOT touch: the four categorised buckets in the profile's Assistant Rules panel
-- (tone_of_voice / response_formatting / core_knowledge / target_audience). Tone & audience already
-- reach the assistant via the blueprint's org-context + onboarding-answers sections; copying them
-- into content_rules would double-count them in the brief. Those buckets are an optional refinement
-- layer and are meant to start empty. Only the uncategorised NON-NEGOTIABLE guardrails are backfilled.
--
-- Difference from the code path: the app also runs each rule through sanitizeUserInput (a JS
-- prompt-injection scrub). That can't be replicated in SQL, and these are the user's own already-stored
-- words, so it's skipped here. The meaningful transforms — strip the '- NON-NEGOTIABLE: ' tag, trim,
-- cap at 300 chars — are reproduced.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 0 — READ ONLY. Confirm the assistant and see the raw strict rules stored on it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Org resolved through user_organisations (users.organisation_id is deprecated — see tenant.ts).
WITH me AS (
  SELECT uo.organisation_id AS org_id
  FROM users u
  JOIN user_organisations uo ON uo.user_id = u.id
  WHERE LOWER(u.email) = LOWER('cfenemer@hotmail.co.uk')
  ORDER BY uo.joined_at DESC
  LIMIT 1
)
SELECT
  a.id   AS assistant_id,
  a.organisation_id,
  a.user_id,
  a.name,
  jsonb_typeof(a.configuration->'inputs'->'strictRules') AS strict_rules_type,
  a.configuration->'inputs'->'strictRules'               AS strict_rules_raw
FROM ai_assistants a
JOIN me ON me.org_id = a.organisation_id
ORDER BY a.created_at;
-- Expect one row (assistant_id = 2, athena). Note the id and confirm strict_rules_type = 'array'.
-- Substitute that id for 2 below. If strict_rules_type is null/not 'array', there is nothing
-- to backfill — add a rule via the UI (Assistant → Guardrails) instead.


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 1 — READ ONLY. Preview exactly which rows STEP 2 would insert.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
SELECT
  LEFT(TRIM(regexp_replace(elem, '^-\s*NON-NEGOTIABLE:\s*', '', 'i')), 300) AS rule_text
FROM ai_assistants a
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(a.configuration->'inputs'->'strictRules') = 'array'
       THEN a.configuration->'inputs'->'strictRules'
       ELSE '[]'::jsonb END
) AS elem
WHERE a.id = 2
  AND elem ~* '^-\s*NON-NEGOTIABLE:\s*'
  AND TRIM(regexp_replace(elem, '^-\s*NON-NEGOTIABLE:\s*', '', 'i')) <> '';
-- These are the guardrails you typed at onboarding, tag stripped. KNOWLEDGE BASE entries in the same
-- array are intentionally NOT here — they are context, not rules.


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 2 — THE CHANGE. Insert the guardrails as content_rules. Idempotent + wrapped.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- The NOT EXISTS guard makes a re-run a no-op: it skips any rule text already present for the
-- assistant, so running this twice never duplicates.
BEGIN;

INSERT INTO content_rules (assistant_id, workspace_id, rule_text, created_by_user_id, is_active, origin, created_at)
SELECT
  a.id,
  a.organisation_id,
  LEFT(TRIM(regexp_replace(elem, '^-\s*NON-NEGOTIABLE:\s*', '', 'i')), 300),
  a.user_id,
  true,
  'manual',
  now()
FROM ai_assistants a
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(a.configuration->'inputs'->'strictRules') = 'array'
       THEN a.configuration->'inputs'->'strictRules'
       ELSE '[]'::jsonb END
) AS elem
WHERE a.id = 2
  AND elem ~* '^-\s*NON-NEGOTIABLE:\s*'
  AND TRIM(regexp_replace(elem, '^-\s*NON-NEGOTIABLE:\s*', '', 'i')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM content_rules cr
    WHERE cr.assistant_id = a.id
      AND cr.rule_text = LEFT(TRIM(regexp_replace(elem, '^-\s*NON-NEGOTIABLE:\s*', '', 'i')), 300)
  );
-- Expect: INSERT 0 <n>, where n = the number of rows STEP 1 previewed.

COMMIT;
-- ROLLBACK;  -- if the count looked wrong


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 3 — VERIFY. The rules now exist, and the wizard's guardrails check will read green.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
SELECT id, category, is_active, origin, rule_text
FROM content_rules
WHERE assistant_id = 2
ORDER BY created_at;

-- hasRule is: "≥1 active content_rules row for this assistant". This mirrors it.
SELECT EXISTS (
  SELECT 1 FROM content_rules
  WHERE assistant_id = 2 AND is_active = true
) AS wizard_guardrails_done;
-- Expect: wizard_guardrails_done = true. The rules show under "Other rules" in the profile's
-- Assistant Rules panel (uncategorised, which is correct for guardrails).
