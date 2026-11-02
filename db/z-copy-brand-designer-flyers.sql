-- db/z-copy-brand-designer-flyers.sql — Brand Designer catalogue copy now names printable flyers (2026-11-02).
--
-- docs/brand-designer-flyers-plan.md §3.8. The Business Mentor recommends hires from this description
-- (src/utils/mentor-hire.ts) and told Love Cat Studio to use Canva for a flyer, because nothing here said
-- the Brand Designer makes one. Sorts after db/z-copy-brand-designer.sql ("-f" > "." is not relied on:
-- the runner sorts "-" before ".", and "z-copy-brand-designer-flyers" > "z-copy-brand-designer.sql").
--
-- ⚠️ PUBLIC COPY. Apply to STAGING now; apply to PROD only in the same release that ships flyers
-- (commit b4a4a38b) — never ahead of it (public-copy rule).
-- ⚠️ Overwrites any edit made in Admin ▸ Master Data ▸ Assistants for this one role, on purpose.
-- Mirrored in db/seed-assistant-content.ts so a fresh seed writes the same copy.
--   node scripts/db-migrate.mjs apply --only z-copy-brand-designer-flyers --execute --yes

BEGIN;

UPDATE master_assistants SET
    tagline      = 'Tell it what you need a picture, video or printed flyer for. Pick the one you like.',
    description  = 'Tell it what a picture or video is for. It finds stock photos and videos, makes AI images and videos, and designs simple graphics in your brand colours with your logo. It also makes printable flyers: it writes the words from your business details, lays out the pages, and saves a print-ready PDF to My Content for you to print or send to a print shop. You pick the ones you like, and they are saved to your library for all your assistants to use.',
    key_features = '["Just Say What It''s For","Photos, Videos and Graphics to Choose From","Printable Flyers, Ready to Print","Nothing Is Used Until You Approve It","Use Your Own Files and Canva Designs"]'::jsonb,
    updated_at   = now()
WHERE role_key = 'brand_designer';

COMMIT;
