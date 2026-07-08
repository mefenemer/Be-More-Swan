// netlify/functions/approve-pending-action.ts
// US-GOV-4.1.2: Deployer approves or rejects a queued HITL action.
// POST /.netlify/functions/approve-pending-action
//   Body: { pendingActionId: number, decision: 'approved' | 'rejected', rejectionReason?: string }
//   Auth: aura_session (must be the deployer who owns the run)
//
// Returns { success: boolean, status: 'approved' | 'rejected', actionPayload? }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { pendingActions, notifications } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
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

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { pendingActionId, decision, rejectionReason } = body;
    if (!pendingActionId || !['approved', 'rejected'].includes(decision)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'pendingActionId and decision (approved|rejected) are required.' }) };
    }
    if (decision === 'rejected' && !rejectionReason?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'rejectionReason is required when rejecting.' }) };
    }

    const db = getDb();

    const [action] = await db.select().from(pendingActions)
        .where(and(eq(pendingActions.id, pendingActionId), eq(pendingActions.userId, userId)))
        .limit(1);

    if (!action) return { statusCode: 404, body: JSON.stringify({ error: 'Pending action not found.' }) };
    if (action.status !== 'pending') {
        return { statusCode: 409, body: JSON.stringify({ error: `Action is already '${action.status}'.` }) };
    }
    if (new Date() > action.expiresAt) {
        // Mark expired if not already done by the scheduled job
        await db.update(pendingActions).set({ status: 'expired' }).where(eq(pendingActions.id, pendingActionId));
        return { statusCode: 410, body: JSON.stringify({ error: 'This action approval request has expired.' }) };
    }

    const now = new Date();
    await db.update(pendingActions)
        .set({
            status: decision,
            approvedBy: decision === 'approved' ? userId : null,
            approvedAt: decision === 'approved' ? now : null,
            rejectedAt: decision === 'rejected' ? now : null,
            rejectionReason: decision === 'rejected' ? rejectionReason.trim() : null,
        })
        .where(eq(pendingActions.id, pendingActionId));

    if (decision === 'rejected') {
        await db.insert(notifications).values({
            userId,
            type: 'action_rejected',
            title: `Action rejected: ${action.actionType}`,
            message: `You rejected the pending ${action.actionType} action for run #${action.taskRunId}. Reason: ${rejectionReason}`,
            metadata: { pendingActionId, assistantId: action.assistantId },
        }).catch(() => {});
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success: true,
            status: decision,
            // Return the payload on approval so the caller can proceed with execution
            ...(decision === 'approved' ? { actionPayload: action.actionPayload } : {}),
        }),
    };
});
