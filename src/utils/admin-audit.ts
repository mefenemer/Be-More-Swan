/**
 * src/utils/admin-audit.ts
 *
 * US-ADM-5.1.1: Append-Only Admin Action Audit Log
 *
 * Utility for inserting rows into admin_audit_log.
 * This is the ONLY way admin audit rows should be written — never update or delete.
 */

import { getDb } from '../../db/client';
import { adminAuditLog } from '../../db/schema';
import { pseudonymiseIp } from './ip-pseudonymise';
import { runWithEnvironment } from './env-context';

export type AdminAction =
    | 'impersonate_start'
    | 'impersonate_end'
    | 'password_reset'
    | 'account_lock'
    | 'account_unlock'
    | 'email_change'
    | 'tier_change'
    | 'comp_credit'
    | 'refund_issued'
    | 'kill_switch_toggle'
    | 'gamification_config_update'
    | 'feature_flag_toggle'
    | 'gdpr_erasure'
    | 'admin_role_change'
    | 'dunning_override'
    | 'trial_extension'
    | 'account_delete'
    | 'sar_export'
    | 'security_incident_detected'
    | 'emergency_token_revocation'
    | 'regulator_notification_submitted'
    | 'assistant_state_change'
    | 'record_delete'
    | 'retry_failed_post'
    | 'sandbox_purge'
    | 'sandbox_seed'
    | 'email_template_edit';

export interface AdminAuditParams {
    adminId: number;
    action: AdminAction;
    targetType?: string;
    targetId?: string | number;
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Write one row to admin_audit_log.
 * Non-blocking — errors are logged but never thrown to the caller.
 */
export async function insertAdminAuditLog(params: AdminAuditParams): Promise<void> {
    try {
        // Admin audit is a compliance record of what the admin DID — it must always
        // land in the live database, even when the admin was operating in sandbox
        // mode (env-context.ts). Force the live connection regardless of the active
        // request environment.
        const db = await runWithEnvironment('live', async () => getDb());
        await db.insert(adminAuditLog).values({
            adminId:       params.adminId,
            action:        params.action,
            targetType:    params.targetType ?? null,
            targetId:      params.targetId != null ? String(params.targetId) : null,
            previousState: params.previousState ?? null,
            newState:      params.newState ?? null,
            ipAddress:     pseudonymiseIp(params.ipAddress) ?? null,
            userAgent:     params.userAgent ?? null,
            reason:        params.reason ?? null,
            metadata:      params.metadata ?? null,
        });
    } catch (err) {
        console.error('[admin-audit] Failed to write audit log row:', err);
        // Never re-throw — audit failure must not block the primary action
    }
}

/**
 * Extract IP address from Netlify event headers.
 */
export function getAdminIp(headers: Record<string, string | undefined>): string | undefined {
    return headers['x-forwarded-for']?.split(',')[0]?.trim()
        || headers['x-real-ip']
        || undefined;
}
