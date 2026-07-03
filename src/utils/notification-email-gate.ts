// src/utils/notification-email-gate.ts
// Server-side helper: should an email of a given notification type be sent to a user,
// per their account email preferences (account settings → Notification Preferences)?
//
// The pure category logic lives in notification-prefs.ts; this wrapper does the DB
// lookup. Locked/transactional categories always return true (isEmailEnabled forces it).
// FAILS OPEN: any lookup error (incl. pre-migration) returns true so a wanted — especially
// transactional — email is never wrongly dropped.

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';
import { isEmailEnabledFor, type AssistantOverrideMap } from './notification-prefs';

// Pass assistantId when the sender knows which assistant produced the alert — the user's
// per-assistant overrides (user_profiles.assistant_notif_prefs) then apply on top of the
// workspace-wide preference. Omitted/null → workspace-wide gating only.
export async function isEmailAllowedForUser(
    userId: number, notificationType: string, assistantId?: number | string | null,
): Promise<boolean> {
    const db = getDb();
    let email: Record<string, boolean> | null = null;
    let overrides: AssistantOverrideMap = null;
    try {
        const [p] = await db
            .select({ email: userProfiles.emailPreferences, assistantPrefs: userProfiles.assistantNotifPrefs })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        email = (p?.email as Record<string, boolean>) ?? null;
        overrides = (p?.assistantPrefs as AssistantOverrideMap) ?? null;
    } catch {
        // assistant_notif_prefs column may not be migrated yet — retry without it.
        try {
            const [p] = await db
                .select({ email: userProfiles.emailPreferences })
                .from(userProfiles)
                .where(eq(userProfiles.userId, userId))
                .limit(1);
            email = (p?.email as Record<string, boolean>) ?? null;
        } catch (err) {
            console.warn('[notification-email-gate] preference lookup failed — sending anyway:', err);
            return true;
        }
    }
    return isEmailEnabledFor(email, overrides, assistantId ?? null, notificationType);
}
