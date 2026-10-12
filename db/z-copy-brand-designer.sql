-- db/z-copy-brand-designer.sql — Brand Designer catalogue copy, rewritten in plain words (2026-10-11).
--
-- Named "z-copy-…" so it sorts AFTER db/z-brand-designer.sql (which inserts the row) and
-- db/z-campaign-visuals.sql (which rewrites works_with) — the runner sorts "-" before ".", so a
-- "z-brand-designer-copy" name would run BEFORE the insert on a fresh database and do nothing.
--
-- Why: the old copy said "pictures" for a role that also finds and makes VIDEOS, and two of its key
-- features ("Briefs, Not Prompts", "Stock, AI and Branded Cards Side by Side") described how it is
-- built rather than what a customer gets. "Connects with" read "Design" (a category, not a tool)
-- where the one external tool it uses is Canva, and Works With dropped "Standalone" when the
-- Campaign Assistant was added — it is still hireable and useful on its own.
--
-- ⚠️ Overwrites any edit made in Admin ▸ Master Data ▸ Assistants for this one role, on purpose.
-- Mirrored in db/seed-assistant-content.ts so a fresh seed writes the same copy.
-- Apply (staging first): node scripts/db-migrate.mjs apply --only z-copy-brand-designer --execute --yes

BEGIN;

UPDATE master_assistants SET
    tagline      = 'Tell it what you need a picture or video for. Pick the one you like.',
    description  = 'Tell it what a picture or video is for. It finds stock photos and videos, makes AI images and videos, and designs simple graphics in your brand colours with your logo. You pick the ones you like, and they are saved to your library for all your assistants to use.',
    key_features = '["Just Say What It''s For","Photos, Videos and Graphics to Choose From","Nothing Is Used Until You Approve It","Use Your Own Files and Canva Designs"]'::jsonb,
    integrations = '["Canva"]'::jsonb,
    works_with   = '["standalone","social_media_manager","blog_writer","campaign_orchestrator"]'::jsonb,
    updated_at   = now()
WHERE role_key = 'brand_designer';

COMMIT;
