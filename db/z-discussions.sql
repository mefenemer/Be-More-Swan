-- db/z-discussions.sql — the Lead Generator's Discussions tab: public forum threads where someone is
-- asking for what this business sells, each with a drafted reply that a PERSON posts themselves.
-- src/config/discussion-sites.ts, src/lib/discussion-triage.ts, src/utils/discussions.ts,
-- netlify/functions/discussions.ts (the tab and the chat card), run-discussion-scan-background.ts.
-- Drizzle mirror: db/schema.ts (discussionWatches, discussions).
--
-- Nothing here posts anywhere. Threads are found through Google (Serper `site:` searches) and only
-- linked to; the reply is copied by the user and posted from their own account. That is the whole
-- design, not a phase-1 shortcut: automated self-promotion breaks Reddit's rules and the DMCC Act.
--
-- APPLY MANUALLY in the Neon SQL Editor, staging and prod separately, BEFORE the code deploys — until
-- it runs the tab says "not set up yet" and no scan starts. Idempotent: CREATE … IF NOT EXISTS only.
--
-- ── discussion_watches (one per assistant) ─────────────────────────────────
-- topics: the plain-English phrases searched for ("best CRM for a small florist"). sites: keys of
-- DISCUSSION_SITES. enabled: the daily scan runs. scan_status: idle | running — running is held
-- only while a worker is on it; scan_started_at lets a stuck run be released.
-- last_scan: what the last scan did ({ searches, found, kept, error? }) so the tab can say it.
--
-- ── discussions (one per thread per assistant) ─────────────────────────────
-- url is normalised (src/config/discussion-sites.ts normaliseThreadUrl) so the same thread found by
-- two searches is one row. fit: asking_for (they want what you sell) | can_help (you can answer).
-- read_from: page (the thread itself was read) | snippet (only Google's two lines — the card says so).
-- draft_reply ALWAYS ends with the disclosure line, added in code (discussionDisclosure).
-- status: new | replied | dismissed.

BEGIN;

CREATE TABLE IF NOT EXISTS discussion_watches (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    topics           TEXT[] NOT NULL DEFAULT '{}',
    sites            TEXT[] NOT NULL DEFAULT '{}',
    enabled          BOOLEAN NOT NULL DEFAULT true,
    scan_status      TEXT NOT NULL DEFAULT 'idle' CHECK (scan_status IN ('idle', 'running')),
    scan_started_at  TIMESTAMP,
    last_scanned_at  TIMESTAMP,
    last_scan        JSONB,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discussion_watches_assistant_uq ON discussion_watches (ai_assistant_id);
CREATE INDEX IF NOT EXISTS discussion_watches_org_idx ON discussion_watches (organisation_id);

CREATE TABLE IF NOT EXISTS discussions (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    site             TEXT NOT NULL,
    url              TEXT NOT NULL,
    title            TEXT NOT NULL,
    snippet          TEXT,
    posted_label     TEXT,
    matched_topic    TEXT,
    relevance        INTEGER NOT NULL DEFAULT 0 CHECK (relevance BETWEEN 0 AND 100),
    fit              TEXT NOT NULL DEFAULT 'can_help' CHECK (fit IN ('asking_for', 'can_help')),
    why              TEXT,
    draft_reply      TEXT,
    read_from        TEXT NOT NULL DEFAULT 'snippet' CHECK (read_from IN ('page', 'snippet')),
    status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'dismissed')),
    decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discussions_assistant_url_uq ON discussions (ai_assistant_id, url);
CREATE INDEX IF NOT EXISTS discussions_assistant_status_idx ON discussions (ai_assistant_id, status, created_at DESC);

COMMIT;

-- Check: expect 2 rows.
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('discussion_watches', 'discussions');
