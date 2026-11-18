-- db/z-page-comments.sql — the Social Media assistant's Comments tab: comments people leave on the
-- posts it published to a LinkedIn Company Page, each with a reply the assistant drafts and a Page
-- admin approves. The approved reply is posted AS the Page (w_organization_social_feed).
-- src/utils/linkedin-page-api.ts (the LinkedIn calls), src/utils/page-comments.ts (the one server
-- path), netlify/functions/page-comments.ts (the tab and the chat card),
-- netlify/functions/ingest-linkedin-insights.ts (fetches new comments every 6 hours).
-- Drizzle mirror: db/schema.ts (pageComments).
--
-- APPLY MANUALLY, staging and prod separately, BEFORE the code deploys — until it runs the tab says
-- "not set up yet" and the ingest skips comments (post statistics still land). Idempotent.
--
-- platform: 'linkedin' only today; the column is here so Facebook/Instagram comments can join later
-- without a second table. comment_urn is LinkedIn's urn:li:comment:(<thread>,<id>), unique per
-- connection. object_urn = the post the comment is on (a reply's `object`). author_name is null when
-- LinkedIn would not say who wrote it (the tab then says "A LinkedIn member").
-- status: new | replied | dismissed. replied_via: app (posted from here) | linkedin (the Page
-- replied on LinkedIn itself — seen on the next fetch). reply_comment_urn = the Page's reply.

BEGIN;

CREATE TABLE IF NOT EXISTS page_comments (
    id                 SERIAL PRIMARY KEY,
    organisation_id    INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id    INTEGER REFERENCES ai_assistants(id) ON DELETE CASCADE,
    connection_id      INTEGER NOT NULL REFERENCES system_connections(id) ON DELETE CASCADE,
    scheduled_post_id  INTEGER REFERENCES scheduled_posts(id) ON DELETE CASCADE,
    platform           TEXT NOT NULL DEFAULT 'linkedin' CHECK (platform IN ('linkedin')),
    comment_urn        TEXT NOT NULL,
    object_urn         TEXT,
    author_urn         TEXT,
    author_name        TEXT,
    body               TEXT NOT NULL,
    commented_at       TIMESTAMP,
    draft_reply        TEXT,
    status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'dismissed')),
    replied_via        TEXT CHECK (replied_via IN ('app', 'linkedin')),
    reply_text         TEXT,
    reply_comment_urn  TEXT,
    decided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at         TIMESTAMP,
    created_at         TIMESTAMP NOT NULL DEFAULT now(),
    updated_at         TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS page_comments_connection_urn_uq ON page_comments (connection_id, comment_urn);
CREATE INDEX IF NOT EXISTS page_comments_assistant_status_idx ON page_comments (ai_assistant_id, status, commented_at DESC);
CREATE INDEX IF NOT EXISTS page_comments_org_idx ON page_comments (organisation_id);

COMMIT;

-- Check: expect 1 row.
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'page_comments';
