// src/utils/product-update-recipients.ts
// Who receives the weekly "What's new" email. ONE definition, used by the count the admin sees
// before approving AND by the worker that sends — so "this will go to 214 customers" is exactly
// who it goes to.
//
// A recipient is a customer account (role 'user' — staff accounts are not customers) that is
// active, is not in its 24-hour deletion cooling-off, and has not turned "What's new" emails off
// (user_profiles.email_preferences.whats_new = false, written by the unsubscribe link or the
// account Notification Preferences matrix). No profile row = never chose = default ON.
// Test, app-review and the owner's own accounts are role 'user' too, so they are excluded by
// address (owner, 2026-11-13).

import { and, asc, eq, gt, notInArray, sql } from 'drizzle-orm';
import { users, userProfiles } from '../../db/schema';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

/** Never sent the "What's new" email. Lower case; compared against lower(users.email). */
export const EXCLUDED_RECIPIENT_EMAILS: readonly string[] = [
    'bmsreview.test@gmail.com',   // Review Tester
    'meta-review@bemoreswan.com', // Meta app reviewer
    'mefenemer@hotmail.com',      // owner
    'mefenemer@googlemail.com',   // owner
];

const isRecipient = and(
    eq(users.status, 'active'),
    eq(users.role, 'user'),
    sql`coalesce(${users.pendingDeletion}, false) = false`,
    sql`coalesce(${userProfiles.emailPreferences}->>'whats_new', 'true') <> 'false'`,
    notInArray(sql`lower(${users.email})`, [...EXCLUDED_RECIPIENT_EMAILS]),
);

export async function countRecipients(db: Db): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(isRecipient);
    return row?.n ?? 0;
}

/** One page of recipients after `afterId`, in id order — the worker walks the list with this. */
export async function recipientPage(db: Db, afterId: number, limit: number) {
    return db.select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(and(isRecipient, gt(users.id, afterId)))
        .orderBy(asc(users.id))
        .limit(limit);
}
