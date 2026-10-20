// src/utils/delete-tiers.ts
// US-ADM-1.6.1: Delete tier classification and cascade rules.
// Shared between cascade-preview.ts and admin-delete-record.ts.

export type DeleteTier = 'soft' | 'hard' | 'hard_confirmed' | 'blocked';

export interface TableDeleteConfig {
    tier: DeleteTier;
    blockedReason?: string; // only when tier === 'blocked'
    softField?: 'deletedAt' | 'isActive'; // which field to set for soft deletes
}

/** Tier rules per table name */
export const TABLE_DELETE_CONFIG: Record<string, TableDeleteConfig> = {
    // ── Soft-delete (default for user-facing entities) ───────────────────────
    // ⚠️ softField must be a column the table really has — the delete runs `UPDATE … SET is_active /
    // deleted_at`, and a missing column is a 500 after the audit row is written. Pinned against
    // db/schema.ts by tests/admin-cascade-deletes.test.ts.
    // users: kept here only so cascade-preview can count dependents. admin-delete-record refuses users;
    // the sheet deletes them via admin-api DELETE ?resource=user (deleteUserAndSoleOrgs).
    users:             { tier: 'soft', softField: 'isActive' },
    ai_assistants:     { tier: 'soft', softField: 'isActive' },
    master_assistants: { tier: 'soft', softField: 'isActive' },
    workspace_assets:  { tier: 'soft', softField: 'isActive' },

    // ── Hard-delete (operational/transient data) ─────────────────────────────
    rate_limit_attempts:   { tier: 'hard' },
    jwt_blocklist:         { tier: 'hard' },
    notifications:         { tier: 'hard' }, // older than 90d
    integration_api_calls: { tier: 'hard' }, // older than 90d

    // ── Hard-delete with explicit SuperAdmin confirmation ────────────────────
    system_connections:    { tier: 'hard_confirmed' },
    vault_secrets:         { tier: 'hard_confirmed' },
    user_organisations:    { tier: 'hard_confirmed' },
    scheduled_posts:       { tier: 'hard_confirmed' }, // Draft state only

    // ── Blocked — cannot be deleted via UI under any circumstance ────────────
    // organisations / content_assets were 'soft' on an is_active column neither table has (2026-10-20).
    organisations: {
        tier: 'blocked',
        blockedReason: "A workspace is removed with its last member: use Delete Account on the owner's user panel. That keeps a workspace with a live Stripe subscription instead of stranding it.",
    },
    content_assets: {
        tier: 'blocked',
        blockedReason: "Deleting the row would leave the stored file behind. Remove it from the workspace's My Content, which deletes both.",
    },
    // A plan row is what subscribers' plans.master_plan_id and the free beta plan's features
    // (featureTierKey: beta → 'employee') resolve through. Deleting one strands everyone on it, so
    // a plan is retired by making it inactive (off the pricing page, checkout and picker). Before
    // this entry the screen said "Unknown table: master_plans" (2026-10-19).
    master_plans: {
        tier: 'blocked',
        blockedReason: "Plans can't be deleted, only made inactive. Edit the plan and untick Active to stop selling it; anyone already on it keeps it.",
    },
    admin_audit_log: {
        tier: 'blocked',
        blockedReason: 'Immutable audit record — cannot be deleted',
    },
    audit_logs: {
        tier: 'blocked',
        blockedReason: 'Immutable audit record — cannot be deleted',
    },
    dpa_acceptances: {
        tier: 'blocked',
        blockedReason: 'Retained: Article 28(9) GDPR legal admissibility requirement',
    },
    gdpr_erasure_log: {
        tier: 'blocked',
        blockedReason: 'Retained: GDPR erasure evidence log — cannot be deleted',
    },
    billing_reconciliation_log: {
        tier: 'blocked',
        blockedReason: 'Retained: HMRC 7-year billing record requirement',
    },
    invoices: {
        tier: 'blocked',
        blockedReason: 'Retained: HMRC 7-year billing record requirement',
    },
    payments: {
        tier: 'blocked',
        blockedReason: 'Retained: HMRC 7-year billing record requirement',
    },
    plans: {
        tier: 'blocked',
        blockedReason: 'Cannot delete: check plan status — active/past_due plans cannot be removed',
    },
    tos_acceptances: {
        tier: 'blocked',
        blockedReason: 'Retained: ToS consent evidence — cannot be deleted',
    },
};

/** Tables that block deletion of their parent when active records exist */
export const BLOCKING_DEPENDENCY_TABLES: Record<string, { parentTable: string; fkColumn: string; reason: string }> = {
    ai_assistants: {
        parentTable: 'master_assistants',
        fkColumn: 'master_assistant_id',
        reason: 'active workspace(s) depend on this record',
    },
    plans: {
        parentTable: 'master_plans',
        fkColumn: 'master_plan_id',
        reason: 'active subscription(s) depend on this record',
    },
};

/** Known cascade relationships: child_table → { fkColumn, behavior } */
export const CASCADE_RELATIONSHIPS: Array<{
    childTable: string;
    fkColumn: string;
    parentTable: string;
    behavior: 'cascade_delete' | 'set_null' | 'soft_delete';
}> = [
    { childTable: 'ai_assistants',     fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'task_runs',         fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'system_connections',fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'workspace_assets',  fkColumn: 'uploader_id',     parentTable: 'users',         behavior: 'set_null' },
    { childTable: 'scheduled_posts',   fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'notifications',     fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'plans',             fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'support_tickets',   fkColumn: 'user_id',         parentTable: 'users',         behavior: 'cascade_delete' },
    { childTable: 'agent_run_events',  fkColumn: 'assistant_id',    parentTable: 'ai_assistants', behavior: 'set_null' },
    { childTable: 'task_runs',         fkColumn: 'assistant_id',    parentTable: 'ai_assistants', behavior: 'set_null' },
];
