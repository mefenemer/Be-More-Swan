-- A thumbnail for a post in a LIST — the blog widget's cards, and The Swan Index's front page.
--
-- ── What was actually wrong ────────────────────────────────────────────────────────────────────
-- The Swan Index front page rendered the "TSI" plate on EVERY card, and it read as "these authors
-- do not add pictures". It was not: swan-index/queries.ts CARD_COLUMNS never selected an image at
-- all, so SwanCard.imageUrl was undefined for every card ever rendered. A post with a perfectly
-- good feature image showed the same placeholder. The lead story had the same hole and simply
-- rendered no figure, which is why only the cards beneath it looked broken.
--
-- The blog widget had the plainer version of the same gap: its list endpoint never returned an
-- image, so every card on every customer's blog was a headline and an excerpt.
--
-- ── Why a column, and not a read-time parse ────────────────────────────────────────────────────
-- The image lives inside published_payload, which holds the ENTIRE rendered article body. Finding
-- it at read time means dragging one full article out of the heap per card: 50 of them for a
-- default widget page, seven for the Swan Index front page — the one query whose stated design
-- goal (see the CARD_COLUMNS note in swan-index/queries.ts) is a single indexed scan.
--
-- So the choice is made ONCE, at publish, and three small columns carry the answer. This also
-- settles the harder question quietly: the magazine and the author's own blog read the same
-- derived value, so a syndicated post cannot show one picture in one place and another elsewhere.
--
-- ── Why a reference and not a URL ──────────────────────────────────────────────────────────────
-- Presigned R2 URLs expire. An asset id is what persists, and blog-media-resolve.ts mints a fresh
-- URL per request — the same rule the inline body media has always followed. External images (a
-- stock photo embedded straight from its origin, which is what most posts actually have today) are
-- stored as the URL itself, https only.
--
-- ── The ladder ────────────────────────────────────────────────────────────────────────────────
-- src/utils/blog-card-image.ts owns the choice and is the only implementation of it:
--   1. the feature image, if the author set one — the only tier that is a deliberate choice;
--   2. otherwise the FIRST usable image in the body;
--   3. otherwise nothing, and each surface draws its own placeholder.
-- Tier 3 is a real answer. A text-only essay has no photograph, and saying so reads better than a
-- stretched stock image nobody picked.
--
-- Staleness behaves exactly as title and dek already do on swan_index_posts: written on publish and
-- re-publish, unaffected by an edit that was never published. That is the existing contract.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

-- ---------------------------------------------------------------------------------------------
-- blog_posts — where the choice is made, at publish time (src/utils/blog-publish.ts).
-- ---------------------------------------------------------------------------------------------

-- An asset in OUR storage. ON DELETE SET NULL, never CASCADE: deleting an image must cost the post
-- its thumbnail, not the post.
ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS card_image_asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL;

-- Somebody else's URL, used as-is. https only — blog-card-image.ts enforces the same rule at write
-- time, and the reason is in the comment there: every surface is served over https, so an http
-- image is mixed content, blocked by the browser, and shows as a broken-image glyph. That is worse
-- than no image at all, because it reads as our fault rather than as an article without a picture.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS card_image_url TEXT;

ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS card_image_alt TEXT;

DO $$ BEGIN
  ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_card_image_check
    CHECK (card_image_asset_id IS NULL OR card_image_url IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------------------------
-- swan_index_posts — copied from blog_posts when the author syndicates.
-- ---------------------------------------------------------------------------------------------
-- db/swan-index.sql is emphatic that this table REFERENCES blog_posts rather than copying it, and
-- that "only the fields curation needs to sort, filter and paginate on are denormalised onto the
-- row". A thumbnail is none of those. But the denormalised set already includes title and dek,
-- which are not sort or filter fields either — the rule the table actually follows is "small
-- fields a LIST needs without touching the body", and a thumbnail reference is one of those.
--
-- Copied rather than re-derived, so there is exactly one implementation of the ladder.
ALTER TABLE swan_index_posts
  ADD COLUMN IF NOT EXISTS card_image_asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL;

ALTER TABLE swan_index_posts ADD COLUMN IF NOT EXISTS card_image_url TEXT;

ALTER TABLE swan_index_posts ADD COLUMN IF NOT EXISTS card_image_alt TEXT;

-- One source or the other, never both. Without it a row could carry an asset id AND a URL, leaving
-- the readers free to disagree about which wins — the sort of split that surfaces as one thumbnail
-- on the front page and a different one in the section list, with nothing obviously broken.
DO $$ BEGIN
  ALTER TABLE swan_index_posts ADD CONSTRAINT swan_index_posts_card_image_check
    CHECK (card_image_asset_id IS NULL OR card_image_url IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------------------------
-- ⚠️ No backfill in this file.
-- ---------------------------------------------------------------------------------------------
-- Existing posts keep NULL and go on showing no thumbnail until they are re-published, or until
-- the backfill runs. Choosing the image means parsing the post body, and that logic lives in
-- blog-card-image.ts. Doing it again in SQL — one regexp for data-bms-asset, another for src=, and
-- no way to express "whichever <img> comes FIRST" — would be a second, subtly different
-- implementation of the single rule this whole feature exists to keep single.
--
--   npx tsx scripts/backfill-card-images.ts                       # dry run, staging
--   npx tsx scripts/backfill-card-images.ts --apply
--   npx tsx scripts/backfill-card-images.ts --apply --url-var=DATABASE_URL_PROD
--
-- ⚠️ --url-var takes the NAME of an environment variable, never a connection string.
