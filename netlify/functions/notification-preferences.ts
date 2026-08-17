// notification-preferences.ts
// Backs the unified Notification Preferences matrix (account settings + assistant drawer).
//
// GET  → { categories: MatrixRow[], smsAvailable, whatsappAvailable }
//        Each row carries per-channel { value, locked } for inApp + email and
//        { available } for sms + whatsapp. Locked channels are forced ON.
//        Rows also carry `scope`: 'account' rows render in Account Settings,
//        'assistant' rows in the Assistant Profile drawer.
//        ?assistantId=N → assistant-scope rows resolve that assistant's per-user
//        overrides: value becomes the EFFECTIVE value and the row gains
//        { overridden: { inApp, email } } so the UI can show "Custom" vs default.
//
// POST → { key, channel: 'inApp' | 'email', value }            — single workspace toggle
//        { channel, preferences: Record<string, boolean> }      — bulk for one channel
//        { assistantId, key, channel, value: bool|null }        — per-assistant override
//                                                                  (null clears → workspace default)
//        { assistantId, reset: true }                           — clear all overrides for assistant
//        Rejects locked channel changes and any sms/whatsapp write (422).
//
// The category model + per-channel rules live in src/utils/notification-prefs.ts.
// Per-assistant overrides are stored in user_profiles.assistant_notif_prefs
// (db/notifications-assistant-scope.sql) and only apply to scope:'assistant' rows.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles, aiAssistants, masterAssistants } from '../../db/schema';
import {
    PREF_CATEGORIES, buildDefaults, resolveInAppPrefs, overrideFor, CHANNEL_AVAILABILITY, pushRule,
    assistantCategoryAppliesToRole, isPublishingOnlyCategory,
    type PrefChannel, type AssistantOverrideMap,
} from '../../src/utils/notification-prefs';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

type PrefMap = Record<string, boolean>;

// Load both preference maps + per-assistant overrides + the legacy notify_availability
// seed. Defensive: if the in_app_preferences (db/notification-in-app-preferences.sql) or
// assistant_notif_prefs (db/notifications-assistant-scope.sql) columns haven't been
// migrated yet, selecting them throws — fall back progressively so GET still works.
async function loadPrefs(db: ReturnType<typeof getDb>, userId: number): Promise<{
    email: PrefMap | null; inApp: PrefMap | null; push: PrefMap | null;
    assistantPrefs: AssistantOverrideMap;
    legacyAvailability: boolean | null;
    inAppColumn: boolean; assistantColumn: boolean; pushColumn: boolean;
}> {
    try {
        const [p] = await db.select({
            email: userProfiles.emailPreferences,
            inApp: userProfiles.inAppPreferences,
            push: userProfiles.pushPreferences,
            assistantPrefs: userProfiles.assistantNotifPrefs,
            notifyAvailability: userProfiles.notifyAvailability,
        }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
        return {
            email: (p?.email as PrefMap) ?? null,
            inApp: (p?.inApp as PrefMap) ?? null,
            push: (p?.push as PrefMap) ?? null,
            assistantPrefs: (p?.assistantPrefs as AssistantOverrideMap) ?? null,
            legacyAvailability: p?.notifyAvailability ?? null,
            inAppColumn: true,
            assistantColumn: true,
            pushColumn: true,
        };
    } catch { /* fall through */ }
    try {
        const [p] = await db.select({
            email: userProfiles.emailPreferences,
            inApp: userProfiles.inAppPreferences,
            notifyAvailability: userProfiles.notifyAvailability,
        }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
        return {
            email: (p?.email as PrefMap) ?? null,
            inApp: (p?.inApp as PrefMap) ?? null,
            push: null,
            assistantPrefs: null,
            legacyAvailability: p?.notifyAvailability ?? null,
            inAppColumn: true,
            assistantColumn: false,
            pushColumn: false,
        };
    } catch {
        const [p] = await db.select({
            email: userProfiles.emailPreferences,
            notifyAvailability: userProfiles.notifyAvailability,
        }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
        return {
            email: (p?.email as PrefMap) ?? null,
            inApp: null,
            push: null,
            assistantPrefs: null,
            legacyAvailability: p?.notifyAvailability ?? null,
            inAppColumn: false,
            assistantColumn: false,
            pushColumn: false,
        };
    }
}

export default withLambda(async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // ── GET ─────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const { email, inApp, push, assistantPrefs, legacyAvailability, pushColumn } = await loadPrefs(db, userId);
        const emailVals: PrefMap = { ...buildDefaults('email'), ...(email ?? {}) };
        const inAppVals = resolveInAppPrefs(inApp, legacyAvailability);
        const pushVals: PrefMap = { ...buildDefaults('push'), ...(push ?? {}) };

        // ?assistantId=N → assistant-scope rows resolve that assistant's overrides.
        const rawAid = event.queryStringParameters?.assistantId;
        const assistantId = rawAid && /^\d+$/.test(rawAid) ? rawAid : null;

        const categories = PREF_CATEGORIES.map(cat => {
            const base = {
                key: cat.key,
                label: cat.label,
                description: cat.description,
                scope: cat.scope,
                inApp: { value: cat.inApp.locked ? true : !!inAppVals[cat.key], locked: cat.inApp.locked },
                email: { value: cat.email.locked ? true : !!emailVals[cat.key], locked: cat.email.locked },
                // No push category is ever locked (see the header note in notification-prefs.ts),
                // so `locked` is always false here — emitted anyway so the three channels share
                // one shape and the client renders them through the same switch cell.
                // `available` reflects only whether push_preferences is migrated — it is NOT the
                // per-user gate. That is the browser permission plus a live push_subscriptions
                // row, which only the client can know.
                push: { value: !!pushVals[cat.key], locked: pushRule(cat).locked, available: pushColumn },
                sms: { available: CHANNEL_AVAILABILITY.sms },
                whatsapp: { available: CHANNEL_AVAILABILITY.whatsapp },
            };
            if (!assistantId || cat.scope !== 'assistant') return base;
            const oInApp = overrideFor(assistantPrefs, assistantId, cat.key, 'inApp');
            const oEmail = overrideFor(assistantPrefs, assistantId, cat.key, 'email');
            const oPush = overrideFor(assistantPrefs, assistantId, cat.key, 'push');
            return {
                ...base,
                inApp: { ...base.inApp, value: oInApp ?? base.inApp.value },
                email: { ...base.email, value: oEmail ?? base.email.value },
                push: { ...base.push, value: oPush ?? base.push.value },
                overridden: { inApp: oInApp !== undefined, email: oEmail !== undefined, push: oPush !== undefined },
            };
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                categories,
                pushAvailable: pushColumn,
                smsAvailable: CHANNEL_AVAILABILITY.sms,
                whatsappAvailable: CHANNEL_AVAILABILITY.whatsapp,
            }),
        };
    }

    // ── POST ────────────────────────────────────────────────────────────────────
    let body: {
        key?: string; channel?: string; value?: boolean | null;
        preferences?: Record<string, boolean>;
        assistantId?: number | string; reset?: boolean;
    } = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    // ── Per-assistant override writes ───────────────────────────────────────────
    if (body.assistantId !== undefined) {
        if (!/^\d+$/.test(String(body.assistantId))) {
            return { statusCode: 400, body: JSON.stringify({ error: 'assistantId must be a number.' }) };
        }
        const aid = String(body.assistantId);

        const saveOverrides = async (overrides: Record<string, any>) => {
            await db.update(userProfiles)
                .set({ assistantNotifPrefs: overrides, updatedAt: new Date() } as any)
                .where(eq(userProfiles.userId, userId));
        };

        try {
            const { assistantPrefs, assistantColumn } = await loadPrefs(db, userId);
            if (!assistantColumn) throw new Error('assistant_notif_prefs column missing');
            const overrides: Record<string, any> = { ...(assistantPrefs ?? {}) };

            if (body.reset) {
                delete overrides[aid];
            } else {
                const ch = body.channel as PrefChannel | undefined;
                if (ch !== 'inApp' && ch !== 'email' && ch !== 'push') {
                    return { statusCode: 400, body: JSON.stringify({ error: "channel must be 'inApp', 'email' or 'push'." }) };
                }
                const cat = PREF_CATEGORIES.find(c => c.key === body.key);
                if (!cat) return { statusCode: 400, body: JSON.stringify({ error: `Unknown preference key: ${body.key}` }) };
                if (cat.scope !== 'assistant') {
                    return { statusCode: 422, body: JSON.stringify({ error: `${cat.label} is a workspace-level preference and cannot be customised per assistant.` }) };
                }
                if (typeof body.value !== 'boolean' && body.value !== null) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'value must be a boolean, or null to restore the workspace default.' }) };
                }
                // Role guard: publishing-only categories (Content & Publishing) don't apply to
                // non-publishing roles, which never draft or publish posts. Only enforced when
                // *setting* an override (value=boolean) — clearing (null) is always allowed so a
                // stale override can be removed. Resolve the assistant's roleKey via its master
                // role; if the assistant can't be found for this user, fail open (treat as social,
                // matching the legacy/unknown default) rather than block a legitimate write.
                if (body.value !== null && isPublishingOnlyCategory(cat.key)) {
                    // Category is publishing-only — confirm the role actually publishes.
                    const [asst] = await db
                        .select({ roleKey: masterAssistants.roleKey })
                        .from(aiAssistants)
                        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
                        .where(and(eq(aiAssistants.id, Number(aid)), eq(aiAssistants.userId, userId)))
                        .limit(1);
                    if (asst && !assistantCategoryAppliesToRole(cat.key, asst.roleKey)) {
                        return { statusCode: 422, body: JSON.stringify({ error: `${cat.label} does not apply to this assistant's role.`, code: 'CATEGORY_NOT_APPLICABLE' }) };
                    }
                }
                const forAssistant = { ...(overrides[aid] ?? {}) };
                const forCat = { ...(forAssistant[cat.key] ?? {}) };
                if (body.value === null) delete forCat[ch]; else forCat[ch] = body.value;
                // Prune empty levels so "no override" is a missing key, not an empty object.
                if (Object.keys(forCat).length) forAssistant[cat.key] = forCat; else delete forAssistant[cat.key];
                if (Object.keys(forAssistant).length) overrides[aid] = forAssistant; else delete overrides[aid];
            }

            await saveOverrides(overrides);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, assistantId: Number(aid), overrides: overrides[aid] ?? null }),
            };
        } catch (err) {
            console.error('[notification-preferences] per-assistant save failed:', err);
            return { statusCode: 503, body: JSON.stringify({ error: 'Per-assistant preferences are not available yet. Please try again shortly.', code: 'ASSISTANT_PREFS_UNAVAILABLE' }) };
        }
    }

    const channel = body.channel as PrefChannel | undefined;
    if (channel !== 'inApp' && channel !== 'email' && channel !== 'push') {
        return { statusCode: 400, body: JSON.stringify({ error: "channel must be 'inApp', 'email' or 'push'. SMS/WhatsApp are not yet available." }) };
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
        if ((channel === 'push' ? pushRule(cat) : cat[channel]).locked) {
            return { statusCode: 422, body: JSON.stringify({ error: `${cat.label} is required and cannot be changed.`, code: 'PREFERENCE_LOCKED' }) };
        }
    }

    try {
        const { email, inApp, push, legacyAvailability } = await loadPrefs(db, userId);
        const current: PrefMap = channel === 'inApp'
            ? resolveInAppPrefs(inApp, legacyAvailability)
            : channel === 'push'
            ? { ...buildDefaults('push'), ...(push ?? {}) }
            : { ...buildDefaults('email'), ...(email ?? {}) };

        const updated: PrefMap = { ...current, ...changes };
        // Never persist a value that contradicts a locked rule. No push category is locked, so
        // this is a no-op on that channel — kept uniform rather than special-cased.
        for (const cat of PREF_CATEGORIES) {
            if ((channel === 'push' ? pushRule(cat) : cat[channel]).locked) updated[cat.key] = true;
        }

        const column = channel === 'inApp' ? 'inAppPreferences'
            : channel === 'push' ? 'pushPreferences'
            : 'emailPreferences';
        await db.update(userProfiles)
            .set({ [column]: updated, updatedAt: new Date() } as any)
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
        if (channel === 'push') {
            // Almost certainly db/push-notifications.sql not applied on this environment.
            return { statusCode: 503, body: JSON.stringify({ error: 'Push preferences are not available yet. Please try again shortly.', code: 'PUSH_PREFS_UNAVAILABLE' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not save preference.' }) };
    }
});
