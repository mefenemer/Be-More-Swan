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
import { isEmailEnabled } from './notification-prefs';

export async function isEmailAllowedForUser(userId: number, notificationType: string): Promise<boolean> {
    try {
        const db = getDb();
        const [p] = await db
            .select({ email: userProfiles.emailPreferences })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        return isEmailEnabled((p?.email as Record<string, boolean>) ?? null, notificationType);
    } catch (err) {
        console.warn('[notification-email-gate] preference lookup failed — sending anyway:', err);
        return true;
    }
}
