-- db/z-ai-visibility-review-questions.sql — Admin → Platform → AI Visibility: questions that show
-- whether the reviews we now collect (db/z-platform-reviews.sql; Trustpilot and G2) reach the AI
-- assistants. Asked monthly with the rest, so the trend shows from the next run.
--
-- APPLY MANUALLY in the Neon SQL Editor, staging and prod separately. Idempotent: ON CONFLICT (text)
-- DO NOTHING — re-running, or an admin having typed the same question, changes nothing.
-- "Is Be More Swan any good?" is already in the starting set (z-ai-visibility.sql), so it is not here.

INSERT INTO ai_visibility_questions (category, text, sort_order) VALUES
    ('brand',    'Be More Swan reviews', 260),
    ('brand',    'What do customers say about Be More Swan?', 270),
    ('brand',    'What is Be More Swan rated on Trustpilot or G2?', 280),
    ('category', 'Which AI marketing assistants for small businesses have the best reviews?', 290)
ON CONFLICT (text) DO NOTHING;

-- Check: expect 4 rows.
-- SELECT category, text FROM ai_visibility_questions WHERE sort_order BETWEEN 260 AND 290 ORDER BY sort_order;
