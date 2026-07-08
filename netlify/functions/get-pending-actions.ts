// netlify/functions/get-pending-actions.ts
// US-GOV-2.1.1: Return pending HITL actions for the authenticated deployer.
//
// GET /.netlify/functions/get-pending-actions
//   Query: status=pending|approved|rejected|expired (default: pending)
//          limit=N (default 50)
//          page=N  (default 0)
//
// Returns { items: PendingAction[], totalPending: number }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, desc, count as sqlCount } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { pendingActions, aiAssistants, taskRuns } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const qs = event.queryStringParameters || {};
    const statusFilter = ['pending', 'approved', 'rejected', 'expired'].includes(qs.status || '')
        ? qs.status!
        : 'pending';
    const limit = Math.min(parseInt(qs.limit || '50', 10) || 50, 100);
    const page  = parseInt(qs.page  || '0',  10) || 0;

    const db = getDb();

    const items = await db
        .select({
            id:                  pendingActions.id,
            taskRunId:           pendingActions.taskRunId,
            assistantId:         pendingActions.assistantId,
            assistantName:       aiAssistants.name,
            actionType:          pendingActions.actionType,
            reversibilityTier:   pendingActions.reversibilityTier,
            actionPayload:       pendingActions.actionPayload,
            affectedRecordCount: pendingActions.affectedRecordCount,
            status:              pendingActions.status,
            expiresAt:           pendingActions.expiresAt,
            createdAt:           pendingActions.createdAt,
            approvedAt:          pendingActions.approvedAt,
            rejectedAt:          pendingActions.rejectedAt,
            rejectionReason:     pendingActions.rejectionReason,
            taskRunMetadata:     taskRuns.metadata,
        })
        .from(pendingActions)
        .leftJoin(aiAssistants, eq(aiAssistants.id, pendingActions.assistantId))
        .leftJoin(taskRuns, eq(taskRuns.id, pendingActions.taskRunId))
        .where(and(
            eq(pendingActions.userId, userId),
            eq(pendingActions.status, statusFilter),
        ))
        .orderBy(desc(pendingActions.createdAt))
        .limit(limit)
        .offset(page * limit);

    // Always return current pending count for the badge
    const [{ totalPending }] = await db
        .select({ totalPending: sqlCount() })
        .from(pendingActions)
        .where(and(
            eq(pendingActions.userId, userId),
            eq(pendingActions.status, 'pending'),
        ));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, totalPending, page, limit }),
    };
});
