-- Copy a published post to another platform — provenance for the copy.
-- Drizzle mirror: db/schema.ts::scheduledPosts (copied_from_post_id).
--
-- ── Why a new column rather than reusing crosspost_group_id ─────────────────────────────────────
-- A cross-post is one post going to several places AT THE SAME TIME: the rows share a group id, the
-- Review Queue collapses them into one card, and media/text writes fan out across them. None of
-- that is true here. The original has already PUBLISHED; the copy is a brand-new draft that still
-- needs reviewing, may carry a reworded caption, and will get its own slot. Putting it in the
-- published post's group would land a pending row on the same card as a post that has gone out —
-- the Review Queue groups by (crosspost_group_id, status), so the two would fight over one card.
--
-- ── ...and not revised_from_post_id either ─────────────────────────────────────────────────────
-- That column means "this post REPLACES that one" (reject → regenerate): the source is cancelled and
-- the replacement is the same post, redrafted. A copy replaces nothing. The original stays live and
-- both rows are real posts, so overloading it would make a published post look rejected.
--
-- copied_from_post_id: the published scheduled_posts row this draft was seeded from. ON DELETE SET
--   NULL — losing the original must never take the copy with it; the copy is a post in its own right
--   the moment it is created. Nullable, and NULL on every pre-existing row, which is correct: they
--   were not copied from anything.
--
-- The index answers the one question the API asks on every request: "which platforms has this post
-- already been copied to?", which is what stops a second click creating a duplicate draft.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).
--
-- ⚠️⚠️ APPLY THIS TO BOTH DATABASES *BEFORE* DEPLOYING THE CODE THAT READS IT. ⚠️⚠️
--
-- Five functions issue a bare `db.select()` on scheduled_posts, and a bare select names EVERY column
-- in db/schema.ts. A schema.ts that knows about this column while the database does not turns each
-- of them into a failed query — and not one of them is wrapped in a try/catch, so every failure is a
-- user-visible 500 rather than degraded behaviour:
--
--   netlify/functions/set-post-platforms.ts:67          every platform change in the post editor
--   netlify/functions/reject-post.ts:89                 the Review Queue's Reject button
--   netlify/functions/publish-youtube-background.ts:49  the YouTube PUBLISHER — strands the post
--   netlify/functions/scheduled-posts.ts:58             the calendar / scheduled list
--   netlify/functions/copy-post-to-platform.ts:159      the feature this column is for
--
-- Apply to STAGING (the local .env database) and then to PROD explicitly — the runner defaults to
-- whatever .env points at, so running it twice without --url-var applies it to staging twice and
-- reports success both times, because this file is IF NOT EXISTS:
--
--   npm run db:migrate:apply -- --only post-copied-from --yes
--   npm run db:migrate:apply -- --only post-copied-from --url-var DATABASE_URL_PROD --yes
--
-- --url-var takes a VARIABLE NAME, never a connection string.

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS copied_from_post_id INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scheduled_posts_copied_from_idx
  ON scheduled_posts (copied_from_post_id)
  WHERE copied_from_post_id IS NOT NULL;
