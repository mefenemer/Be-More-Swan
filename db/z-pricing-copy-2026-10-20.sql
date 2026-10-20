-- db/z-pricing-copy-2026-10-20.sql — the pricing page's "Compare every feature" table and the
-- Workflow Saver card, checked against the product (owner review, 2026-10-20).
--
--   • "Digital Assistants: 1" read as "one role, ever". Any assistant can be hired; on the Workflow
--     Saver one works at a time and can be switched once a calendar month (assistant-capacity.ts
--     checkRoleSwap). Relabelled; the Busywork Buster's NULL still renders "All" (pricing.html).
--   • Tasks: "each action counts as one task" — a task is one finished piece of work, and AI video
--     and music count as 20 (src/config/task-weights.ts).
--   • AI images / video still quoted "1 credit" / "5 credits". Credits ended 17 October 2026:
--     1 task / 20 tasks.
--   • Draft Approvals said outputs land "in your inbox"; they wait in Review, by default.
--   • The Quality Reviewer is a check on social drafts, not "a dedicated assistant".
--   • Brand Protection repeated the Safe Content Benchmark row word for word in meaning — row off.
--   • NEW row: Website Pages (5 / 15), a real plan difference the table never showed. The values
--     already live in master_plans.features.website_pages.
--   • Workflow Saver card description, 140 characters to match the Busywork Buster's, so the cards
--     line up.
-- Safe to re-run. Every statement RETURNs, so the Neon SQL editor shows what it changed.

BEGIN;

UPDATE plan_features SET label = 'Assistants Working at Once',
       description = 'Hire any assistant in the library. On the Workflow Saver one works at a time, and you can switch it once a calendar month',
       updated_at = now()
 WHERE key = 'assistant_limit' RETURNING key, label;

UPDATE plan_features SET description = 'One finished piece of work: a post, an article, a lead search or an email. AI video and music count as 20',
       updated_at = now()
 WHERE key = 'monthly_task_limit' RETURNING key, description;

UPDATE plan_features SET description = 'Generate on-brand images from a prompt — 1 task each', updated_at = now()
 WHERE key = 'ai_image_generation' RETURNING key, description;

UPDATE plan_features SET description = 'Generate short-form videos from a prompt — 20 tasks each', updated_at = now()
 WHERE key = 'ai_video_generation' RETURNING key, description;

UPDATE plan_features SET description = 'Every post, article and email waits for your sign-off before it''s published or sent, unless you choose otherwise',
       updated_at = now()
 WHERE key = 'draft_approvals' RETURNING key, description;

UPDATE plan_features SET description = 'A second check on every social post before it reaches you: it flags anything off-brand or shaky and suggests a fix',
       updated_at = now()
 WHERE key = 'quality_reviewer' RETURNING key, description;

UPDATE plan_features SET is_enabled = FALSE, updated_at = now()
 WHERE key = 'brand_protection' RETURNING key, is_enabled;

INSERT INTO plan_features (key, label, description, category, value_type, storage_target, unlimited_label, enterprise_value, display_order, is_enabled)
VALUES ('website_pages', 'Website Pages', 'Pages on the website your Website Assistant writes and publishes for you',
        'Capacity', 'number', 'feature', 'Custom', 'Custom', 2, TRUE)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, category = EXCLUDED.category,
       value_type = EXCLUDED.value_type, storage_target = EXCLUDED.storage_target, enterprise_value = EXCLUDED.enterprise_value,
       display_order = EXCLUDED.display_order, is_enabled = TRUE, updated_at = now()
RETURNING key, label, display_order;

UPDATE master_plans
   SET description = 'One assistant on the job you most want off your plate each day: social media, blog, email or leads. Switch to another once a calendar month.'
 WHERE tier_key = 'saver'
RETURNING tier_key, length(description) AS characters;

COMMIT;
