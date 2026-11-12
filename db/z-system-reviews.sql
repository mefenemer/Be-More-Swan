-- db/z-system-reviews.sql — System Map Phase 3 (docs/system-map-plan.md): "Better options".
-- A monthly check (system-review-background.ts) researches each paid system on the web and stores a
-- dated opinion with sources. Decisions the owner already took are stored too, so the check never
-- re-suggests what was turned down.
-- Code: src/utils/system-review.ts (prompt, parsing, which systems), src/utils/system-map-data.ts (read),
-- netlify/functions/admin-system-map.ts (check now, decisions). Drizzle mirror: db/schema.ts
-- (systemReviews, systemDecisions).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys there (the map reads
-- both tables; a missing table reads as empty, but "Check now" fails). Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-system-reviews                              (staging)
--   npm run db:migrate:apply -- --only z-system-reviews --url-var DATABASE_URL_PROD  (prod)

BEGIN;

CREATE TABLE IF NOT EXISTS system_reviews (
    id              SERIAL PRIMARY KEY,
    system_key      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    verdict         TEXT CHECK (verdict IN ('keep', 'consider', 'switch')),
    summary         TEXT NOT NULL DEFAULT '',
    alternatives    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ name, url, betterFor[], detail, priceNote, switchingEffort }]
    sources         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- URLs the search tool returned AND the answer cited
    model           TEXT,
    search_count    INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    trigger         TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'monthly', 'chat')),
    requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    finished_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS system_reviews_system_idx ON system_reviews (system_key, created_at DESC);

CREATE TABLE IF NOT EXISTS system_decisions (
    id              SERIAL PRIMARY KEY,
    system_key      TEXT NOT NULL,
    decision        TEXT NOT NULL CHECK (length(decision) BETWEEN 3 AND 500),
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    retired_at      TIMESTAMP                          -- no longer holds; the check may suggest it again
);
CREATE INDEX IF NOT EXISTS system_decisions_system_idx ON system_decisions (system_key);

-- Decisions already on record (owner, Oct–Nov 2026). Inserted once: re-running skips any already there.
INSERT INTO system_decisions (system_key, decision, created_at)
SELECT v.system_key, v.decision, v.created_at::timestamp
FROM (VALUES
    ('anthropic', 'Social image prompts are always written by Opus 5.5 — the owner refused Sonnet for this (2026-11-04).', '2026-11-04'),
    ('anthropic', 'Each assistant role''s Claude model (Haiku / Sonnet / Opus) is chosen per role in Admin → Assistants, after a head-to-head (2026-10-24).', '2026-10-24'),
    ('fal', 'AI images use FLUX.2 Pro, with FLUX 1.1 Pro as the hedge, chosen in a bake-off (2026-11-02).', '2026-11-02'),
    ('elevenlabs', 'British voiceovers use ElevenLabs (the Pepper voice), chosen in the owner''s voice trials; OpenAI voices are the fallback (2026-11-02).', '2026-11-02'),
    ('stability', 'AI music is made with Stable Audio 3.0 (2026-11).', '2026-11-02')
) AS v(system_key, decision, created_at)
WHERE NOT EXISTS (SELECT 1 FROM system_decisions d WHERE d.system_key = v.system_key AND d.decision = v.decision);

COMMIT;
