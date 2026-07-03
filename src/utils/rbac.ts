// src/utils/rbac.ts
//
// US-ADM-5.2.1: Centralised RBAC permission matrix for admin roles.
//
// Role hierarchy (ascending privilege):
//   support_agent < billing_admin < platform_admin < super_admin
//
// Usage:
//   import { hasPermission, ADMIN_ROLES } from '../../src/utils/rbac';
//   if (!hasPermission(userRole, 'kill_switch')) return 403;

export const ADMIN_ROLES = [
    'support_agent',
    'billing_admin',
    'platform_admin',
    'super_admin',
    'admin', // legacy alias — treated as billing_admin level
] as const;

export type AdminRole = typeof ADMIN_ROLES[number];

// ── Permission definitions ─────────────────────────────────────────────────────
// Each key is a permission; value is the minimum role required.
// Roles higher in the hierarchy implicitly have all lower permissions.

const ROLE_RANK: Record<string, number> = {
    support_agent:  1,
    admin:          2, // legacy — maps to billing_admin level
    billing_admin:  2,
    platform_admin: 3,
    super_admin:    4,
};

// Minimum role rank required per permission
const PERMISSION_MIN_RANK: Record<string, number> = {
    // ── support_agent and above ───────────────────────────────────────
    view_users:             1,  // browse user list + detail
    view_billing_history:   1,  // see payments / invoices
    send_magic_link:        1,  // magic link login
    lock_account:           1,  // lock / unlock accounts
    view_tickets:           1,  // support ticket queue
    view_analytics:         1,  // basic analytics

    // ── billing_admin and above ───────────────────────────────────────
    issue_refund:           2,  // Stripe refunds (not yet built but guarded)
    override_subscription:  2,  // tier change / comp / trial extend / pause
    view_cogs:              2,  // COGS dashboard
    email_change:           2,  // admin-initiated email address change
    dunning_override:       2,  // mark payment arranged offline
    view_reconciliation:    2,  // billing reconciliation queue
    sar_export:             2,  // GDPR SAR export

    // ── platform_admin and above ──────────────────────────────────────
    kill_switch:            3,  // toggle emergency kill switches
    feature_flags:          3,  // create / edit feature flags
    assistant_catalog:      3,  // deploy / rollback assistant versions, lifecycle transitions
    platform_config:        3,  // read / write platform config
    view_audit_log:         3,  // see audit log list (diffs still super_admin only)

    // ── super_admin only ──────────────────────────────────────────────
    audit_log_diff:         4,  // raw before/after state diffs in audit log
    gdpr_erasure:           4,  // GDPR right-to-erasure
    manage_admin_roles:     4,  // promote / demote other admins
    impersonate:            4,  // impersonate any user
    run_migration_sql:      4,  // execute AI-proposed migration SQL against the DB (issue tickets)
};

/**
 * Returns true if the given role has the specified permission.
 */
export function hasPermission(role: string | null | undefined, permission: string): boolean {
    if (!role) return false;
    const roleRank = ROLE_RANK[role] ?? 0;
    const minRank  = PERMISSION_MIN_RANK[permission] ?? 99;
    return roleRank >= minRank;
}

/**
 * Returns a 403 JSON response body if the role lacks the permission.
 * Returns null if permitted.
 */
export function requirePermission(
    role: string | null | undefined,
    permission: string,
): { statusCode: number; body: string } | null {
    if (hasPermission(role, permission)) return null;
    return {
        statusCode: 403,
        body: JSON.stringify({ error: `Permission denied: requires '${permission}' privilege.` }),
    };
}

/**
 * Checks whether a role is a valid admin role (i.e. can access the admin portal at all).
 */
export function isAdminRole(role: string | null | undefined): boolean {
    return ADMIN_ROLES.includes(role as AdminRole);
}
