// notification-preferences.ts
// Backs the unified Notification Preferences matrix (account settings).
//
// GET  → { categories: MatrixRow[], smsAvailable, whatsappAvailable }
//        Each row carries per-channel { value, locked } for inApp + email and
//        { available } for sms + whatsapp. Locked channels are forced ON.
//
// POST → { key, channel: 'inApp' | 'email', value }            — single toggle
//        { channel, preferences: Record<string, boolean> }      — bulk for one channel
//        Rejects locked channel changes and any sms/whatsapp write (422).
//
// The category model + per-channel rules live in src/utils/notification-prefs.ts.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';
import {
    PREF_CATEGORIES, buildDefaults, resolveInAppPrefs, CHANNEL_AVAILABILITY, type PrefChannel,
} from '../../src/utils/notification-prefs';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

type PrefMap = Record<string, boolean>;

// Load both preference maps + the legacy notify_availability seed. Defensive: if the
// in_app_preferences column hasn't been migrated yet (db/notification-in-app-preferences.sql),
// selecting it throws — fall back to the legacy columns so GET still works.
async function loadPrefs(db: ReturnType<typeof getDb>, userId: number): Promise<{
    email: PrefMap | null; inApp: PrefMap | null; legacyAvailability: boolean | null; inAppColumn: boolean;
}> {
    try {
        const [p] = await db.select({
            email: userProfiles.emailPreferences,
            inApp: userProfiles.inAppPreferences,
            notifyAvailability: userProfiles.notifyAvailability,
        }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
        return {
            email: (p?.email as PrefMap) ?? null,
            inApp: (p?.inApp as PrefMap) ?? null,
            legacyAvailability: p?.notifyAvailability ?? null,
            inAppColumn: true,
        };
    } catch {
        const [p] = await db.select({
            email: userProfiles.emailPreferences,
            notifyAvailability: userProfiles.notifyAvailability,
        }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
        return {
            email: (p?.email as PrefMap) ?? null,
            inApp: null,
            legacyAvailability: p?.notifyAvailability ?? null,
            inAppColumn: false,
        };
    }
}

export const handler: Handler = async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // ── GET ─────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const { email, inApp, legacyAvailability } = await loadPrefs(db, userId);
        const emailVals: PrefMap = { ...buildDefaults('email'), ...(email ?? {}) };
        const inAppVals = resolveInAppPrefs(inApp, legacyAvailability);

        const categories = PREF_CATEGORIES.map(cat => ({
            key: cat.key,
            label: cat.label,
            description: cat.description,
            inApp: { value: cat.inApp.locked ? true : !!inAppVals[cat.key], locked: cat.inApp.locked },
            email: { value: cat.email.locked ? true : !!emailVals[cat.key], locked: cat.email.locked },
            sms: { available: CHANNEL_AVAILABILITY.sms },
            whatsapp: { available: CHANNEL_AVAILABILITY.whatsapp },
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                categories,
                smsAvailable: CHANNEL_AVAILABILITY.sms,
                whatsappAvailable: CHANNEL_AVAILABILITY.whatsapp,
            }),
        };
    }

    // ── POST ────────────────────────────────────────────────────────────────────
    let body: { key?: string; channel?: string; value?: boolean; preferences?: Record<string, boolean> } = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const channel = body.channel as PrefChannel | undefined;
    if (channel !== 'inApp' && channel !== 'email') {
        return { statusCode: 400, body: JSON.stringify({ error: "channel must be 'inApp' or 'email'. SMS/WhatsApp are not yet available." }) };
    }

    // Collect the requested changes as { key: value }.
    const changes: Record<string, boolean> = {};
    if (body.preferences && typeof body.preferences === 'object') {
        for (const [k, v] of Object.entries(body.preferences)) if (typeof v === 'boolean') changes[k] = v;
    } else if (body.key !== undefined && typeof body.value === 'boolean') {
        changes[body.key] = body.value;
    } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'Provide { key, channel, value } or { channel, preferences }.' }) };
    }

    // Validate keys + reject locked-channel changes.
    for (const k of Object.keys(changes)) {
        const cat = PREF_CATEGORIES.find(c => c.key === k);
        if (!cat) return { statusCode: 400, body: JSON.stringify({ error: `Unknown preference key: ${k}` }) };
        if (cat[channel].locked) {
            return { statusCode: 422, body: JSON.stringify({ error: `${cat.label} is required and cannot be changed.`, code: 'PREFERENCE_LOCKED' }) };
        }
    }

    try {
        const { email, inApp, legacyAvailability } = await loadPrefs(db, userId);
        const current: PrefMap = channel === 'inApp'
            ? resolveInAppPrefs(inApp, legacyAvailability)
            : { ...buildDefaults('email'), ...(email ?? {}) };

        const updated: PrefMap = { ...current, ...changes };
        // Never persist a value that contradicts a locked rule.
        for (const cat of PREF_CATEGORIES) if (cat[channel].locked) updated[cat.key] = true;

        await db.update(userProfiles)
            .set({ [channel === 'inApp' ? 'inAppPreferences' : 'emailPreferences']: updated, updatedAt: new Date() } as any)
            .where(eq(userProfiles.userId, userId));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, channel, preferences: updated }),
        };
    } catch (err) {
        // Most likely the in_app_preferences column isn't migrated yet.
        console.error('[notification-preferences] save failed:', err);
        if (channel === 'inApp') {
            return { statusCode: 503, body: JSON.stringify({ error: 'In-app preferences are not available yet. Please try again shortly.', code: 'INAPP_PREFS_UNAVAILABLE' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not save preference.' }) };
    }
};
