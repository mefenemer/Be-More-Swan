// netlify/functions/set-review-notif-prefs.ts
// US-SMM-2.4.2: Update review notification preferences for an assistant.
//
// PATCH /.netlify/functions/set-review-notif-prefs
//   Auth: aura_session cookie
//   Body: {
//     assistantId: number,
//     reviewNotifPreference?: 'immediate' | 'daily_digest' | 'red_urgency_only',
//     reviewDigestTime?: string,  // HH:MM UTC, e.g. "09:00"
//     reviewCutoffHours?: number, // 1–24
//   }

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const VALID_NOTIF_PREFS = new Set(['immediate', 'daily_digest', 'red_urgency_only']);
const DIGEST_TIME_RE    = /^([01]\d|2[0-3]):[0-5]\d$/;

function getUserId(event: any): number | null {
    try {
        const cookie = event.headers.cookie || '';
        const match  = cookie.match(/aura_session=([^;]+)/);
        if (!match) return null;
        const payload: any = jwt.verify(match[1], JWT_SECRET);
        return payload.userId ?? null;
    } catch {
        return null;
    }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'PATCH') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const userId = getUserId(event);
    if (!userId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { assistantId, reviewNotifPreference, reviewDigestTime, reviewCutoffHours } = body;
    if (!assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    }

    if (reviewNotifPreference && !VALID_NOTIF_PREFS.has(reviewNotifPreference)) {
        return { statusCode: 400, body: JSON.stringify({ error: `reviewNotifPreference must be one of: ${[...VALID_NOTIF_PREFS].join(', ')}.` }) };
    }

    if (reviewDigestTime && !DIGEST_TIME_RE.test(reviewDigestTime)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'reviewDigestTime must be HH:MM in 24h format (UTC).' }) };
    }

    if (reviewCutoffHours != null) {
        const h = Number(reviewCutoffHours);
        if (!Number.isInteger(h) || h < 1 || h > 24) {
            return { statusCode: 400, body: JSON.stringify({ error: 'reviewCutoffHours must be an integer between 1 and 24.' }) };
        }
    }

    const db = getDb();

    // Resolve the active organisation (member-shared assistant ownership; membership verified).
    const org = await resolveActiveOrg(db, userId, getSession(event)?.activeOrganisationId);
    if (!org) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation associated with this account.' }) };
    const orgId = org.organisationId;

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (reviewNotifPreference) updates.reviewNotifPreference = reviewNotifPreference;
    if (reviewDigestTime)      updates.reviewDigestTime      = reviewDigestTime;
    if (reviewCutoffHours != null) updates.reviewCutoffHours = Number(reviewCutoffHours);

    // RLS-enforced update
    const result = await withTenant(orgId, (tx) => tx.update(aiAssistants)
        .set(updates)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .returning({ id: aiAssistants.id }));

    if (!result.length) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updated: true, ...updates }),
    };
});
