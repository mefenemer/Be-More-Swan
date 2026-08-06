-- db/campaign-records.sql
-- Widen the assistant_records CHECK so the Campaign Assistant's two artefacts can persist.
-- APPLY MANUALLY (project convention — new db/*.sql are not pushed by drizzle-kit).
-- Apply this BEFORE deploying the code, not after: netlify/functions/campaigns.ts writes both
-- record types on its first successful order, and a check violation surfaces as a generic 502
-- with the real Postgres error only in the function logs.
--
-- Why two new types:
--   * campaign_order    → the Data Hub "Orders" tab. Mirrors campaign_orders so the existing
--                         records renderer draws the table with no new client code.
--   * campaign_decision → the Review Queue. Mirrors campaign_decisions (pending_approval) so the
--                         existing approve/reject gate works unchanged.
--
-- Both are additive: every Data Hub / Review Queue query filters on an explicit record_type, so
-- no existing read changes behaviour. `source` needs no widening — orders and decisions are
-- written with the already-legal 'agent'.
--
-- ⚠️ Keep this in lockstep with the check() calls in db/schema.ts (assistantRecords). They drifted
-- once already and a future drizzle-kit push would revert the DDL to whatever schema.ts says.

BEGIN;

ALTER TABLE assistant_records
  DROP CONSTRAINT IF EXISTS assistant_records_type_check;
ALTER TABLE assistant_records
  ADD CONSTRAINT assistant_records_type_check
  CHECK (record_type IN (
    'lead', 'enrichment', 'meeting', 'invoice', 'ticket', 'lead_idea',
    'campaign_order', 'campaign_decision'
  ));

COMMIT;
