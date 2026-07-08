// netlify/functions/admin-end-impersonation.ts
//
// US-ADM-1.2.1: End an active admin impersonation session.
//
// POST /.netlify/functions/admin-end-impersonation
//   Body: { originalToken: string, sessionId: string, startedAt: number }
//   Cookie: aura_session (must be an impersonation token with scope='impersonate')
//
// Restores the original admin session cookie and writes the impersonate_end audit log.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    }

    // Verify the current cookie is an impersonation token
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'No session.' }) };

    let payload: any;
    try {
        payload = jwt.verify(match[1], jwtSecret);
    } catch {
        // Expired token is fine — we still want to restore the original session
        try { payload = jwt.decode(match[1]); } catch { payload = null; }
    }

    if (!payload || payload.scope !== 'impersonate') {
        return { statusCode: 400, body: JSON.stringify({ error: 'No active impersonation session.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { originalToken, sessionId, startedAt } = body;

    // Restore the admin's original session cookie
    const restoreCookie = originalToken
        ? `aura_session=${originalToken}; Path=/; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
        : `aura_session=; Path=/; Secure; SameSite=Lax; Max-Age=0`;  // fallback: clear cookie

    // Calculate session duration
    const sessionDurationSeconds = startedAt
        ? Math.round((Date.now() - startedAt) / 1000)
        : null;

    // Write audit log
    await insertAdminAuditLog({
        adminId: payload.realUserId,
        action: 'impersonate_end',
        targetType: 'user',
        targetId: payload.impersonatingUserId,
        previousState: null as any,
        newState: { sessionId: sessionId || payload.sessionId },
        reason: 'impersonation_session_ended',
        ipAddress: getAdminIp(event.headers),
        userAgent: event.headers['user-agent'] || undefined,
        metadata: {
            sessionId: sessionId || payload.sessionId,
            sessionDurationSeconds,
            targetEmail: payload.targetUserEmail,
        },
    });

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': restoreCookie,
        },
        body: JSON.stringify({ success: true, redirect: '/admin.html' }),
    };
});
