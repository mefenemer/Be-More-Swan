-- Phase 1 External Integrations: workspace_integrations
-- One row per (organisation, provider) OAuth grant for HubSpot / Xero / Slack.
-- Token material is NOT stored here — it lives AES-256-GCM encrypted in vault_secrets
-- under vault_ref_key ('aura/org-<orgId>/integration-<provider>'), per US-DB-1.6.1.
-- Apply manually (no drizzle-kit push), matching db/schema.ts::workspaceIntegrations.

CREATE TABLE IF NOT EXISTS workspace_integrations (
    id                    serial PRIMARY KEY,
    organisation_id       integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    provider              text NOT NULL,              -- 'hubspot' | 'xero' | 'slack'
    vault_ref_key         text NOT NULL,              -- vault_secrets.ref_key holding { accessToken, refreshToken }
    tenant_id             text,                       -- Xero tenant id; Slack team id; HubSpot hub id
    external_account_name text,                       -- Xero org name / Slack workspace / HubSpot domain
    scopes                text,
    status                text NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'revoked' | 'error'
    connected_by          integer REFERENCES users(id) ON DELETE SET NULL,
    expires_at            timestamp,                  -- access-token expiry; NULL = non-expiring (Slack bot tokens)
    created_at            timestamp NOT NULL DEFAULT now(),
    updated_at            timestamp NOT NULL DEFAULT now()
);

-- Unique compound constraint: one connection per provider per workspace.
-- Guarded so a re-run is a no-op (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_integrations_org_provider_unique'
    ) THEN
        ALTER TABLE workspace_integrations
            ADD CONSTRAINT workspace_integrations_org_provider_unique
            UNIQUE (organisation_id, provider);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_integrations_org_idx
    ON workspace_integrations (organisation_id);
