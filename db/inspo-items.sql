-- Inspo tab for content assistants (social_media_manager, blog_writer) — the
-- inspiration material a user parks so their assistant keeps applying the styles,
-- tones and ideas they like without repeated prompting.
--
-- inspo_items: one row per thing the user added in the Inspo tab
-- (assistant-detail.html → src/components/assistant-inspo.js, API:
-- netlify/functions/inspo-items.ts). `user_note` is the load-bearing field — the
-- user's own words about WHAT they like ("use this sarcastic tone"), which is a far
-- stronger signal than the material itself. inspo_chunks: the retrieval units,
-- mirroring kb_chunks — each item's body is chunked and (when VOYAGE_API_KEY is
-- configured) embedded with voyage-3.5-lite (1024 dims); without a provider
-- `embedding` stays NULL and retrieval falls back to the `content_tsv` index.
--
-- CONTEXT BUDGET (the whole point of this design): prompt cost must NOT scale with
-- library size. Raw inspo is NEVER injected wholesale. It reaches the model via two
-- bounded channels only:
--   A. inspo_style_profiles.profile_text — an LLM-distilled, token-capped directive
--      recompiled when the library changes, injected on every generation.
--   B. top-K retrieval over inspo_chunks — a fixed number of relevant exemplars.
-- Both are O(1) in the number of items, so 500 items cost the same as 5.
-- See docs/inspo-tab-plan.md.
--
-- GDPR (US-GDPR-2.2.2): the ingestion path inserts one vector_embeddings map row per
-- embedded chunk (source_type 'inspo_item', vector_store_id = inspo_chunks.id) so
-- erasure jobs can locate and delete the vectors.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push —
-- see docs/db-migrations.md). Requires the pgvector extension (available on Neon).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS inspo_items (
  id                 SERIAL PRIMARY KEY,
  organisation_id    INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id    INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  -- 'text'/'voice' land ready immediately (the body IS the input). 'url'/'file' need
  -- the extraction worker (phase 3) before they have a body worth embedding.
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  source_url         TEXT,                                  -- kind='url'
  workspace_asset_id INTEGER REFERENCES workspace_assets(id) ON DELETE SET NULL,  -- kind='file'
  -- The user's description of what they like / how to apply it. Optional on uploads
  -- (AC3), the entire payload on quick text notes (AC4).
  user_note          TEXT,
  -- Extracted / transcribed / typed text. NULL until the extraction worker fills it
  -- for url+file kinds.
  body               TEXT,
  -- AC6: deactivating must stop the item influencing drafts as immediately as
  -- deleting does. Retrieval filters on this; the style profile is invalidated on
  -- any change to it (see inspo_style_profiles.item_fingerprint).
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  -- 'ready'        → body present, usable
  -- 'pending'      → awaiting extraction (url/file)
  -- 'unsupported'  → we deliberately don't extract this (e.g. video: the user_note is
  --                  the only signal — nothing in the stack watches an mp4)
  -- 'failed'       → extraction errored
  ingest_status      TEXT NOT NULL DEFAULT 'pending',
  -- Mirrors kb_articles.embedding_status exactly.
  embedding_status   TEXT NOT NULL DEFAULT 'pending',
  chunk_count        INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT now(),
  updated_at         TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT inspo_items_kind_check
    CHECK (kind IN ('url', 'file', 'text', 'voice')),
  CONSTRAINT inspo_items_ingest_status_check
    CHECK (ingest_status IN ('pending', 'ready', 'unsupported', 'failed')),
  CONSTRAINT inspo_items_embedding_status_check
    CHECK (embedding_status IN ('pending', 'embedded', 'keyword_only', 'failed'))
);

CREATE INDEX IF NOT EXISTS inspo_items_org_idx       ON inspo_items (organisation_id);
CREATE INDEX IF NOT EXISTS inspo_items_assistant_idx ON inspo_items (ai_assistant_id);
-- The hot path: "active items for this assistant" (profile compile + AC6 filtering).
CREATE INDEX IF NOT EXISTS inspo_items_active_idx
  ON inspo_items (ai_assistant_id, organisation_id, is_active);

CREATE TABLE IF NOT EXISTS inspo_chunks (
  id                SERIAL PRIMARY KEY,
  inspo_item_id     INTEGER NOT NULL REFERENCES inspo_items(id) ON DELETE CASCADE,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL,
  content           TEXT NOT NULL,
  embedding         vector(1024),                        -- NULL when no embedding provider
  content_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inspo_chunks_item_idx      ON inspo_chunks (inspo_item_id);
CREATE INDEX IF NOT EXISTS inspo_chunks_assistant_idx ON inspo_chunks (ai_assistant_id, organisation_id);
CREATE INDEX IF NOT EXISTS inspo_chunks_tsv_idx       ON inspo_chunks USING GIN (content_tsv);
-- Cosine ANN index for channel-B retrieval (`embedding <=> $query ORDER BY … LIMIT k`).
CREATE INDEX IF NOT EXISTS inspo_chunks_embedding_idx ON inspo_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Channel A cache: the distilled style directive injected on EVERY generation.
-- One row per assistant. Bounded by construction (profile_text is token-capped at
-- compile time), which is what keeps prompt cost flat as the library grows.
CREATE TABLE IF NOT EXISTS inspo_style_profiles (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  profile_text      TEXT NOT NULL,
  -- AC6 correctness: exactly which items fed this profile. A distilled profile is a
  -- CACHE — a deleted item's influence survives inside profile_text until recompile,
  -- so generation must check the removed item is not in here and fall back to
  -- retrieval-only rather than use a profile known to be contaminated. "It washes out
  -- in a few minutes" is not acceptable when the user deleted something off-brand.
  source_item_ids   INTEGER[] NOT NULL DEFAULT '{}',
  -- hash(active item ids + their updated_at) — mirrors the blueprint hash pattern.
  -- Cheap staleness check on the generation hot path: mismatch ⇒ recompile.
  item_fingerprint  TEXT NOT NULL,
  token_estimate    INTEGER NOT NULL DEFAULT 0,
  compiled_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT inspo_style_profiles_assistant_unique UNIQUE (ai_assistant_id)
);

CREATE INDEX IF NOT EXISTS inspo_style_profiles_org_idx ON inspo_style_profiles (organisation_id);
