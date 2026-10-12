-- db/z-plan-tool-vault-withdrawn.sql
-- 2026-10-12: withdraw "Advanced Tool Vault" from the pricing comparison table.
-- It promised "premium and specialist third-party integrations beyond the standard set", but no
-- integration has ever been marked premium, so The Digital Employee was sold a row that did nothing.
-- The features jsonb key stays (harmless, and keeps old plan snapshots readable). Idempotent.

UPDATE plan_features
SET is_enabled = false, updated_at = now()
WHERE key = 'advanced_tool_vault' AND is_enabled = true;
