-- US-COMMS-1: Admin-editable transactional email templates.
-- One row per system trigger, holding the admin-edited subject + inner body. The brand
-- shell lives in code (renderMasterTemplate). Idempotent — safe to run more than once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const emailTemplates).
--
-- No RLS: this is a PLATFORM-GLOBAL table (no organisation_id). It is read/written only by
-- admin-gated functions via getDb() (the neondb_owner connection). It is never queried via
-- withTenant(), so a tenant_isolation policy would not apply.
--
-- No seed required: src/utils/email-templates-catalog.ts (TEMPLATE_DEFAULTS) is the default
-- set AND the send-time fallback. A trigger with no row here renders from the catalog; the
-- admin "Manage Emails" UI lists the catalog and inserts a row on first edit.

CREATE TABLE IF NOT EXISTS email_templates (
    id                   serial PRIMARY KEY,
    trigger_key          text NOT NULL UNIQUE,        -- stable code-owned event id (never renamed)
    name                 text NOT NULL,
    category             text NOT NULL DEFAULT 'General',
    subject              text NOT NULL,               -- supports {{merge}} tags
    body_html            text NOT NULL,               -- inner body only — wrapped at send time
    preheader            text,
    is_active            boolean NOT NULL DEFAULT true,
    locked               boolean NOT NULL DEFAULT false,  -- critical triggers can't be deactivated
    transactional        boolean NOT NULL DEFAULT false,  -- omit unsubscribe link
    updated_by_admin_id  integer REFERENCES users(id) ON DELETE SET NULL,
    created_at           timestamp NOT NULL DEFAULT now(),
    updated_at           timestamp NOT NULL DEFAULT now()
);
