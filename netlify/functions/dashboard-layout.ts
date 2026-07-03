// netlify/functions/dashboard-layout.ts
// US-DASH-4 (AC3): per-user dashboard widget layout — smart persistence.
//
//  GET  → { layout: [{ key, enabled }] | null }   // null = user has no saved layout yet
//  POST { layout: [{ key, enabled }] } → { ok: true }
//
// Stored in user_profiles.preferences.dashboardLayout (existing JSONB column — no new
// DDL / migration). User-scoped via the aura_session cookie, mirroring roi-stats.ts.

import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// Allow-list of widget keys the client may persist. Keep in sync with the catalog in
// dashboard-content.html. Unknown keys are dropped so junk can't be stored.
const ALLOWED_KEYS = ['quick-actions', 'roi-mini', 'team-status', 'notifications', 'tips', 'referral'];

export const handler = async (event: HandlerEvent) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };

    const sessionToken = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(sessionToken, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();

    if (event.httpMethod === 'GET') {
        try {
            const [profile] = await db
                .select({ preferences: userProfiles.preferences })
                .from(userProfiles)
                .where(eq(userProfiles.userId, userId))
                .limit(1);
            const prefs = (profile?.preferences as Record<string, any>) || {};
            const stored = Array.isArray(prefs.dashboardLayout) ? prefs.dashboardLayout : null;
            const layout = stored
                ? stored
                    .filter((w: any) => w && ALLOWED_KEYS.includes(w.key))
                    .map((w: any) => ({ key: w.key, enabled: w.enabled !== false }))
                : null;
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout }) };
        } catch (err) {
            console.error('dashboard-layout GET error:', err);
            return { statusCode: 200, body: JSON.stringify({ layout: null }) };
        }
    }

    if (event.httpMethod === 'POST') {
        let body: { layout?: Array<{ key: string; enabled?: boolean }> };
        try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }
        if (!Array.isArray(body.layout)) return { statusCode: 400, body: JSON.stringify({ error: 'layout array required.' }) };

        // Sanitise: known keys only, de-duplicated, capped.
        const seen = new Set<string>();
        const clean = body.layout
            .filter(w => w && ALLOWED_KEYS.includes(w.key))
            .filter(w => (seen.has(w.key) ? false : (seen.add(w.key), true)))
            .map(w => ({ key: w.key, enabled: w.enabled !== false }))
            .slice(0, ALLOWED_KEYS.length);

        try {
            const [profile] = await db
                .select({ id: userProfiles.id, preferences: userProfiles.preferences })
                .from(userProfiles)
                .where(eq(userProfiles.userId, userId))
                .limit(1);
            const currentPrefs = (profile?.preferences as Record<string, any>) || {};
            const nextPrefs = { ...currentPrefs, dashboardLayout: clean };

            if (profile) {
                await db.update(userProfiles)
                    .set({ preferences: nextPrefs, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));
            } else {
                await db.insert(userProfiles).values({ userId, preferences: nextPrefs });
            }
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
        } catch (err) {
            console.error('dashboard-layout POST error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save layout.' }) };
        }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
