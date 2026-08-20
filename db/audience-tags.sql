-- db/audience-tags.sql
-- Tags: arbitrary labels a tenant attaches to people, and then composes into an audience.
-- Requires db/audience.sql.
--
-- ── ⚠️ WHY THERE IS NO audience_tags TABLE ─────────────────────────────────────────────────────
-- A tag is a label attached to some contacts. A manual segment is a label attached to some
-- contacts. They are the same data, and audience_contact_segments already stores it — with the
-- tenancy re-check on every write, the cascade rules, and the four readers that answer "who is in
-- this group" already built against it.
--
-- A second table would mean a second answer to that question, and in this product "who is in this
-- group" is "who receives an email". Two sources of truth for that is the failure this schema has
-- spent several migrations avoiding. So a tag is a segment with kind = 'tag', and the ONLY thing
-- the new kind changes is presentation: tags are listed separately, are not offered first in the
-- newsletter's audience picker, and are what a dynamic rule composes over.
--
-- What this buys, concretely: "everyone tagged 'bought something' who has not opened an email in
-- 60 days" is a dynamic segment with two conditions — which is Kit's model (tags are the primitive,
-- segments are saved rules over them) reached without a new table.
--
-- ⚠️ ONE VOCABULARY, RE-CREATED. db/audience.sql adds this constraint only IF NOT EXISTS, so an
-- "add if missing" here would silently do nothing and the first tag would fail at 23514. Same shape
-- as db/newsletter-preferences.sql — see the fresh-install note there.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE: bare `db.select()` reads on audience_segments
-- name every column, and the app writes kind = 'tag' as soon as it ships.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audience_segments') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/audience-tags.sql requires db/audience.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

ALTER TABLE audience_segments DROP CONSTRAINT IF EXISTS audience_segments_kind_check;
ALTER TABLE audience_segments ADD CONSTRAINT audience_segments_kind_check
  CHECK (kind IN ('manual','dynamic','tag'));

-- Listing one kind at a time is now the common read: the Audience page draws segments and tags in
-- two rows, and the newsletter's audience picker offers them in two groups.
CREATE INDEX IF NOT EXISTS audience_segments_org_kind_idx
  ON audience_segments (organisation_id, kind);

-- Verify:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'audience_segments_kind_check';
