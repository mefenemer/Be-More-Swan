-- UI translation cache (#1 runtime auto-translation).
--
-- Shared cache for machine-translated UI microcopy: each unique (lang, source_hash) is
-- translated once via the AI gateway (netlify/functions/translate.ts) and reused for every
-- user, bounding cost + latency. source_hash = sha256(source_text).
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle. This plain CREATE
-- cannot touch RLS. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS ui_translations (
    id              serial PRIMARY KEY,
    lang            text NOT NULL,
    source_hash     text NOT NULL,
    source_text     text NOT NULL,
    translated_text text NOT NULL,
    created_at      timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ui_translations_lang_hash_unique
    ON ui_translations (lang, source_hash);
