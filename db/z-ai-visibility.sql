-- db/z-ai-visibility.sql — Admin → Platform → AI Visibility: does Be More Swan come up when a
-- prospect asks an AI assistant for help? The same questions, asked of each assistant, once a month.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately), BEFORE or AFTER the code deploys — the page says "not set up yet" until this
-- runs. Idempotent: CREATE … IF NOT EXISTS, and the starting questions insert only when missing.
-- Nothing is dropped or altered. No DO blocks and no semicolons inside quoted text, so the Neon
-- editor's statement splitter cannot cut a statement in half.
--
-- Three tables:
--   ai_visibility_questions — the question list. Retiring one (is_active = false) keeps its history.
--   ai_visibility_runs      — one per monthly check ("Baseline Oct 2026").
--   ai_visibility_answers   — one per question × assistant × run. source = 'manual' (an admin asked
--                             it in the app and filled the form) or 'api' (fetched automatically for
--                             Claude / ChatGPT — same models and web search as the apps, but not the
--                             consumer app itself, so the page labels these "API answer").

BEGIN;

CREATE TABLE IF NOT EXISTS ai_visibility_questions (
    id          SERIAL PRIMARY KEY,
    category    TEXT NOT NULL CHECK (category IN ('category', 'industry', 'comparison', 'brand')),
    text        TEXT NOT NULL UNIQUE CHECK (length(text) BETWEEN 5 AND 500),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_visibility_runs (
    id          SERIAL PRIMARY KEY,
    label       TEXT NOT NULL UNIQUE CHECK (length(label) BETWEEN 1 AND 80),
    notes       TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_visibility_answers (
    id            SERIAL PRIMARY KEY,
    run_id        INTEGER NOT NULL REFERENCES ai_visibility_runs(id) ON DELETE CASCADE,
    question_id   INTEGER NOT NULL REFERENCES ai_visibility_questions(id) ON DELETE CASCADE,
    assistant     TEXT NOT NULL CHECK (assistant IN ('chatgpt', 'copilot', 'gemini', 'claude', 'google_ai_overview')),
    source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'api')),
    mentioned     BOOLEAN,
    position      INTEGER CHECK (position IS NULL OR position BETWEEN 1 AND 50),
    link          TEXT CHECK (link IS NULL OR link IN ('our_site', 'other_site', 'no_link')),
    accurate      TEXT CHECK (accurate IS NULL OR accurate IN ('yes', 'partly', 'no')),
    wrong_facts   TEXT,
    competitors   TEXT[] NOT NULL DEFAULT '{}',
    notes         TEXT,
    answer_text   TEXT,
    cited_urls    TEXT[] NOT NULL DEFAULT '{}',
    model         TEXT,
    error         TEXT,
    answered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    answered_at   TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (run_id, question_id, assistant)
);
CREATE INDEX IF NOT EXISTS ai_visibility_answers_run_idx ON ai_visibility_answers (run_id, assistant);

-- The starting 25. Edit them in the admin page afterwards — re-running this file never overwrites.
INSERT INTO ai_visibility_questions (category, text, sort_order) VALUES
    ('category',   'What''s the best AI marketing assistant for a small business in the UK?', 10),
    ('category',   'Is there an AI tool that will write and schedule my social media posts for me?', 20),
    ('category',   'What''s the cheapest way to get my small business''s social media done without hiring someone?', 30),
    ('category',   'I run a small business and don''t have time for marketing. What tools can do it for me?', 40),
    ('category',   'What''s the best AI tool to write blog posts for my business website?', 50),
    ('category',   'What AI can write and send my business''s email newsletter?', 60),
    ('category',   'How can I find new customers for my small business using AI?', 70),
    ('category',   'Is there an AI that can build a website for my small business?', 80),
    ('category',   'Can AI check my website and tell me why it isn''t getting enquiries?', 90),
    ('category',   'What are the alternatives to hiring a marketing assistant or agency for a small business?', 100),
    ('industry',   'What''s the best AI tool for marketing a hair salon?', 110),
    ('industry',   'How can a café use AI to do its social media?', 120),
    ('industry',   'What AI marketing tools are good for a plumber or electrician?', 130),
    ('industry',   'What''s the best AI tool for marketing a holiday let?', 140),
    ('industry',   'What AI marketing tools suit a small independent shop or online store?', 150),
    ('industry',   'What AI can help a freelance consultant or coach find clients?', 160),
    ('comparison', 'What are the best alternatives to Buffer or Hootsuite that write the posts too?', 170),
    ('comparison', 'Is it worth paying for an AI marketing tool, or should I just use ChatGPT?', 180),
    ('comparison', 'AI marketing assistant or a freelance social media manager: which is better for a small business?', 190),
    ('comparison', 'Which AI social media tools let me approve posts before they go out?', 200),
    ('comparison', 'Which all-in-one AI marketing tools cover social media, email and blog for under £100 a month?', 210),
    ('brand',      'What is Be More Swan?', 220),
    ('brand',      'Is Be More Swan any good?', 230),
    ('brand',      'How much does Be More Swan cost?', 240),
    ('brand',      'Be More Swan or Buffer: which should I use?', 250)
ON CONFLICT (text) DO NOTHING;

COMMIT;

-- Check: expect tables_ok = 3 and questions = 25 (more if you have added your own since).
SELECT
    (SELECT count(*) FROM information_schema.tables
      WHERE table_name IN ('ai_visibility_questions', 'ai_visibility_runs', 'ai_visibility_answers')) AS tables_ok,
    (SELECT count(*) FROM ai_visibility_questions) AS questions,
    CASE WHEN (SELECT count(*) FROM ai_visibility_questions) >= 25 THEN 'OK' ELSE 'CHECK' END AS verdict;
