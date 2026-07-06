-- Internal Data Hub (Golden Rule 2) — assistant_records, the per-assistant work-product
-- library behind the Data Hub tab on assistant-detail.html (Leads / Ledger / Tickets /
-- Meeting Notes / …). API: netlify/functions/assistant-records.ts. `data` stores the exact
-- uiElement wire shape the chat orchestrator emitted (disruptive-ui-registry.js), so the hub
-- tab re-renders records with the same renderers the chat transcript used.
--
-- Missing on staging: this table exists in db/schema.ts but had no matching migration file,
-- so every Data Hub tab (e.g. Meeting Note Taker's "Meeting Notes" tab) reads/writes against
-- a relation that was never created — GET falls back to an empty list (see the "relation
-- does not exist" catch in assistant-records.ts) and inserts from chat are silently dropped,
-- so the tab always looks empty.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see
-- the no-db:push rule).

CREATE TABLE IF NOT EXISTS assistant_records (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  record_type       TEXT NOT NULL,                       -- 'lead' | 'enrichment' | 'meeting' | 'invoice' | 'ticket'
  title             TEXT NOT NULL,
  status            TEXT,                                -- freeform lifecycle label, not enum-constrained
  source            TEXT NOT NULL DEFAULT 'chat',         -- 'chat' | 'csv_import' | 'integration'
  data              JSONB NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT assistant_records_type_check CHECK (record_type IN ('lead', 'enrichment', 'meeting', 'invoice', 'ticket')),
  CONSTRAINT assistant_records_source_check CHECK (source IN ('chat', 'csv_import', 'integration'))
);

-- Hot path: the Data Hub tab listing one assistant's records of one type.
CREATE INDEX IF NOT EXISTS assistant_records_org_assistant_type_idx
  ON assistant_records (organisation_id, ai_assistant_id, record_type);
