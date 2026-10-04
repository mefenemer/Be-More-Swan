-- AI music generation (Stable Audio 3.0, called direct at Stability AI) — paid from the plan's AI
-- credits, the same pool AI images and videos draw on.
--
-- A generated track is one more kind of media_generation_jobs row and one more kind of ledger debit,
-- so this file only WIDENS three CHECK constraints. No new columns: process-media-job-background
-- does `db.select().from(mediaGenerationJobs)`, which names every column in db/schema.ts — a column
-- added there before this file is applied would break the VIDEO worker, not just music. (The
-- Stability generation id is stored in fal_request_id; see src/lib/stability-audio.ts.)
--
-- ⚠️ DROP then ADD with the FULL list, because the originals were created with fixed lists and an
-- "add if missing" guard would silently no-op. Safe to re-run: nothing depends on a CHECK
-- constraint, so the DROP never fails the way a dropped unique key with an FK on it does
-- (see the swan-index incident). Every previously-legal value is kept — tests/ai-music-generation.test.ts
-- diffs these lists against the files that defined them before.
--
-- ⚠️ Named `z-…` ON PURPOSE. The runner applies db/*.sql alphabetically, and on a fresh database this
-- must come after media-generation.sql (which creates the table) and after BOTH x-*credit*.sql files
-- (which each redefine the ledger list — an earlier name would have its 'music_generation' dropped
-- again by whichever ran next).
--
-- Apply MANUALLY as the DB owner to BOTH staging and prod. Order does not matter for the existing
-- features: until this is applied, only "Generate music" fails (23514 on insert), and that path
-- refunds the held credits.

-- media_type: + 'audio'
ALTER TABLE media_generation_jobs DROP CONSTRAINT IF EXISTS media_generation_jobs_media_type_check;
ALTER TABLE media_generation_jobs ADD  CONSTRAINT media_generation_jobs_media_type_check
  CHECK (media_type IN ('image', 'video', 'audio'));

-- aspect_ratio is NOT NULL and means nothing for sound: + 'none'
ALTER TABLE media_generation_jobs DROP CONSTRAINT IF EXISTS media_generation_jobs_aspect_check;
ALTER TABLE media_generation_jobs ADD  CONSTRAINT media_generation_jobs_aspect_check
  CHECK (aspect_ratio IN ('1:1', '16:9', '9:16', '4:5', 'none'));

-- ledger: + 'music_generation' (full list as of db/x-credit-packs.sql)
ALTER TABLE ai_credit_ledger DROP CONSTRAINT IF EXISTS ai_credit_ledger_reason_check;
ALTER TABLE ai_credit_ledger ADD  CONSTRAINT ai_credit_ledger_reason_check CHECK (reason IN (
  'monthly_grant', 'image_generation', 'video_generation', 'admin_adjustment',
  'x_post_text', 'x_post_link', 'x_credit_purchase',
  'music_generation'
));
