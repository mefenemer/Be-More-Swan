-- Retire three Social Media set-up answers (2026-11-14) — src/constants/retired-setup-answers.ts
--   content_source_detail, trigger_schedule_frequency, trigger_timezone
-- Saved once at hire, never editable, and all replaced (What I post about / Inspo; the Posting Schedule).
--
-- 1. Copies every stored value into retired_setup_answers, word for word, so the wording is kept.
-- 2. Removes the keys from ai_assistants.onboarding_context.
-- Safe to run more than once: a value already backed up is not copied twice.
-- Run on STAGING and PROD separately, AFTER the release that stops the wizard saving these keys.

BEGIN;

CREATE TABLE IF NOT EXISTS retired_setup_answers (
    id               serial PRIMARY KEY,
    ai_assistant_id  integer NOT NULL,
    organisation_id  integer NOT NULL,
    answer_key       text NOT NULL,
    answer_value     jsonb NOT NULL,
    retired_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retired_setup_answers (ai_assistant_id, organisation_id, answer_key, answer_value)
SELECT a.id, a.organisation_id, k.key, a.onboarding_context -> k.key
FROM ai_assistants a
CROSS JOIN (VALUES ('content_source_detail'), ('trigger_schedule_frequency'), ('trigger_timezone')) AS k(key)
WHERE a.onboarding_context ? k.key
  AND NOT EXISTS (
      SELECT 1 FROM retired_setup_answers r
      WHERE r.ai_assistant_id = a.id AND r.answer_key = k.key
        AND r.answer_value = a.onboarding_context -> k.key
  );

UPDATE ai_assistants
SET onboarding_context = onboarding_context - 'content_source_detail' - 'trigger_schedule_frequency' - 'trigger_timezone'
WHERE onboarding_context ?| ARRAY['content_source_detail', 'trigger_schedule_frequency', 'trigger_timezone'];

COMMIT;

-- Check: the first should list the backed-up rows; the second should be 0.
-- SELECT answer_key, count(*) FROM retired_setup_answers GROUP BY 1;
-- SELECT count(*) FROM ai_assistants WHERE onboarding_context ?| ARRAY['content_source_detail','trigger_schedule_frequency','trigger_timezone'];
