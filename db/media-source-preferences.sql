-- Media Source Selection (per-assistant).
--
-- ai_assistants gains an ORDERED jsonb array, media_sources, listing which media sources the
-- assistant may use and in what priority order. Values: 'manual' | 'stock' | 'ai'.
--   position = priority, membership = enabled.
--   null / empty  ⇒  default matrix ['manual','stock','ai']
--                    (Manual Library → AI Stock Search (Pexels) → AI Generation).
--
-- The resolver (src/utils/media-resolver.ts) walks this list, trying each enabled source in turn
-- and falling through to the next when a source returns nothing (AC2.3 / AC3.1).
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).

ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS media_sources JSONB;
