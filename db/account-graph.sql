-- db/account-graph.sql
-- Phase 3 of docs/lead-generator-revenue-engine-plan.md (§5.3) — the account graph and memory,
-- the "Anti-CRM". A CRM makes a human type what happened; this makes the system remember it.
--
--   account_nodes   — the durable entities memory is about (account | contact | deal)
--   account_edges   — typed, directed relationships; traversed by recursive CTE, depth-capped at 4
--   account_memory  — long-term semantic memory, pgvector + full-text fallback
--
-- ── Memory tiering (why three stores and not one) ───────────────────────────
--   working      lead_threads + lead_messages   direct FK read — small, bounded, no embedding
--   semantic     account_memory + HNSW          cosine kNN over everything ever said
--   structural   account_nodes + account_edges  who relates to whom
--   strategy     revenue_events                 what we believed and what happened
-- Chosen by access pattern, not by fashion. No Redis: working memory is a bounded row set keyed by
-- thread id that Postgres serves in one indexed read.
--
-- ── ⚠️ GDPR — the pairing that must not be skipped ──────────────────────────
-- Every account_memory insert must be accompanied by a vector_embeddings row with
-- source_type = 'account_memory'. That map is the ONLY registration of these vectors.
--
-- Note for anyone auditing this: the plan says the erasure paths "already read that table". They
-- do not read it by source_type — src/utils/gdpr-asset-purge.ts is the only reader, it is scoped to
-- workspace assets, and until 2026-08-02 it deleted by source_id ALONE, which would have destroyed
-- these rows (and other tenants') on any unrelated erasure. Fixed in the same change as this file.
-- What actually protects this data on account deletion is the ON DELETE CASCADE from
-- organisations below — not the map. Both should hold; only one is load-bearing today.
--
-- ── Deploy ordering: APPLY BEFORE DEPLOYING ─────────────────────────────────
-- The ingestion worker and every read helper are wrapped and degrade to "no memory", but as with
-- db/outreach-sequences.sql the degradation is SILENT — an empty memory looks exactly like a
-- memory nothing has been written to yet. Apply first.
--
-- Idempotent: guarded throughout, safe to run repeatedly.
--
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only account-graph --url-var PROD_DATABASE_URL --yes

-- pgvector. Already present wherever db/kb-articles.sql has been applied; harmless to repeat.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS account_nodes (
  id              serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  node_type       text NOT NULL,
  label           text NOT NULL,
  -- Normalised (lowercased, no scheme, no www., no path) — the identity resolution key. It is the
  -- one attribute that survives a contact changing name, job title or email address.
  domain          text,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_edges (
  id              serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  from_node_id    integer NOT NULL REFERENCES account_nodes(id) ON DELETE CASCADE,
  to_node_id      integer NOT NULL REFERENCES account_nodes(id) ON DELETE CASCADE,
  edge_type       text NOT NULL,
  weight          integer NOT NULL DEFAULT 1,
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_memory (
  id              serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  account_node_id integer REFERENCES account_nodes(id) ON DELETE CASCADE,
  source_type     text NOT NULL,
  source_id       integer,
  content         text NOT NULL,
  -- NULL when no embedding provider is configured; retrieval falls back to full-text search over
  -- content_tsv, exactly as kb_chunks does. Same model and dimensions as kb_chunks ON PURPOSE —
  -- one embed path, one budget, one failure mode, and vectors that can be compared.
  embedding       vector(1024),
  content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  occurred_at     timestamp NOT NULL,
  created_at      timestamp NOT NULL DEFAULT now()
);

-- ── Constraints ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_nodes_type_check') THEN
    ALTER TABLE account_nodes ADD CONSTRAINT account_nodes_type_check
      CHECK (node_type IN ('account','contact','deal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_edges_type_check') THEN
    ALTER TABLE account_edges ADD CONSTRAINT account_edges_type_check
      CHECK (edge_type IN ('works_at','engaged_with','competitor_of','referred_by'));
  END IF;
  -- A self-edge is never meaningful and complicates cycle reasoning in the traversal. Reject it at
  -- the boundary rather than filtering it on every read.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_edges_no_self_check') THEN
    ALTER TABLE account_edges ADD CONSTRAINT account_edges_no_self_check
      CHECK (from_node_id <> to_node_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_memory_source_type_check') THEN
    ALTER TABLE account_memory ADD CONSTRAINT account_memory_source_type_check
      CHECK (source_type IN ('message','engagement','note','outcome'));
  END IF;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- PARTIAL unique: one ACCOUNT per domain per org. Contacts and deals are excluded deliberately —
-- many contacts share one company domain, and a full unique index would merge distinct people into
-- a single node.
CREATE UNIQUE INDEX IF NOT EXISTS account_nodes_org_domain_uidx
  ON account_nodes (organisation_id, domain)
  WHERE node_type = 'account' AND domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_nodes_org_type_idx
  ON account_nodes (organisation_id, node_type);

CREATE UNIQUE INDEX IF NOT EXISTS account_edges_uidx
  ON account_edges (from_node_id, to_node_id, edge_type);
CREATE INDEX IF NOT EXISTS account_edges_from_idx
  ON account_edges (from_node_id, edge_type);
CREATE INDEX IF NOT EXISTS account_edges_org_idx
  ON account_edges (organisation_id);

CREATE INDEX IF NOT EXISTS account_memory_node_idx
  ON account_memory (account_node_id, occurred_at);
CREATE INDEX IF NOT EXISTS account_memory_org_idx
  ON account_memory (organisation_id, occurred_at);

-- ⚠️ THE INGESTION IDEMPOTENCY KEY. One memory row per source row. Without it, re-running the
-- backfill re-embeds every message — paying the embedding provider a second time for duplicate
-- rows that then double-count in kNN retrieval. The worker relies on this via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS account_memory_source_uidx
  ON account_memory (organisation_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS account_memory_tsv_idx
  ON account_memory USING GIN (content_tsv);

-- Cosine, matching kb_chunks. voyage-3.5-lite returns normalised vectors, so cosine and inner
-- product rank identically — cosine is used for consistency with the existing index.
CREATE INDEX IF NOT EXISTS account_memory_embedding_idx
  ON account_memory USING hnsw (embedding vector_cosine_ops);

-- ── Verify (run manually after applying) ─────────────────────────────────────
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('account_nodes','account_edges','account_memory');
--   -- expect 3 rows
--
-- The GDPR pairing invariant — every embedded memory row must have a map row. Must return zero:
--   SELECT m.id FROM account_memory m
--    WHERE m.embedding IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM vector_embeddings v
--                       WHERE v.source_type = 'account_memory' AND v.source_id = m.id);
--
-- Tenant isolation on the graph — an edge must never span two organisations. Must return zero:
--   SELECT e.id FROM account_edges e
--     JOIN account_nodes a ON a.id = e.from_node_id
--     JOIN account_nodes b ON b.id = e.to_node_id
--    WHERE a.organisation_id <> b.organisation_id
--       OR a.organisation_id <> e.organisation_id;
