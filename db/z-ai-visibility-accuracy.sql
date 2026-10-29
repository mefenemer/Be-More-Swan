-- db/z-ai-visibility-accuracy.sql
-- Admin → AI Visibility: Claude's suggested "Accurate?" for each answer that names Be More Swan.
-- Stored apart from `accurate`, which only an admin sets; the summary counts only confirmed values.
-- Idempotent. Apply on staging AND production BEFORE the code deploys: the page reads every column.

ALTER TABLE ai_visibility_answers ADD COLUMN IF NOT EXISTS suggested_accurate TEXT;
ALTER TABLE ai_visibility_answers ADD COLUMN IF NOT EXISTS suggested_wrong_facts TEXT;
ALTER TABLE ai_visibility_answers ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMP;

ALTER TABLE ai_visibility_answers DROP CONSTRAINT IF EXISTS ai_visibility_answers_suggested_accurate_check;
ALTER TABLE ai_visibility_answers ADD CONSTRAINT ai_visibility_answers_suggested_accurate_check
    CHECK (suggested_accurate IS NULL OR suggested_accurate IN ('yes', 'partly', 'no'));

SELECT column_name FROM information_schema.columns
WHERE table_name = 'ai_visibility_answers' AND column_name LIKE 'suggested%' ORDER BY column_name;
