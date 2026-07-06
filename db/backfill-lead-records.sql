-- Backfill (issue #176 follow-up): recover leads scored before assistant_records
-- existed on staging.
--
-- db/internal-data-hub.sql created the table, but persistHubRecords() in
-- chat-orchestrator.ts silently swallowed every insert while the table was
-- missing (see that file's comment). Any lead scored in chat before the
-- migration ran was therefore never persisted — the scoring card only survives
-- in chat_messages.ui_element_json. Creating the table did nothing for those
-- already-completed conversations: only a brand-new chat turn goes through
-- persistHubRecords, so the Leads tab kept rendering empty for anyone who
-- tested with a conversation that pre-dated the migration.
--
-- This replays chat_messages the same way persistHubRecords does (one
-- assistant_records row per lead name per assistant, most recent scoring card
-- wins) so those leads finally appear in the Leads tab.
--
-- Idempotent — safe to re-run (skips leads that already have a row).

INSERT INTO assistant_records
    (organisation_id, ai_assistant_id, record_type, title, status, source, data, created_at, updated_at)
SELECT DISTINCT ON (cs.organisation_id, cs.ai_assistant_id, cm.ui_element_json ->> 'leadName')
    cs.organisation_id,
    cs.ai_assistant_id,
    'lead',
    cm.ui_element_json ->> 'leadName',
    COALESCE(cm.ui_element_json ->> 'rating', 'scored'),
    'chat',
    cm.ui_element_json,
    cm.created_at,
    cm.created_at
FROM chat_messages cm
JOIN chat_sessions cs ON cs.id = cm.chat_session_id
WHERE cm.role = 'assistant'
  AND cm.ui_element_json ->> 'type' = 'lead_scoring_card'
  AND NULLIF(TRIM(cm.ui_element_json ->> 'leadName'), '') IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM assistant_records ar
        WHERE ar.organisation_id = cs.organisation_id
          AND ar.ai_assistant_id = cs.ai_assistant_id
          AND ar.record_type = 'lead'
          AND ar.title = cm.ui_element_json ->> 'leadName'
      )
ORDER BY cs.organisation_id, cs.ai_assistant_id, cm.ui_element_json ->> 'leadName', cm.created_at DESC;
