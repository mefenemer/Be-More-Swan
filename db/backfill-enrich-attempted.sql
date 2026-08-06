-- Backfill: mirror `enrichAttemptedAt` from discovered_leads.signals onto the linked
-- assistant_records.data, for leads enriched BEFORE the mirror-on-miss change.
--
-- ⚠️ APPLY THIS BEFORE THE CODE DEPLOYS. The Leads tab's Contact column
-- (assistant-data-hub.js `contactState`) reads `data.enrichAttemptedAt` to tell "we looked and
-- this company publishes no address" (→ "None found") from "nobody has looked yet"
-- (→ "Checking…"). Ship the code first and every already-enriched hot/warm lead that came back
-- empty flips to a "Checking…" that never resolves, because the stamp it needs was never mirrored.
-- Same ordering rule as db/lead-reject-feedback.sql: the data has to be there before the UI
-- claims to read it.
--
-- Why the stamp was missing: recordEnrichment() in netlify/functions/process-discovery-jobs.ts
-- always wrote `enrichAttemptedAt` into discovered_leads.signals (hit or miss, so a miss is never
-- re-scraped), but returned early on a miss before mirroring anything onto the assistant_record.
-- The fact existed; it just never reached the table the Leads tab reads.
--
-- Idempotent — safe to re-run. Rows that already carry the key are skipped, and updated_at is
-- deliberately NOT touched: this is a repair, not activity on the lead, and bumping it would show
-- every backfilled lead as freshly updated in the Leads tab's Updated column.

UPDATE assistant_records ar
SET data = COALESCE(ar.data, '{}'::jsonb)
           || jsonb_build_object('enrichAttemptedAt', a.attempted_at)
FROM (
    -- One row per record. A company found by two campaigns maps onto ONE assistant_record
    -- (promoteOne upserts on title), so without the GROUP BY the join would pick an arbitrary
    -- attempt. min() over the ISO-8601 UTC strings recordEnrichment writes is lexicographically
    -- the EARLIEST attempt — the first time we looked, which is the honest answer.
    SELECT dl.assistant_record_id,
           min(dl.signals ->> 'enrichAttemptedAt') AS attempted_at
    FROM discovered_leads dl
    WHERE dl.assistant_record_id IS NOT NULL
      AND dl.signals ->> 'enrichAttemptedAt' IS NOT NULL
    GROUP BY dl.assistant_record_id
) a
WHERE ar.id = a.assistant_record_id
  AND ar.record_type = 'lead'
  AND ar.data ->> 'enrichAttemptedAt' IS NULL;
