-- db/outreach-sequences.sql
-- Phase 2b of docs/lead-generator-revenue-engine-plan.md (§5.2) — outreach becomes a cadence.
--
-- Phase 2a made a conversation OBSERVABLE. 2b makes it PERSISTENT: instead of one email plus a
-- calendar reminder asking a human to remember, the assistant follows up on its own until the
-- prospect replies or the cadence runs out.
--
--   outreach_sequences   — a named cadence, one per assistant, auto-provisioned on first enrolment
--   sequence_steps       — the ordered follow-ups; delay_days counts from the PREVIOUS send
--   sequence_enrolments  — one lead's progress; next_send_at is the worker's claim key
--
-- ── The stop condition is 2a ─────────────────────────────────────────────────
-- `lead_threads.state = 'replied'` is what halts a sequence, which is why 2b could not be built
-- before 2a. The worker re-reads that state inside the same transaction that claims the row, so
-- there is no window in which a reply exists and a follow-up still goes out. A follow-up landing
-- after someone has already answered is the worst failure this system has.
--
-- ── Deploy ordering: APPLY BEFORE DEPLOYING ─────────────────────────────────
-- Unlike db/lead-threads.sql, this one is closer to load-bearing. The readers:
--   • src/utils/outreach-sequences.ts — every function is wrapped and returns null on failure, so
--     an un-migrated environment degrades to "outreach still sends once, never follows up".
--   • netlify/functions/process-sequence-sends.ts — the whole worker body is wrapped; on a missing
--     table it logs and returns 0 rather than erroring the scheduled invocation.
-- So a pending migration degrades rather than breaks — but it degrades SILENTLY, and the symptom
-- (nobody ever gets a second email) looks identical to "no leads were due". Apply first.
--
-- Idempotent: guarded throughout, safe to run repeatedly. No backfill — enrolling leads that were
-- emailed before this existed would send follow-ups referencing a conversation the prospect had
-- weeks ago, and to people who may already have replied outside a tracked thread.
--
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only outreach-sequences --url-var PROD_DATABASE_URL --yes

CREATE TABLE IF NOT EXISTS outreach_sequences (
  id              serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id integer NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  name            text NOT NULL DEFAULT 'Default follow-up',
  is_enabled      boolean NOT NULL DEFAULT true,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id              serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sequence_id     integer NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE,
  step_number     integer NOT NULL,
  delay_days      integer NOT NULL DEFAULT 3,
  -- An instruction to the drafting model, not a static body. A fixed string sent three times is a
  -- recognisable mail-merge; drafting per-send is what lets a follow-up reference THIS thread.
  body_prompt     text NOT NULL,
  is_enabled      boolean NOT NULL DEFAULT true,
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_enrolments (
  id                  serial PRIMARY KEY,
  organisation_id     integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id     integer NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  sequence_id         integer NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE,
  -- The halt key. Every send re-reads this thread's state and refuses unless it is still 'open'.
  lead_thread_id      integer NOT NULL REFERENCES lead_threads(id) ON DELETE CASCADE,
  assistant_record_id integer REFERENCES assistant_records(id) ON DELETE SET NULL,
  discovered_lead_id  integer REFERENCES discovered_leads(id) ON DELETE SET NULL,
  contact_email       text,
  state               text NOT NULL DEFAULT 'active',
  halt_reason         text,
  last_step_sent      integer NOT NULL DEFAULT 0,
  next_send_at        timestamp,
  last_error          text,
  attempt             integer NOT NULL DEFAULT 0,
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);

-- ── Constraints ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_steps_step_number_check') THEN
    ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_step_number_check
      CHECK (step_number > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_steps_delay_days_check') THEN
    ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_delay_days_check
      CHECK (delay_days >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrolments_state_check') THEN
    ALTER TABLE sequence_enrolments ADD CONSTRAINT sequence_enrolments_state_check
      CHECK (state IN ('active','completed','halted','cancelled'));
  END IF;
  -- Closed vocabulary, mirroring LOSS_REASONS: "why do sequences stop early?" has to be a
  -- GROUP BY, not a prose summary. Keep in sync with SEQUENCE_HALT_REASONS.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrolments_halt_reason_check') THEN
    ALTER TABLE sequence_enrolments ADD CONSTRAINT sequence_enrolments_halt_reason_check
      CHECK (halt_reason IS NULL OR halt_reason IN (
        'replied','suppressed','no_recipient','not_connected','send_failed',
        'max_steps','record_closed','manual'));
  END IF;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- One enabled cadence per assistant. Choosing BETWEEN cadences by ICP segment is Phase 5 work;
-- until something can make that choice, a second row is just ambiguity about which one enrols.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_sequences_assistant_uidx
  ON outreach_sequences (ai_assistant_id);

CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_seq_step_uidx
  ON sequence_steps (sequence_id, step_number);

-- ⚠️ THE ANTI-DOUBLE-SEND CONSTRAINT. A lead enrolled twice runs two overlapping cadences and gets
-- double the follow-ups. This index is what makes that impossible rather than merely unlikely —
-- enrolInSequence relies on it via ON CONFLICT DO NOTHING, so do not drop it to "fix" a conflict.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrolments_thread_uidx
  ON sequence_enrolments (lead_thread_id);

-- The worker's claim path: active rows whose next_send_at has passed.
CREATE INDEX IF NOT EXISTS sequence_enrolments_due_idx
  ON sequence_enrolments (state, next_send_at);
CREATE INDEX IF NOT EXISTS sequence_enrolments_org_idx
  ON sequence_enrolments (organisation_id, created_at);

-- ── Verify (run manually after applying) ─────────────────────────────────────
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('outreach_sequences','sequence_steps','sequence_enrolments');
--   -- expect 3 rows
--
-- Once outreach has been sent, enrolments should exist and be advancing. `next_send_at` in the
-- past on an `active` row for more than one worker interval means the worker is not running:
--   SELECT e.id, e.state, e.halt_reason, e.last_step_sent, e.next_send_at, t.state AS thread_state
--     FROM sequence_enrolments e JOIN lead_threads t ON t.id = e.lead_thread_id
--    ORDER BY e.created_at DESC LIMIT 20;
--
-- The invariant that matters most — no active enrolment on a thread that has already replied.
-- This must always return zero rows:
--   SELECT e.id FROM sequence_enrolments e
--     JOIN lead_threads t ON t.id = e.lead_thread_id
--    WHERE e.state = 'active' AND t.state = 'replied';
