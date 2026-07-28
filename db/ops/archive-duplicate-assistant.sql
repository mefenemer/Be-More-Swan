-- db/ops/archive-duplicate-assistant.sql
-- ONE-OFF OPERATIONAL SCRIPT — run in the Neon console, against PRODUCTION only.
-- Not a migration. Nothing here runs automatically; nothing imports it.
--
-- Purpose: an org on a one-assistant plan ended up with two, because onboarding.ts had no capacity
-- check and a stale onboarding draft kept sending the user back through the form. The code fix is in
-- (netlify/functions/onboarding.ts + src/utils/assistant-capacity.ts); this cleans up the row that
-- already exists.
--
-- ── Read this before running anything ───────────────────────────────────────────────────────────
-- ARCHIVE, don't DELETE. ai_assistants has ~20 child tables on ON DELETE CASCADE — blueprints, chat
-- sessions, assistant records, task runs, calendars. A hard DELETE takes all of it, irreversibly and
-- silently. Archiving:
--    • frees the plan seat IMMEDIATELY (check-capacity counts only provisioning / ready_for_work /
--      working, so 'archived' releases the £29 plan's slot straight away)
--    • leaves a 14-day reinstate window before purge-archived-assistants.ts sweeps it
--    • is what the app's own "More actions → Archive" button does
--
-- If the UI button works, USE IT INSTEAD. It does everything below AND sends the archive
-- notification, which this script does not. Steps 1 and 2 are read-only — run them regardless.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 1 — READ ONLY. Which assistants does the org have, and which is the keeper?
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Replace the email with the account that owns the workspace.
-- Org is resolved through the user_organisations junction, NOT users.organisation_id — that column
-- is deprecated (see src/utils/tenant.ts): membership lives in user_organisations, and the app acts
-- in the most-recently-joined org. LIMIT 1 on joined_at DESC mirrors that exactly.
WITH me AS (
  SELECT uo.user_id, uo.organisation_id AS org_id
  FROM users u
  JOIN user_organisations uo ON uo.user_id = u.id
  WHERE LOWER(u.email) = LOWER('REPLACE_WITH_YOUR_EMAIL')
  ORDER BY uo.joined_at DESC
  LIMIT 1
)
SELECT
  a.id,
  a.name,
  a.lifecycle_status,
  a.provisioning_status,
  a.is_active,
  a.created_at,
  a.master_assistant_id,
  -- How much work is actually attached. The one with history is almost certainly the keeper.
  (SELECT count(*) FROM scheduled_posts sp WHERE sp.assistant_id = a.id)  AS posts,
  (SELECT count(*) FROM ai_blueprints b     WHERE b.assistant_id = a.id)  AS blueprints,
  (SELECT count(*) FROM task_runs t         WHERE t.assistant_id = a.id)  AS task_runs
FROM ai_assistants a
JOIN me ON me.org_id = a.organisation_id
ORDER BY a.created_at;

-- Expect two rows. Note the id of the DUPLICATE (usually the newer one, with 0 posts and
-- 0 blueprints). Everything below refers to it as :dup_id — substitute the number by hand.


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 2 — READ ONLY. What a hard DELETE would destroy, if you were considering one.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Run this even if you intend to archive: a non-zero count anywhere is a reason NOT to delete.
SELECT 'scheduled_posts'   AS child_table, count(*) FROM scheduled_posts    WHERE assistant_id = :dup_id
UNION ALL SELECT 'ai_blueprints',          count(*) FROM ai_blueprints      WHERE assistant_id = :dup_id
UNION ALL SELECT 'task_runs',              count(*) FROM task_runs          WHERE assistant_id = :dup_id
-- NB: assistant_records and chat_sessions key on ai_assistant_id, the others on assistant_id.
UNION ALL SELECT 'assistant_records',      count(*) FROM assistant_records  WHERE ai_assistant_id = :dup_id
UNION ALL SELECT 'chat_sessions',          count(*) FROM chat_sessions      WHERE ai_assistant_id = :dup_id;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 3 — THE CHANGE. Archive the duplicate. Reversible for 14 days.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Mirrors manage-assistant.ts's DELETE branch exactly:
--   transitionAssistantStatus(...,'archived')  → lifecycle_status='archived', is_active=false
--   + provisioning_status='cancelled', archived_at=now, scheduled_deletion_at=now+14d
--   + an audit_logs row
--   + cancels queued/in-flight task runs
--
-- On the trigger: ai_assistants_lifecycle_sync normally DERIVES lifecycle_status from
-- (provisioning_status, is_active). It respects an explicit write when lifecycle_status differs
-- from OLD — which it does here — and 'cancelled' derives 'archived' anyway, so both paths agree.
--
-- Wrapped in a transaction. Check the row counts before COMMIT.
BEGIN;

-- 3a. The state change. The id guard is belt-and-braces: it refuses to touch a row that is already
--     archived, so re-running this cannot move the deletion deadline forward.
UPDATE ai_assistants
   SET lifecycle_status      = 'archived',
       is_active             = false,
       provisioning_status   = 'cancelled',
       archived_at           = now(),
       scheduled_deletion_at = now() + interval '14 days',
       updated_at            = now()
 WHERE id = :dup_id
   AND lifecycle_status <> 'archived';
-- Expect: UPDATE 1

-- 3b. Stop anything queued from running, exactly as manage-assistant.ts does — it DELETES the
--     non-terminal runs rather than marking them, since there is no separate session store and a
--     queued run is the live "session". Completed/failed history is preserved on purpose (AC5.3).
DELETE FROM task_runs
 WHERE assistant_id = :dup_id
   AND status IN ('pending', 'running', 'reviewing', 'suspended');
-- Expect: DELETE 0 on a duplicate that never did any work.

-- 3c. Leave a trail. The UI path writes this; doing it by hand should too.
INSERT INTO audit_logs (user_id, action_type, resource_type, resource_id, previous_state, new_state, created_at)
SELECT a.user_id,
       'assistant_lifecycle_archived',
       'ai_assistants',
       a.id::text,
       jsonb_build_object('lifecycleStatus', 'working'),
       jsonb_build_object('lifecycleStatus', 'archived',
                          'organisationId', a.organisation_id,
                          'reason', 'manual_sql_duplicate_cleanup'),
       now()
FROM ai_assistants a
WHERE a.id = :dup_id;
-- Expect: INSERT 0 1

COMMIT;
-- ROLLBACK; -- ← use this instead if any count above looked wrong


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 4 — VERIFY. The seat should now be free.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- occupied_seats is exactly what check-capacity counts. On the £29 plan it must read 1.
WITH me AS (
  SELECT uo.organisation_id AS org_id
  FROM users u
  JOIN user_organisations uo ON uo.user_id = u.id
  WHERE LOWER(u.email) = LOWER('REPLACE_WITH_YOUR_EMAIL')
  ORDER BY uo.joined_at DESC
  LIMIT 1
)
SELECT
  (SELECT count(*) FROM ai_assistants a
     JOIN me ON me.org_id = a.organisation_id
    WHERE a.lifecycle_status IN ('provisioning','ready_for_work','working')) AS occupied_seats,
  (SELECT count(*) FROM ai_assistants a
     JOIN me ON me.org_id = a.organisation_id
    WHERE a.lifecycle_status = 'archived')                                   AS archived,
  (SELECT scheduled_deletion_at FROM ai_assistants WHERE id = :dup_id)       AS purges_after;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 5 — UNDO, if you archived the wrong one. Only works before the 14 days are up.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Same as the app's "reinstate" action.
UPDATE ai_assistants
   SET lifecycle_status      = 'working',
       is_active             = true,
       provisioning_status   = 'complete',
       archived_at           = NULL,
       scheduled_deletion_at = NULL,
       updated_at            = now()
 WHERE id = :dup_id
   AND lifecycle_status = 'archived';


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 6 — ALSO CLEAR THE STALE DRAFT that caused this.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- The leftover onboarding_drafts row is what kept the setup wizard saying "not complete" and
-- offering the link back into the form. The code fix stops NEW ones surviving a submission; this
-- clears the one already there. Check first:
-- Matched by user_id, not org: onboarding_drafts.organisation_id is nullable on legacy rows, but
-- user_id is NOT NULL, and a draft belongs to the person who started it.
WITH me AS (
  SELECT u.id AS user_id
  FROM users u WHERE LOWER(u.email) = LOWER('REPLACE_WITH_YOUR_EMAIL')
)
SELECT d.id, d.onboarding_path, d.role_key, d.display_name, d.current_step, d.updated_at
FROM onboarding_drafts d
JOIN me ON me.user_id = d.user_id
ORDER BY d.updated_at DESC;

-- Then remove only the finished path's drafts (substitute the path you saw above, e.g.
-- 'social_media'). Safe: a draft is recoverable form input, not published work — and the assistant
-- it produced already exists.
-- DELETE FROM onboarding_drafts d
--  USING users u
--  WHERE d.user_id = u.id
--    AND LOWER(u.email) = LOWER('REPLACE_WITH_YOUR_EMAIL')
--    AND d.onboarding_path = 'REPLACE_WITH_PATH';


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- NOT RECOMMENDED — hard delete. Included only so it is not improvised under pressure.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- This cascades to every child table. There is no undo. Only consider it if STEP 2 returned all
-- zeros, and even then archiving is the better answer: purge-archived-assistants.ts will do exactly
-- this automatically after 14 days, by which time you will know you did not need the row.
--
-- BEGIN;
-- DELETE FROM ai_assistants WHERE id = :dup_id;   -- expect DELETE 1
-- COMMIT;
