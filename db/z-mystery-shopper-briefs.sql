-- db/z-mystery-shopper-briefs.sql — the Mystery Shopper's briefs to other assistants, kept as history.
-- Code: netlify/functions/site-audits.ts (actions `brief` / `unbrief`, and `get` returns them),
-- src/components/assistant-site-audit.js (the Website tab's "Ideas for your other assistants" and
-- "History"), src/components/chat-session.js (the chat's hand-off card), src/utils/site-audit-snapshot.ts.
-- Drizzle mirror: db/schema.ts (siteAuditBriefs).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-mystery-shopper-briefs                              (staging)
--   npm run db:migrate:apply -- --only z-mystery-shopper-briefs --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: before the code is best, but not required — `get` reads this table inside a try/catch and
-- shows no history until it exists; only the Brief buttons' "mark as actioned" write needs it (the
-- chat still opens either way).
--
-- Why a table: a "Brief <name>" click opens another assistant's chat with the brief typed in. Once
-- clicked, that suggestion is ACTIONED — it leaves "Ideas for your other assistants" and goes to
-- History, with who it went to and when. The ideas themselves live in each run's report JSON
-- (site_audit_runs.report->'handoffs'), which is the record of what the check said and is never
-- edited; this table is the record of what the user did with it.
--
--   source 'idea'        — one of a check's ideas: run_id + handoff_index name it (unique together)
--   source 'stalled_fix' — the "isn't on your site yet, say it in a post meanwhile" nudge on a fix
--                          the user said they'd make (unique per fix)
--   source 'chat'        — a hand-off card the Mystery Shopper's chat proposed
-- brief/title are copied at the time, so History reads the same after the run or fix has gone.

BEGIN;

CREATE TABLE IF NOT EXISTS site_audit_briefs (
    id                   SERIAL PRIMARY KEY,
    audit_id             INTEGER NOT NULL REFERENCES site_audits(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    source               TEXT NOT NULL CHECK (source IN ('idea', 'stalled_fix', 'chat')),
    run_id               INTEGER REFERENCES site_audit_runs(id) ON DELETE CASCADE,
    handoff_index        SMALLINT,
    fix_id               INTEGER REFERENCES site_audit_fixes(id) ON DELETE CASCADE,
    target_role          TEXT NOT NULL,
    target_assistant_id  INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,
    target_name          TEXT,
    title                TEXT,
    brief                TEXT NOT NULL,
    briefed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT site_audit_briefs_shape_check CHECK (
        (source = 'idea' AND run_id IS NOT NULL AND handoff_index IS NOT NULL)
        OR (source = 'stalled_fix' AND fix_id IS NOT NULL)
        OR source = 'chat'
    )
);

CREATE INDEX IF NOT EXISTS site_audit_briefs_audit_idx ON site_audit_briefs (audit_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS site_audit_briefs_idea_uq ON site_audit_briefs (run_id, handoff_index) WHERE source = 'idea';
CREATE UNIQUE INDEX IF NOT EXISTS site_audit_briefs_fix_uq ON site_audit_briefs (fix_id) WHERE source = 'stalled_fix';

COMMIT;
