-- db/z-meeting-imports.sql — the Note Taker picks up meetings from Google Meet, Teams and Zoom by itself
-- (docs/meeting-apps-pickup-plan.md §2, the shared engine). src/utils/meeting-pickup.ts is the engine,
-- netlify/functions/meeting-pickup.ts the 15-minute check, meeting-import-background.ts the writer.
-- Drizzle mirror: db/schema.ts (meetingImports, meetingPickupState).
--
-- APPLY MANUALLY, staging and prod separately. Additive and idempotent. Until it runs, the check finds no
-- table, logs it and does nothing; no platform is switched on yet either, so nothing is picked up.
--
-- meeting_imports: one row per platform meeting per workspace. The unique key means a meeting is never
-- written up twice, however many times a check sees it. A meeting two workspaces both attended is one row in
-- each (each gets its own minutes).
--   status: found → writing → written | skipped | failed. 'found' rows are retried until the transcript is
--   ready; skip_reason says why one was never written ('no_transcript' after 24 hours, 'no_meeting' when the
--   model found no meeting in it, 'task_limit', 'assistant_gone'). last_error never holds transcript text.
--   lease_until: a writer's claim, so two writers never write the same meeting.
-- meeting_pickup_state: per workspace and platform, when it was last checked and how far — what the
-- Connections tab shows ("last checked … · N meetings with a transcript found").

BEGIN;

CREATE TABLE IF NOT EXISTS meeting_imports (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id  INTEGER REFERENCES ai_assistants(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL CHECK (platform IN ('google_meet', 'teams', 'zoom')),
    external_id      TEXT NOT NULL,
    title            TEXT,
    meeting_link     TEXT,
    started_at       TIMESTAMP,
    ended_at         TIMESTAMP,
    status           TEXT NOT NULL DEFAULT 'found' CHECK (status IN ('found', 'writing', 'written', 'skipped', 'failed')),
    skip_reason      TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    lease_until      TIMESTAMP,
    record_id        INTEGER REFERENCES assistant_records(id) ON DELETE SET NULL,
    written_at       TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_imports_org_platform_external_uq ON meeting_imports (organisation_id, platform, external_id);
CREATE INDEX IF NOT EXISTS meeting_imports_due_idx ON meeting_imports (status, ended_at) WHERE status = 'found';
CREATE INDEX IF NOT EXISTS meeting_imports_record_idx ON meeting_imports (record_id) WHERE record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_pickup_state (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL CHECK (platform IN ('google_meet', 'teams', 'zoom')),
    last_checked_at  TIMESTAMP,
    checked_through  TIMESTAMP,
    last_found       INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_pickup_state_org_platform_uq ON meeting_pickup_state (organisation_id, platform);

COMMIT;

-- Check: expect 2 rows.
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('meeting_imports', 'meeting_pickup_state');
