// netlify/functions/move-connection.ts
// The "Move it here?" action on the tenant-collision modal. Logic and the who-may rule live in
// src/utils/connection-move.ts; this is the HTTP shell.
//
// GET  ?attempt=<id>        → { canMove: true, platform, fromWorkspace, scheduledPosts } | { canMove: false }
// POST { attemptId }        → { ok: true, moved, cancelledCount, platform } | 403
//
// The browser sends only the attempt id the OAuth callback put in the redirect. Everything else is
// read from the recorded attempt and re-checked against the caller's memberships on every call.
// A refusal never says WHY beyond "not available", so a non-member learns nothing about who holds
// the account (US2 AC2.1).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { checkMove, moveConnectionOut } from '../../src/utils/connection-move';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const caller = { userId: ctx.userId, organisationId: ctx.organisationId };

    let attemptId: number;
    if (event.httpMethod === 'GET') {
        attemptId = Number(event.queryStringParameters?.attempt);
    } else {
        try { attemptId = Number(JSON.parse(event.body || '{}').attemptId); }
        catch { return json(400, { error: 'Invalid request.' }); }
    }
    if (!Number.isInteger(attemptId) || attemptId <= 0) return json(400, { error: 'attempt is required.' });

    try {
        if (event.httpMethod === 'GET') {
            const check = await checkMove(db, attemptId, caller);
            if (!check.canMove) return json(200, { canMove: false });
            return json(200, { canMove: true, platform: check.platform, fromWorkspace: check.fromWorkspace, scheduledPosts: check.scheduledPosts });
        }
        const result = await moveConnectionOut(db, attemptId, caller);
        if (!result.canMove) return json(403, { error: 'This account cannot be moved from here.' });
        return json(200, { ok: true, moved: result.moved, cancelledCount: result.cancelledCount, platform: result.platform });
    } catch (err) {
        console.error('[move-connection] failed', err);
        return json(500, { error: 'Could not move the account. Please try again.' });
    }
});
