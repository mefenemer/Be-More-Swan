// netlify/functions/cascade-preview.ts
// US-ADM-1.6.1: Compute the cascade impact of deleting a record before any data is modified.
// SuperAdmin only.
//
// GET /.netlify/functions/cascade-preview?table=users&id=42
//   Auth: aura_session cookie with adminRole = 'super_admin'
//
// Returns:
//   { tier, blocked, blockedReason?, cascadeGroups[], blockingDependencies[] }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { eq } from 'drizzle-orm';
import {
    TABLE_DELETE_CONFIG,
    CASCADE_RELATIONSHIPS,
    BLOCKING_DEPENDENCY_TABLES,
} from '../../src/utils/delete-tiers';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

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

interface CascadeGroup {
    table: string;
    behavior: string;
    count: number;
    deleteType: 'hard_deleted' | 'soft_deleted' | 'nullified';
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const auth = getAdminId(event);
    if (!auth || auth.role !== 'super_admin') {
        return { statusCode: 403, body: JSON.stringify({ error: 'SuperAdmin access required.' }) };
    }

    const params = event.queryStringParameters || {};
    const table  = params.table?.trim();
    const id     = params.id ? Number(params.id) : NaN;

    if (!table || isNaN(id)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'table and id are required.' }) };
    }

    const config = TABLE_DELETE_CONFIG[table];
    if (!config) {
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown table: ${table}` }) };
    }

    // ── Blocked check ─────────────────────────────────────────────────────────
    if (config.tier === 'blocked') {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                table,
                id,
                tier: 'blocked',
                blocked: true,
                blockedReason: config.blockedReason,
                cascadeGroups: [],
                blockingDependencies: [],
            }),
        };
    }

    // ── Active-plan guard for plans table ─────────────────────────────────────
    if (table === 'plans') {
        const db = getDb();
        const [row] = await db.execute(sql`SELECT status FROM plans WHERE id = ${id} LIMIT 1`);
        const status = (row as any)?.status;
        if (status === 'active' || status === 'past_due') {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    table,
                    id,
                    tier: 'blocked',
                    blocked: true,
                    blockedReason: `Cannot delete: plan status is '${status}'. Cancel the subscription before deleting.`,
                    cascadeGroups: [],
                    blockingDependencies: [],
                }),
            };
        }
    }

    const db = getDb();

    // ── Blocking dependency check (e.g. masterAssistant with active ai_assistants) ──
    const blockingDependencies: { table: string; count: number; reason: string }[] = [];
    for (const [childTable, dep] of Object.entries(BLOCKING_DEPENDENCY_TABLES)) {
        if (dep.parentTable !== table) continue;
        const result = await db.execute(
            sql`SELECT COUNT(*) AS cnt FROM ${sql.identifier(childTable)} WHERE ${sql.identifier(dep.fkColumn)} = ${id} AND (is_active IS NULL OR is_active = true)`
        );
        const cnt = Number((result[0] as any)?.cnt ?? 0);
        if (cnt > 0) {
            blockingDependencies.push({ table: childTable, count: cnt, reason: dep.reason });
        }
    }

    // ── Cascade impact computation ────────────────────────────────────────────
    const relevantRelations = CASCADE_RELATIONSHIPS.filter(r => r.parentTable === table);
    const cascadeGroups: CascadeGroup[] = [];

    for (const rel of relevantRelations) {
        try {
            const result = await db.execute(
                sql`SELECT COUNT(*) AS cnt FROM ${sql.identifier(rel.childTable)} WHERE ${sql.identifier(rel.fkColumn)} = ${id}`
            );
            const cnt = Number((result[0] as any)?.cnt ?? 0);
            if (cnt === 0) continue;

            const childConfig = TABLE_DELETE_CONFIG[rel.childTable];
            const deleteType: CascadeGroup['deleteType'] =
                rel.behavior === 'set_null'     ? 'nullified'    :
                rel.behavior === 'soft_delete'  ? 'soft_deleted' : 'hard_deleted';

            cascadeGroups.push({
                table:      rel.childTable,
                behavior:   rel.behavior,
                count:      cnt,
                deleteType,
            });
        } catch {
            // If table doesn't exist in this environment, skip silently
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            table,
            id,
            tier: config.tier,
            blocked: blockingDependencies.length > 0,
            blockingDependencies,
            cascadeGroups,
        }),
    };
});
