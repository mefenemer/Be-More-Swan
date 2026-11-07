// netlify/functions/restore-post.ts
// "Bring back" a removed or rejected post: it goes back to the Review column, with its cross-post
// siblings, to be approved again. The rules live in src/utils/restore-post.ts; the post editor's
// "Bring back" button and the chat's `restore` card both call this.
//
// POST /.netlify/functions/restore-post
//   Body: { postId: number }   — any row of a cross-post; the group's archived rows come back together
//   Returns: { success, restoredIds, mediaGone }
//   Auth: aura_session

import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { restorePosts } from '../../src/utils/restore-post';
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
    let orgId: number | undefined;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; organisationId?: number };
        userId = decoded.userId;
        orgId = decoded.organisationId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    let body: { postId?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const postId = Number(body.postId);
    if (!Number.isInteger(postId) || postId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    }

    try {
        const r = await restorePosts(getDb(), { postId, organisationId: orgId, userId });
        if (!r.ok) return { statusCode: r.status, body: JSON.stringify({ error: r.error }) };
        return { statusCode: 200, body: JSON.stringify({ success: true, restoredIds: r.restoredIds, mediaGone: r.mediaGone }) };
    } catch (err) {
        console.error('[restore-post] failed', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'The post could not be brought back. Please try again.' }) };
    }
});
