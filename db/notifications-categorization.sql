-- Dynamic Communications Engine — Intelligent Notification Routing & Categorization (Phase 1).
-- Adds the category model to the notifications table:
--   category       text  — one of the five strict values (CHECK-enforced)        [AC1.1]
--   priority       int   — hidden sort weight derived from category               [AC2.1]
--   is_dismissible bool  — only critical_action is locked (false)                 [AC3.1/3.2]
--   resolved_at    ts    — true "closed" signal, distinct from is_read ("seen")   [AC2.3]
--
-- The canonical type→category map lives in src/utils/notification-actions.ts; this file
-- mirrors it so the DB can (a) backfill existing rows and (b) stamp the columns on INSERT
-- via a trigger, covering all ~50 code insert sites without editing each one.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can propose
-- DISABLE ROW LEVEL SECURITY / DROP POLICY. These plain ALTERs cannot touch RLS; new columns
-- inherit the table's grants + row policies automatically. Idempotent — safe to re-run.

-- 1. Columns ------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category       text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority       integer;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_dismissible boolean;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at    timestamp;

-- 2. CHECK constraint: category must be one of the five strict values (or NULL pre-backfill).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_category_check') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
      CHECK (category IS NULL OR category IN
        ('critical_action','suggested_action','state_change','informational','celebratory'));
  END IF;
END $$;

-- 3. type → category mapping (mirror of TYPE_CATEGORY in notification-actions.ts).
CREATE OR REPLACE FUNCTION notification_category_for_type(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    -- critical_action
    WHEN 'billing_payment_failed' THEN 'critical_action'
    WHEN 'missing_stripe_sub' THEN 'critical_action'
    WHEN 'stripe_cancelled_but_db_active' THEN 'critical_action'
    WHEN 'subscription_paused' THEN 'critical_action'
    WHEN 'assistants_paused_downgrade' THEN 'critical_action'
    WHEN 'trial_expired' THEN 'critical_action'
    WHEN 'tier_mismatch' THEN 'critical_action'
    WHEN 'run_budget_suspended' THEN 'critical_action'
    WHEN 'task_limit_reached' THEN 'critical_action'
    WHEN 'billing_cancelled' THEN 'critical_action'
    WHEN 'security' THEN 'critical_action'
    WHEN 'agent_anomaly' THEN 'critical_action'
    WHEN 'goal_data_disconnected' THEN 'critical_action'  -- SMART Goals AC4.3.3
    -- suggested_action
    WHEN 'onboarding_prompt' THEN 'suggested_action'
    WHEN 'onboarding_incomplete' THEN 'suggested_action'
    WHEN 'hitl_approval_required' THEN 'suggested_action'
    WHEN 'review_red_urgency' THEN 'suggested_action'
    WHEN 'trial_expiring_soon' THEN 'suggested_action'
    WHEN 'task_limit_warning' THEN 'suggested_action'
    WHEN 'run_cost_warning' THEN 'suggested_action'
    WHEN 'social_oauth_revoked' THEN 'suggested_action'
    WHEN 'instagram_token_refresh_failed' THEN 'suggested_action'
    WHEN 'instagram_rate_limited' THEN 'suggested_action'
    WHEN 'integration_alert' THEN 'suggested_action'
    WHEN 'post_publish_failed' THEN 'suggested_action'
    WHEN 'post_missed' THEN 'suggested_action'
    WHEN 'post_generation_failed' THEN 'suggested_action'
    WHEN 'risk_assessment_submitted' THEN 'suggested_action'
    WHEN 'billing_renewal_due' THEN 'suggested_action'
    WHEN 'billing_alert' THEN 'suggested_action'
    WHEN 'action_rejected' THEN 'suggested_action'
    WHEN 'action_expired' THEN 'suggested_action'
    -- state_change
    WHEN 'goal_autonomous_adjustment' THEN 'state_change'  -- SMART Goals AC3.3.3
    WHEN 'billing_renewed' THEN 'state_change'
    WHEN 'billing_payment_received' THEN 'state_change'
    WHEN 'payment_confirmation' THEN 'state_change'
    WHEN 'plan_upgraded' THEN 'state_change'
    WHEN 'downgrade_scheduled' THEN 'state_change'
    WHEN 'downgrade_cancelled' THEN 'state_change'
    WHEN 'instagram_connected' THEN 'state_change'
    WHEN 'linkedin_connected' THEN 'state_change'
    WHEN 'x_connected' THEN 'state_change'
    WHEN 'post_published' THEN 'state_change'
    WHEN 'post_revised' THEN 'state_change'
    WHEN 'post_draft_ready' THEN 'state_change'
    WHEN 'post_generation_queued' THEN 'state_change'
    WHEN 'provisioning_complete' THEN 'state_change'
    WHEN 'profile_sync_complete' THEN 'state_change'
    WHEN 'draft_horizon_expanded' THEN 'state_change'
    WHEN 'draft_horizon_shrunk' THEN 'state_change'
    WHEN 'org_invite_accepted' THEN 'state_change'
    WHEN 'org_joined' THEN 'state_change'
    WHEN 'risk_assessment_decision' THEN 'state_change'
    WHEN 'risk_reclassification' THEN 'state_change'
    WHEN 'account_update' THEN 'state_change'
    WHEN 'assistant_task' THEN 'state_change'
    WHEN 'assistant_ready' THEN 'state_change'
    -- celebratory
    WHEN 'setup_complete' THEN 'celebratory'
    WHEN 'milestone_unlock' THEN 'celebratory'
    WHEN 'referral_reward' THEN 'celebratory'
    -- informational (explicit + default)
    ELSE 'informational'
  END;
$$;

-- 4. category → priority (AC2.1) and → is_dismissible (AC3.2).
CREATE OR REPLACE FUNCTION notification_priority_for_category(p_category text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_category
    WHEN 'critical_action' THEN 1
    WHEN 'suggested_action' THEN 2
    WHEN 'state_change' THEN 3
    WHEN 'celebratory' THEN 3
    ELSE 4
  END;
$$;

-- 5. BEFORE INSERT trigger: stamp category/priority/is_dismissible from type when not
--    explicitly provided. Covers every insert site automatically.
CREATE OR REPLACE FUNCTION notifications_stamp_category()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category IS NULL THEN
    NEW.category := notification_category_for_type(NEW.type);
  END IF;
  IF NEW.priority IS NULL THEN
    NEW.priority := notification_priority_for_category(NEW.category);
  END IF;
  IF NEW.is_dismissible IS NULL THEN
    NEW.is_dismissible := (NEW.category <> 'critical_action');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notifications_stamp_category ON notifications;
CREATE TRIGGER trg_notifications_stamp_category
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_stamp_category();

-- 6. Backfill existing rows (only those not yet categorized).
UPDATE notifications
SET category       = notification_category_for_type(type),
    priority       = notification_priority_for_category(notification_category_for_type(type)),
    is_dismissible = (notification_category_for_type(type) <> 'critical_action')
WHERE category IS NULL;
