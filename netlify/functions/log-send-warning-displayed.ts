// netlify/functions/log-send-warning-displayed.ts
// US-LEGAL-1.4: Log that the "Review before sending" AI disclaimer was displayed
// for a send/publish action. Provides evidentiary record in disputes.
//
// POST /.netlify/functions/log-send-warning-displayed
//   Body: { actionType: string, taskRunId?: number, displayedAt: string }
//   Auth: aura_session (optional — logs best-effort even without auth)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { adminAuditLog } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { actionType, taskRunId, displayedAt } = body;
    if (!actionType) {
        return { statusCode: 400, body: JSON.stringify({ error: 'actionType is required.' }) };
    }

    // Extract userId from session if present — log is best-effort without auth
    let userId: number | null = null;
    if (jwtSecret) {
        const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
        if (match) {
            try {
                userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
            } catch { /* ok — anonymous */ }
        }
    }

    try {
        const db = getDb();
        await db.insert(adminAuditLog).values({
            adminId: userId,
            action: 'review_warning_displayed',
            targetType: 'send_action',
            targetId: taskRunId ? String(taskRunId) : null,
            reason: `Review before sending warning shown for action: ${actionType}`,
            metadata: { actionType, taskRunId: taskRunId ?? null, displayedAt: displayedAt ?? new Date().toISOString() },
        });
    } catch (err) {
        // Non-fatal — don't block the user's send action
        console.error('[log-send-warning-displayed] DB error:', err);
    }

    return { statusCode: 200, body: JSON.stringify({ logged: true }) };
});
