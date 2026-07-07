-- Backfill (issue #175 follow-up): recover meeting notes summarised before
-- assistant_records existed on staging.
--
-- db/internal-data-hub.sql (and the duplicate db/assistant-records.sql) created the
-- table, but persistHubRecords() in chat-orchestrator.ts silently swallowed every
-- insert while the table was missing (see those files' comments — the same soft-fail
-- that lost pre-migration leads for issue #176, recovered by db/backfill-lead-records.sql).
-- Any meeting summarised in chat before the migration ran was therefore never
-- persisted — the action_item_assignment card only survives in
-- chat_messages.ui_element_json. Creating the table did nothing for those
-- already-completed conversations: only a brand-new chat turn goes through
-- persistHubRecords, so the Meeting Note Taker's "Meeting Notes" tab kept
-- rendering its empty state for the reporter, who tested with a conversation
-- that pre-dated the migration.
--
-- This replays chat_messages the same way persistHubRecords does (one
-- assistant_records row per meeting title per assistant, most recent card wins,
-- falling back to the same "Meeting notes — <date>" title the app uses when the
-- LLM didn't name the meeting) so those meetings finally appear in the tab.
--
-- Idempotent — safe to re-run (skips meetings that already have a row).

INSERT INTO assistant_records
    (organisation_id, ai_assistant_id, record_type, title, status, source, data, created_at, updated_at)
SELECT DISTINCT ON (cs.organisation_id, cs.ai_assistant_id, title)
    cs.organisation_id,
    cs.ai_assistant_id,
    'meeting',
    title,
    CASE WHEN jsonb_typeof(cm.ui_element_json -> 'tasks') = 'array'
              AND jsonb_array_length(cm.ui_element_json -> 'tasks') > 0
         THEN 'open' ELSE 'no actions' END,
    'chat',
    cm.ui_element_json,
    cm.created_at,
    cm.created_at
FROM chat_messages cm
JOIN chat_sessions cs ON cs.id = cm.chat_session_id
CROSS JOIN LATERAL (
    SELECT COALESCE(
        NULLIF(TRIM(cm.ui_element_json ->> 'meetingTitle'), ''),
        'Meeting notes — ' || to_char(cm.created_at, 'YYYY-MM-DD')
    ) AS title
) t
WHERE cm.role = 'assistant'
  AND cm.ui_element_json ->> 'type' = 'action_item_assignment'
  AND NOT EXISTS (
        SELECT 1 FROM assistant_records ar
        WHERE ar.organisation_id = cs.organisation_id
          AND ar.ai_assistant_id = cs.ai_assistant_id
          AND ar.record_type = 'meeting'
          AND ar.title = t.title
      )
ORDER BY cs.organisation_id, cs.ai_assistant_id, title, cm.created_at DESC;
