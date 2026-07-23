-- Per-post opt-out for the AI disclosure footer (EU AI Act Art. 50).
-- Drizzle mirror: db/schema.ts::scheduledPosts.disclosureFooterDisabled.
--
-- The disclosure footer is appended deterministically to every generated caption (src/utils/
-- disclosure-footer.ts) and is ON by default via the workspace setting. This flag lets a reviewer
-- remove it from ONE post — toggle-post-disclosure.ts strips the exact footer text from the caption
-- and sets this true; re-enabling appends it back.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS disclosure_footer_disabled BOOLEAN NOT NULL DEFAULT false;
