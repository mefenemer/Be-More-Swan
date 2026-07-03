// netlify/functions/admin-delete-record.ts
// US-ADM-1.6.1: Safe record deletion with pre-delete audit log, cascade preview enforcement,
// and bulk hard-delete support.
// SuperAdmin only.
//
// DELETE /.netlify/functions/admin-delete-record
//   Auth: aura_session cookie with adminRole = 'super_admin'
//   Body: {
//     table: string,
//     id?: number,          // single record
//     ids?: number[],       // bulk — same table only; hard/hard_confirmed tier only
//     reason: string,       // required free-text
//     confirmPhrase?: string, // 'DELETE' — required for bulk hard-delete >100 rows
//     previewAcknowledged: boolean, // must be true (caller showed the cascade preview)
//   }

import { Handler } from '@netlify/functions';
import { sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { TABLE_DELETE_CONFIG, BLOCKING_DEPENDENCY_TABLES } from '../../src/utils/delete-tiers';
import { insertAdminAuditLog } from '../../src/utils/admin-audit';
import { checkImpersonationBlock } from '../../src/utils/impersonation';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const BULK_CONFIRM_THRESHOLD = 100;

function getAdminId(event: any): { adminId: number; role: string } | null {
    try {
        const cookie = event.headers.cookie || '';
        const match  = cookie.match(/aura_session=([^;]+)/);
        if (!match) return null;
        const payload: any = jwt.verify(match[1], JWT_SECRET);
        if (!payload.userId) return null;
        return { adminId: payload.userId, role: payload.adminRole ?? '' };
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    if (event.httpMethod !== 'DELETE') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const impersonationBlock = checkImpersonationBlock(event.headers.cookie, 'record_delete');
    if (impersonationBlock) return impersonationBlock;

    const auth = getAdminId(event);
    if (!auth || auth.role !== 'super_admin') {
        return { statusCode: 403, body: JSON.stringify({ error: 'SuperAdmin access required.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { table, id, ids, reason, confirmPhrase, previewAcknowledged } = body;

    if (!table || !reason?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'table and reason are required.' }) };
    }
    if (!previewAcknowledged) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cascade preview must be acknowledged before deleting.' }) };
    }

    const config = TABLE_DELETE_CONFIG[table];
    if (!config) {
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown table: ${table}` }) };
    }
    if (config.tier === 'blocked') {
        return { statusCode: 403, body: JSON.stringify({ error: config.blockedReason ?? 'This record cannot be deleted.' }) };
    }

    // Resolve target IDs
    const targetIds: number[] = ids?.length
        ? ids.map(Number).filter((n: number) => !isNaN(n))
        : id ? [Number(id)] : [];

    if (!targetIds.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id or ids is required.' }) };
    }

    const isBulk = targetIds.length > 1;

    // Bulk hard-delete >100 rows requires typed 'DELETE' confirmation
    if (isBulk && targetIds.length > BULK_CONFIRM_THRESHOLD && config.tier !== 'soft') {
        if (confirmPhrase !== 'DELETE') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Deleting ${targetIds.length} rows requires confirmPhrase: 'DELETE'.`,
                    requiresConfirmPhrase: true,
                    count: targetIds.length,
                }),
            };
        }
    }

    // Bulk is only allowed for hard/hard_confirmed tiers — not soft (ambiguous cascade)
    if (isBulk && config.tier === 'soft') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Bulk delete is not supported for soft-delete tables.' }) };
    }

    const db  = getDb();
    const now = new Date();

    // ── Blocking dependency check (single record only) ───────────────────────
    if (!isBulk) {
        for (const [childTable, dep] of Object.entries(BLOCKING_DEPENDENCY_TABLES)) {
            if (dep.parentTable !== table) continue;
            const result = await db.execute(
                sql`SELECT COUNT(*) AS cnt FROM ${sql.identifier(childTable)} WHERE ${sql.identifier(dep.fkColumn)} = ${targetIds[0]} AND (is_active IS NULL OR is_active = true)`
            );
            const cnt = Number((result[0] as any)?.cnt ?? 0);
            if (cnt > 0) {
                return {
                    statusCode: 409,
                    body: JSON.stringify({
                        error: `Cannot delete: ${cnt} ${dep.reason}. Deactivate or migrate all dependent records first.`,
                        blockingTable: childTable,
                        count: cnt,
                    }),
                };
            }
        }
    }

    // ── Write audit log BEFORE delete (AC requirement) ───────────────────────
    const auditLogId = `${table}:${targetIds.join(',')}`;
    const cascadeSummary: Record<string, number> = {}; // populated best-effort

    try {
        await insertAdminAuditLog({
            adminId:    auth.adminId,
            action:     'record_delete',
            targetType: table,
            targetId:   targetIds.length === 1 ? targetIds[0] : undefined,
            reason:     reason.trim(),
            metadata: {
                ids:            targetIds,
                deleteType:     config.tier,
                isBulk,
                initiatedAt:    now.toISOString(),
                cascadeSummary, // will be empty at write time; that's OK — AC says write before, not after
            },
        });
    } catch (auditErr) {
        // If audit log write fails, do NOT proceed with delete
        console.error('[admin-delete-record] Audit log write failed — aborting delete:', auditErr);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to write audit log. Delete aborted.' }) };
    }

    // ── Execute the delete ────────────────────────────────────────────────────
    let deletedCount = 0;
    let failureReason: string | null = null;

    try {
        // Bind ids as parameters; the table name is a validated whitelist key quoted via sql.identifier.
        const idValues = sql.join(targetIds.map((n) => sql`${n}`), sql`, `);
        const tableId = sql.identifier(table);

        if (config.tier === 'soft') {
            // Soft-delete: set isActive = false or deletedAt
            if (config.softField === 'isActive') {
                await db.execute(sql`UPDATE ${tableId} SET is_active = false, updated_at = now() WHERE id IN (${idValues})`);
            } else {
                await db.execute(sql`UPDATE ${tableId} SET deleted_at = now(), updated_at = now() WHERE id IN (${idValues})`);
            }
            deletedCount = targetIds.length;
        } else {
            // Hard-delete or hard_confirmed
            const result = await db.execute(sql`DELETE FROM ${tableId} WHERE id IN (${idValues}) RETURNING id`);
            deletedCount = result.length ?? targetIds.length;
        }
    } catch (deleteErr: any) {
        failureReason = deleteErr?.message ?? 'Unknown error';
        console.error('[admin-delete-record] Delete failed:', deleteErr);

        // Update the audit log entry with failure reason (best-effort)
        await insertAdminAuditLog({
            adminId:    auth.adminId,
            action:     'record_delete',
            targetType: table,
            reason:     `FAILED: ${failureReason}`,
            metadata:   { ids: targetIds, deleteType: config.tier, failureReason },
        }).catch(() => {});

        return { statusCode: 500, body: JSON.stringify({ error: `Delete failed: ${failureReason}` }) };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deleted:      true,
            table,
            ids:          targetIds,
            deletedCount,
            deleteType:   config.tier,
            confirmation: `Deleted ${table} #${targetIds.join(', ')}. ${deletedCount} record(s) affected. Logged to audit trail.`,
        }),
    };
};
