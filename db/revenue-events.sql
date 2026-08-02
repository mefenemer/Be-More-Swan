-- db/revenue-events.sql
-- Phase 0 of docs/lead-generator-revenue-engine-plan.md — the revenue ledger.
--
-- `revenue_events` is the append-only fact stream the whole revenue engine is built on. Every
-- lifecycle transition a lead goes through lands here, and the Phase 5 Strategy Agent reads ONLY
-- from this table when deciding whether to pivot the ICP.
--
-- WHY THIS TABLE EXISTS: today a lead's terminal state is approved / rejected / scheduled. Nothing
-- records won, lost, or WHY. Autonomous ICP pivoting is unbuildable without outcome labels, which
-- is why this is Phase 0 and everything else waits on it.
--
-- Written exclusively through src/utils/revenue-ledger.ts recordEvent(). The CHECK constraints
-- below mirror the closed vocabularies in src/config/revenue-events.ts and the check() calls in
-- db/schema.ts — all three MUST stay in sync (tests/revenue-ledger.test.ts asserts this; a later
-- drizzle-kit push would otherwise silently revert the DDL).
--
-- Apply manually as the table owner via scripts/db-migrate.mjs — no drizzle-kit push
-- (see docs/db-migrations.md; psql is not installed on the dev Mac).
--
-- Idempotent: safe to run repeatedly. The DDL is IF NOT EXISTS throughout and every backfill
-- INSERT is guarded by NOT EXISTS on (discovered_lead_id, event_type), so a second run adds
-- nothing. There is deliberately no UNIQUE constraint enforcing that — the table is append-only
-- and legitimately holds many rows of the same type for one lead (several outreach_sent, several
-- reply_received). The guard belongs in the backfill, not in the schema.
--
-- ⚠️ APPLY BEFORE DEPLOYING THE ACCOMPANYING CODE. recordEvent() writes to this table from the
-- discovery worker, the outreach send and the approval PATCH. Without it every call logs
-- '[revenue-ledger] failed to record event' and returns null. That is BY DESIGN non-fatal — the
-- ledger never breaks its caller — so the symptom is silently missing analytics, not an outage.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_events (
  id                  serial PRIMARY KEY,
  organisation_id     integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- Nullable: a backfilled or org-level event may have no surviving assistant instance.
  ai_assistant_id     integer REFERENCES ai_assistants(id) ON DELETE SET NULL,

  -- Subject of the event. Both nullable — a signal can arrive before either row exists.
  discovered_lead_id  integer REFERENCES discovered_leads(id) ON DELETE CASCADE,
  assistant_record_id integer REFERENCES assistant_records(id) ON DELETE SET NULL,

  event_type          text NOT NULL,
  actor               text NOT NULL DEFAULT 'system',
  actor_user_id       integer REFERENCES users(id) ON DELETE SET NULL,

  -- Terminal-event fields. NULL on every non-terminal event — the partial index depends on it.
  outcome             text,
  loss_reason         text,
  value_gbp           numeric(12,2),
  cycle_days          integer,

  -- THE ATTRIBUTION JOIN KEY. Without these you can measure that win rate moved but not WHICH
  -- strategy version moved it. NULL on backfilled rows: they predate strategy versioning and are
  -- unattributable by design — the Strategy Agent must tolerate NULL here and exclude them.
  icp_snapshot        jsonb,
  blueprint_version   text,

  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at         timestamp NOT NULL DEFAULT now()
);

-- ── Constraints ──────────────────────────────────────────────────────────────
-- Added separately with a guarded DO block so re-running is safe on a table that already has them
-- (ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS in Postgres).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_events_actor_check') THEN
    ALTER TABLE revenue_events ADD CONSTRAINT revenue_events_actor_check
      CHECK (actor IN ('system','agent','user'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_events_outcome_check') THEN
    ALTER TABLE revenue_events ADD CONSTRAINT revenue_events_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('won','lost','disqualified'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_events_loss_reason_check') THEN
    ALTER TABLE revenue_events ADD CONSTRAINT revenue_events_loss_reason_check
      CHECK (loss_reason IS NULL OR loss_reason IN (
        'price','timing','no_budget','competitor','no_response',
        'wrong_contact','not_icp','feature_gap','went_silent','other'
      ));
  END IF;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS revenue_events_org_type_idx
  ON revenue_events (organisation_id, event_type, occurred_at);

CREATE INDEX IF NOT EXISTS revenue_events_lead_idx
  ON revenue_events (discovered_lead_id, occurred_at);

-- The Strategy Agent's hot path: terminal outcomes for one org over a trailing window. PARTIAL,
-- because non-terminal rows are the overwhelming majority and never match this predicate.
CREATE INDEX IF NOT EXISTS revenue_events_outcome_idx
  ON revenue_events (organisation_id, outcome, occurred_at)
  WHERE outcome IS NOT NULL;

-- Supports the backfill's NOT EXISTS guard and the "has this lead already been recorded?" reads.
CREATE INDEX IF NOT EXISTS revenue_events_lead_type_idx
  ON revenue_events (discovered_lead_id, event_type)
  WHERE discovered_lead_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- BACKFILL
-- ════════════════════════════════════════════════════════════════════════════
-- Reconstructs history from the state we already have, so the Strategy Agent has data on day one
-- instead of starting cold. Every backfilled row is actor='system' with a NULL blueprint_version:
-- these are inferred facts, not observed ones, and marking them unattributable keeps them out of
-- any per-strategy-version aggregate.
--
-- Timestamps are the best available proxy, NOT the true moment — discovered_leads.created_at for
-- discovery, assistant_records.updated_at for the approval decision. Good enough for cohorting,
-- deliberately not good enough to trust for cycle-time analysis, which is why cycle_days is left
-- NULL on every backfilled row rather than computed from a proxy.

-- 1. Every discovered lead → lead_discovered, at its creation time.
INSERT INTO revenue_events (organisation_id, ai_assistant_id, discovered_lead_id, assistant_record_id,
                            event_type, actor, payload, occurred_at)
SELECT dl.organisation_id,
       dc.ai_assistant_id,
       dl.id,
       dl.assistant_record_id,
       'lead_discovered',
       'system',
       jsonb_strip_nulls(jsonb_build_object(
         'backfilled',    true,
         'domain',        dl.domain,
         'discoveredVia', dl.discovered_via,
         'matchedQuery',  dl.matched_query
       )),
       dl.created_at
FROM discovered_leads dl
JOIN discovery_campaigns dc ON dc.id = dl.campaign_id
WHERE NOT EXISTS (
  SELECT 1 FROM revenue_events re
  WHERE re.discovered_lead_id = dl.id AND re.event_type = 'lead_discovered'
);

-- 2. Leads that were scored → lead_scored, carrying the score and rating.
INSERT INTO revenue_events (organisation_id, ai_assistant_id, discovered_lead_id, assistant_record_id,
                            event_type, actor, payload, occurred_at)
SELECT dl.organisation_id, dc.ai_assistant_id, dl.id, dl.assistant_record_id,
       'lead_scored',
       'system',
       jsonb_build_object('backfilled', true, 'score', dl.score, 'rating', dl.rating),
       dl.created_at
FROM discovered_leads dl
JOIN discovery_campaigns dc ON dc.id = dl.campaign_id
WHERE dl.score IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM revenue_events re
    WHERE re.discovered_lead_id = dl.id AND re.event_type = 'lead_scored'
  );

-- 3. Leads with a contact address → lead_enriched.
--    emailKind/emailSource live in signals jsonb (see the enrichment stage in
--    process-discovery-jobs.ts); they matter because the personal-inbox gate reads them.
INSERT INTO revenue_events (organisation_id, ai_assistant_id, discovered_lead_id, assistant_record_id,
                            event_type, actor, payload, occurred_at)
SELECT dl.organisation_id, dc.ai_assistant_id, dl.id, dl.assistant_record_id,
       'lead_enriched',
       'system',
       jsonb_strip_nulls(jsonb_build_object(
         'backfilled',  true,
         'emailKind',   dl.signals ->> 'emailKind',
         'emailSource', dl.signals ->> 'emailSource'
       )),
       dl.created_at
FROM discovered_leads dl
JOIN discovery_campaigns dc ON dc.id = dl.campaign_id
WHERE dl.contact_email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM revenue_events re
    WHERE re.discovered_lead_id = dl.id AND re.event_type = 'lead_enriched'
  );

-- 4. Approval decisions from the Review Queue → lead_approved / lead_rejected.
--    Joined back to discovered_leads via assistant_record_id so the lead link survives; a manually
--    added lead has no discovered_leads row, so discovered_lead_id is legitimately NULL there and
--    the NOT EXISTS guard falls back to matching on assistant_record_id.
--    actor='user': unlike the rows above, an approval genuinely was a human decision.
INSERT INTO revenue_events (organisation_id, ai_assistant_id, discovered_lead_id, assistant_record_id,
                            event_type, actor, payload, occurred_at)
SELECT ar.organisation_id,
       ar.ai_assistant_id,
       dl.id,
       ar.id,
       CASE WHEN ar.approval_status = 'rejected' THEN 'lead_rejected' ELSE 'lead_approved' END,
       'user',
       jsonb_build_object('backfilled', true, 'approvalStatus', ar.approval_status),
       ar.updated_at
FROM assistant_records ar
LEFT JOIN discovered_leads dl ON dl.assistant_record_id = ar.id
WHERE ar.record_type = 'lead'
  AND ar.approval_status IN ('approved', 'scheduled', 'rejected')
  AND NOT EXISTS (
    SELECT 1 FROM revenue_events re
    WHERE re.assistant_record_id = ar.id
      AND re.event_type IN ('lead_approved', 'lead_rejected')
  );

-- 5. Leads that were actually emailed → outreach_sent.
--    data->>'outreachSentAt' is stamped by lead-generation.ts send_outreach, and is the only
--    durable record that a send happened.
INSERT INTO revenue_events (organisation_id, ai_assistant_id, discovered_lead_id, assistant_record_id,
                            event_type, actor, payload, occurred_at)
SELECT ar.organisation_id,
       ar.ai_assistant_id,
       dl.id,
       ar.id,
       'outreach_sent',
       'agent',
       jsonb_strip_nulls(jsonb_build_object(
         'backfilled', true,
         'to',         ar.data -> 'outreachDraft' ->> 'to'
       )),
       -- Stored as an ISO string by the send path; fall back to updated_at if it will not cast.
       COALESCE(
         (CASE WHEN (ar.data ->> 'outreachSentAt') ~ '^\d{4}-\d{2}-\d{2}T'
               THEN (ar.data ->> 'outreachSentAt')::timestamp END),
         ar.updated_at
       )
FROM assistant_records ar
LEFT JOIN discovered_leads dl ON dl.assistant_record_id = ar.id
WHERE ar.record_type = 'lead'
  AND ar.data ->> 'outreachSentAt' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM revenue_events re
    WHERE re.assistant_record_id = ar.id AND re.event_type = 'outreach_sent'
  );

-- ── Verify (run manually after applying) ─────────────────────────────────────
-- Count parity against the source tables. Row 1 should equal the discovered_leads count; if it
-- does not, the campaign join dropped leads whose campaign was hard-deleted.
--
--   SELECT event_type, count(*) FROM revenue_events GROUP BY event_type ORDER BY 2 DESC;
--   SELECT count(*) AS discovered_leads FROM discovered_leads;
--   SELECT count(*) AS lead_records FROM assistant_records WHERE record_type = 'lead';
--
-- Confirm the terminal invariant holds (must return 0 rows — nothing else may carry an outcome):
--   SELECT count(*) FROM revenue_events
--   WHERE (outcome IS NOT NULL) <> (event_type IN ('deal_won','deal_lost','deal_disqualified'));
