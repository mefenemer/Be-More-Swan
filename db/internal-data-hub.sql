-- Internal Data Hub (Golden Rule 2) — tenant work products produced by the Tier 1
-- assistants: processed leads, enrichment diffs, meeting notes, ledger invoices,
-- triaged tickets. One table for all five roles: `data` holds the exact uiElement
-- wire shape the chat orchestrator emitted (or a CSV-imported row mapped into that
-- shape), so the Data Hub tab on assistant-detail.html
-- (src/components/assistant-data-hub.js, API: netlify/functions/assistant-records.ts)
-- re-renders records with the same DisruptiveUIRegistry renderers the chat
-- transcript uses. NOT Be More Swan's own sales pipeline — that is the `leads` table.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push —
-- see the no-db:push rule).

CREATE TABLE IF NOT EXISTS assistant_records (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  record_type       TEXT NOT NULL,                         -- 'lead' | 'enrichment' | 'meeting' | 'invoice' | 'ticket'
  title             TEXT NOT NULL,
  status            TEXT,
  source            TEXT NOT NULL DEFAULT 'chat',          -- 'chat' | 'csv_import' | 'integration'
  data              JSONB NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT assistant_records_type_check
    CHECK (record_type IN ('lead', 'enrichment', 'meeting', 'invoice', 'ticket')),
  CONSTRAINT assistant_records_source_check
    CHECK (source IN ('chat', 'csv_import', 'integration'))
);

CREATE INDEX IF NOT EXISTS assistant_records_org_assistant_type_idx
  ON assistant_records (organisation_id, ai_assistant_id, record_type);
