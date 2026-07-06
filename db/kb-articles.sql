-- Knowledge Base (Tier 1 Support Agent KB phase) — user-managed support articles
-- grounding the tier1_support_agent's "Resolved" answers in the business's own KB.
--
-- kb_articles: one row per article the user writes/uploads in the Knowledge Base tab
-- (assistant-detail.html → src/components/assistant-knowledge-base.js, API:
-- netlify/functions/kb-articles.ts). kb_chunks: the retrieval units — each article is
-- chunked and (when VOYAGE_API_KEY is configured) embedded with voyage-3.5-lite
-- (1024 dims) into `embedding`; without a provider, `embedding` stays NULL and
-- retrieval falls back to the `content_tsv` full-text index. chat-orchestrator.ts
-- injects the top-matching chunks into the tier1 system prompt per turn.
--
-- GDPR (US-GDPR-2.2.2): the ingestion path in kb-articles.ts inserts one
-- vector_embeddings map row per embedded chunk (source_type 'kb_article',
-- vector_store_id = kb_chunks.id) so erasure jobs can locate and delete vectors.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see
-- the no-db:push rule). Requires the pgvector extension (available on Neon).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_articles (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'manual',      -- 'manual' | 'file_upload'
  -- 'pending' → not yet chunked; 'embedded' → vectors written; 'keyword_only' →
  -- no embedding provider configured (full-text search only); 'failed' → provider error.
  embedding_status  TEXT NOT NULL DEFAULT 'pending',
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_articles_org_idx       ON kb_articles (organisation_id);
CREATE INDEX IF NOT EXISTS kb_articles_assistant_idx ON kb_articles (ai_assistant_id);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id                SERIAL PRIMARY KEY,
  kb_article_id     INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL,
  content           TEXT NOT NULL,
  embedding         vector(1024),                        -- NULL when no embedding provider
  -- Full-text fallback: always populated, so keyword retrieval works with or
  -- without embeddings ('english' matches how support articles are written).
  content_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_chunks_article_idx   ON kb_chunks (kb_article_id);
CREATE INDEX IF NOT EXISTS kb_chunks_assistant_idx ON kb_chunks (ai_assistant_id, organisation_id);
CREATE INDEX IF NOT EXISTS kb_chunks_tsv_idx       ON kb_chunks USING GIN (content_tsv);
-- Cosine ANN index for the retrieval query in chat-orchestrator.ts
-- (`embedding <=> $query ORDER BY … LIMIT n`). HNSW: fine at any table size.
CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks
  USING hnsw (embedding vector_cosine_ops);
