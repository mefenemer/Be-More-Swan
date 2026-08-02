-- db/lead-threads.sql
-- Phase 2a of docs/lead-generator-revenue-engine-plan.md — lead conversations become stateful.
--
-- Outreach today is fire-and-forget: lead-generation.ts `send_outreach` sends one email, sets a
-- +3-day calendar reminder, and stops. There is no record of the exchange and NO REPLY DETECTION,
-- so the system cannot distinguish a prospect who answered from one who ignored us. Every later
-- phase (sequences, the closing agent, win/loss attribution) needs that distinction.
--
--   lead_threads     — one conversation, keyed by a per-thread inbound alias
--                      reply+<token>@parse.bemoreswan.com
--   lead_messages    — one row per message, in or out. Keeps generated_body ALONGSIDE body so an
--                      edited draft is distinguishable from an unedited one (plan §2.6).
--   template_feedback— human edits as evidence for the Strategy Agent.
--
-- ⚠️ These are NOT `leads` / `lead_replies`. Those are Be More Swan's OWN trial/upgrade pipeline
-- (Admin → Contacts). These hold the TENANT's conversations with THEIR prospects. Do not merge them.
--
-- Apply manually via scripts/db-migrate.mjs. For PROD, pass the connection explicitly — the runner
-- defaults to the local .env database and that database IS staging:
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only lead-threads --url-var PROD_DATABASE_URL --yes
--
-- ── Deploy ordering ─────────────────────────────────────────────────────────
-- Apply-before-deploy is PREFERRED but not load-bearing here, because every reader of these tables
-- is deliberately wrapped in its own try/catch (this is the lesson from 2026-08-02, when
-- discovery-campaigns.ts had no guard and a pending migration turned into a live 500):
--   • lead-generation.ts send_outreach — thread creation is best-effort; a missing table means the
--     email STILL SENDS and simply is not recorded. The send must never fail for bookkeeping.
--   • inbound-email.ts — the reply-alias branch is guarded and falls through to the existing
--     support-mail path, so ordinary inbound email keeps working untouched.
-- Missing tables therefore degrade to "no conversation history", never to a broken feature.
--
-- Idempotent: guarded throughout, safe to run repeatedly. No backfill — there is no historical
-- conversation data to reconstruct (nothing has ever recorded one).

CREATE TABLE IF NOT EXISTS lead_threads (
  id                  serial PRIMARY KEY,
  organisation_id     integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id     integer NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  discovered_lead_id  integer REFERENCES discovered_leads(id) ON DELETE CASCADE,
  assistant_record_id integer REFERENCES assistant_records(id) ON DELETE SET NULL,
  channel             text NOT NULL DEFAULT 'email',
  -- The routing key. UNIQUE because it is what an inbound message is resolved by; a collision
  -- would deliver one prospect's reply into another's conversation.
  reply_token         text NOT NULL UNIQUE,
  contact_email       text,
  state               text NOT NULL DEFAULT 'open',
  last_outbound_at    timestamp,
  last_inbound_at     timestamp,
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_messages (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  lead_thread_id   integer NOT NULL REFERENCES lead_threads(id) ON DELETE CASCADE,
  direction        text NOT NULL,
  from_email       text,
  subject          text,
  body             text NOT NULL,
  -- Outbound only: the agent's draft, kept even when a human edited it before sending.
  generated_body   text,
  edited_by        integer REFERENCES users(id) ON DELETE SET NULL,
  template_version text,
  -- Inbound only: what the reply meant. NULL until the classifier runs.
  classification   text,
  sentiment        text,
  objections       jsonb,
  occurred_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_feedback (
  id                  serial PRIMARY KEY,
  organisation_id     integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  lead_message_id     integer REFERENCES lead_messages(id) ON DELETE CASCADE,
  template_version    text,
  edit_reason         text,
  diff_summary        text,
  applied_to_template boolean NOT NULL DEFAULT false,
  created_at          timestamp NOT NULL DEFAULT now()
);

-- ── Constraints ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_threads_state_check') THEN
    ALTER TABLE lead_threads ADD CONSTRAINT lead_threads_state_check
      CHECK (state IN ('open','replied','stalled','closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_threads_channel_check') THEN
    ALTER TABLE lead_threads ADD CONSTRAINT lead_threads_channel_check
      CHECK (channel IN ('email','dm'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_messages_direction_check') THEN
    ALTER TABLE lead_messages ADD CONSTRAINT lead_messages_direction_check
      CHECK (direction IN ('outbound','inbound'));
  END IF;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS lead_threads_org_state_idx
  ON lead_threads (organisation_id, state, last_outbound_at);
CREATE INDEX IF NOT EXISTS lead_threads_record_idx
  ON lead_threads (assistant_record_id);
CREATE INDEX IF NOT EXISTS lead_messages_thread_idx
  ON lead_messages (lead_thread_id, occurred_at);
CREATE INDEX IF NOT EXISTS template_feedback_org_reason_idx
  ON template_feedback (organisation_id, edit_reason, created_at);

-- ── Verify (run manually after applying) ─────────────────────────────────────
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('lead_threads','lead_messages','template_feedback');
--   -- expect 3 rows
--
-- After the first real send, the thread and its opening message should both exist:
--   SELECT t.id, t.state, t.reply_token, count(m.id) AS messages
--     FROM lead_threads t LEFT JOIN lead_messages m ON m.lead_thread_id = t.id
--    GROUP BY t.id ORDER BY t.created_at DESC LIMIT 5;
