-- US-COMMS-2: Admin-editable IN-APP notification templates + email plain-text part.
-- Idempotent — safe to run more than once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const notificationTemplates).
--
-- No RLS: PLATFORM-GLOBAL table (no organisation_id), read/written only by the
-- super-admin-gated admin-notification-templates function and the notify() render helper,
-- both via getDb() (the neondb_owner connection). Never queried through withTenant().
--
-- No seed required: src/utils/notification-templates-catalog.ts (NOTIFICATION_DEFAULTS) is
-- the default set AND the render-time fallback. A key with no row here renders from the
-- catalog; the admin UI lists the catalog and inserts a row on first edit. This mirrors
-- email_templates exactly (db/email-templates.sql).

-- ── In-app notification templates ────────────────────────────────────────────
-- NOTE: keyed on template_key, NOT on notifications.type. `type` is deliberately NOT
-- unique per message — 'system' alone backs 10 distinct notifications, 'billing' 4 — and
-- it drives category/priority routing (src/utils/notification-actions.ts). template_key is
-- a separate, stable, code-owned identifier for one piece of copy. The type each template
-- stamps onto the row lives in the catalog, not here, so routing stays code-owned.
CREATE TABLE IF NOT EXISTS notification_templates (
    id                   serial PRIMARY KEY,
    template_key         text NOT NULL UNIQUE,        -- stable code-owned copy id (never renamed)
    title                text NOT NULL,               -- supports {{merge}} tags
    message              text,                        -- supports {{merge}} tags + inline HTML
    is_active            boolean NOT NULL DEFAULT true,
    updated_by_admin_id  integer REFERENCES users(id) ON DELETE SET NULL,
    created_at           timestamp NOT NULL DEFAULT now(),
    updated_at           timestamp NOT NULL DEFAULT now()
);

-- ── Email plain-text part (AC3: Plain Text / HTML formats) ───────────────────
-- NULL means "derive from body_html at send time" (htmlToPlainText). A non-NULL value is
-- an admin-authored override and wins. Kept nullable so the ~40 catalog templates don't
-- need a hand-written text part each.
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS body_text text;
