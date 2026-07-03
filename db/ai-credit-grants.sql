-- AI media generation — per-tier monthly credit allowances (Epic 2, US4).
--
-- Sets master_plans.features.monthly_ai_credits per tier. The credit util
-- (src/utils/ai-credits.ts) reads this value to grant each org its monthly allowance.
--
-- Allowance basis: 1 credit ≈ £0.10 of Fal.ai cost (a Flux 2 generation = 4 variations @
-- ~$0.03/MP ≈ $0.12). Numbers keep media COGS at ~10% of tier revenue. Video = 5 credits
-- (Hailuo 2.3 Pro ≈ $0.49), and video is restricted to saver/employee tiers (enforced in code).
-- Credits ROLL OVER month to month. Trial gets 0 — no AI generation on trial (upgrade to use).
--   trial 0 · buster 20 · saver 50 · employee 100.
--
-- Merges into the existing features map (|| preserves other feature flags). Idempotent:
-- safe to re-run. Apply manually as the DB owner (no drizzle-kit push). This mirrors the
-- seed SoT (seed/data/master_plans.json + db/seed-catalog.ts) for already-seeded databases.

UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_ai_credits', 0)   WHERE tier_key = 'trial';
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_ai_credits', 20)  WHERE tier_key = 'buster';
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_ai_credits', 50)  WHERE tier_key = 'saver';
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_ai_credits', 100) WHERE tier_key = 'employee';
