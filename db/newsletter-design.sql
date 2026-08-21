-- db/newsletter-design.sql
-- The Newsletter Design Studio, and what an issue is FOR.
-- Requires db/newsletter.sql and db/newsletter-sequences.sql.
--
-- ── Two columns, one feature each ───────────────────────────────────────────────────────────────
--
-- 1. `design` (jsonb) — the laid-out issue: an ordered list of blocks (heading, text, image,
--    button, divider, spacer, two-column) plus a theme. NULL means "this issue is plain Markdown",
--    which is what every issue written before today is, and what the assistant still writes by
--    default. ⚠️ body_markdown IS NOT REPLACED. It stays the canonical prose — the text part of the
--    email is built from it, the assistant reads and rewrites it, and the word-count findings
--    count it. A design is a LAYOUT AROUND the words, and the two are kept in step by
--    src/utils/newsletter-design.ts (designToMarkdown) rather than by hoping the author edits both.
--
--    ⚠️ Image blocks store an ASSET ID, never a URL. R2 URLs are presigned and expire in minutes;
--    an email sits in an inbox for years. The snapshot resolves each asset to the signed, durable
--    /api/newsletter/media route at APPROVAL time (netlify/functions/newsletter-media.ts).
--
--    ⚠️ Text and stickers over an image are BAKED into a new image on save, not positioned in the
--    HTML. Absolutely-positioned text over a picture works in a browser and falls apart in Outlook,
--    and half of everyone blocks images anyway — so an overlay that lives in the markup is an
--    overlay most recipients see in the wrong place or not at all. The editor bakes with canvas
--    (src/components/image-overlay-editor.js) exactly as the social composer does, and the block
--    keeps `baseAssetId` so a re-edit never composites onto an already-baked picture.
--
-- 2. `purpose` (text) — what kind of email this is: an ordinary newsletter, a product update, a
--    maintenance or bug-fix notice, a change to terms, an event, an offer. It steers three things
--    that used to be the same for every issue regardless: which template a new issue starts from,
--    how the assistant is briefed, and how the issue is labelled in the list. A terms-change notice
--    written in newsletter voice is the failure this closes.
--
--    ⚠️ NOT a CHECK constraint. The vocabulary lives in src/config/newsletter-purposes.ts and will
--    grow; a constraint here would mean a two-environment SQL deploy for every new one, and an
--    unrecognised purpose degrades to 'newsletter' in the UI rather than breaking a write. See
--    [[check-constraints-have-two-homes]] for why we are sparing with these.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE — db.select() names every column, so the code
-- reading these will 42703 against a database that has not had this run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_issues') THEN
    RAISE NOTICE 'newsletter_issues is missing — apply db/newsletter.sql first. Skipping.';
    RETURN;
  END IF;

  ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS design jsonb;
  ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'newsletter';

  -- Steps get the SAME two columns for the same reasons. A welcome email is an email: it is read
  -- in the same inboxes, by people who have just met the business, and it was the one email in the
  -- product that could not carry a picture. See db/newsletter-sequences.sql.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'newsletter_sequence_steps') THEN
    ALTER TABLE newsletter_sequence_steps ADD COLUMN IF NOT EXISTS design jsonb;
  END IF;

  -- Cheap and worth having: the Studio filters the list by purpose, and an org with a thousand
  -- issues should not sequential-scan to draw a tab.
  --
  -- ⚠️ INSIDE the guarded block. Every db/newsletter-*.sql file sorts BEFORE db/newsletter.sql
  -- alphabetically ('-' < '.'), so on a database being built from scratch this runs before the
  -- table exists — which is why the whole file is wrapped in the existence check above. A bare
  -- CREATE INDEX out here would be the one statement that still errored, failing the run.
  CREATE INDEX IF NOT EXISTS newsletter_issues_org_purpose_idx
    ON newsletter_issues (organisation_id, purpose);
END $$;
