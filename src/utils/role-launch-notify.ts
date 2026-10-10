// src/utils/role-launch-notify.ts
// Tell people a role has launched: an in-app "new role available" notification to every user opted in
// to it, and an email to everyone on that role's waitlist (waitlist rows marked notified).
//
// Moved out of netlify/functions/master-assistants.ts so the one status control on Admin ▸ Assistants
// (netlify/functions/admin-assistants.ts) and the older PATCH announce a launch the same way.
// Never throws — the status change has already been saved; a failed announcement is logged.

import { eq, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import type { getDb } from '../../db/client';
import { userProfiles, waitlist } from '../../db/schema';
import { createNotifications } from './notify';

type Db = ReturnType<typeof getDb>;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // resend v6 throws at construction without a key
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@bemoreswan.com';

/** Returns how many in-app notifications were created. */
export async function announceRoleLaunch(db: Db, assistant: { id: number; name: string }): Promise<number> {
    let notifiedCount = 0;
    try {
        // Find all user profiles opted in to New Role Availability in-app alerts. The
        // canonical store is in_app_preferences.new_role_availability (account settings →
        // Notification Preferences); fall back to the legacy notify_availability column
        // when the user has no stored in-app prefs yet. Mirrors resolveInAppPrefs so the
        // creation gate agrees with the read-time filter in notifications.ts. (Errs
        // permissive — the read filter hides any over-creation; it must never under-create.)
        const profiles = await db
            .select({ userId: userProfiles.userId })
            .from(userProfiles)
            .where(sql`COALESCE((${userProfiles.inAppPreferences} ->> 'new_role_availability')::boolean, ${userProfiles.notifyAvailability}) = true`);

        if (profiles.length > 0) {
            // createNotifications batches in 100s internally.
            notifiedCount = await createNotifications(db, 'new_role_availability', profiles.map(p => p.userId), {
                context: { assistant: { name: assistant.name } },
            });
        }

        // Also mark waitlist entries for this assistant as notified
        await db
            .update(waitlist)
            .set({ notified: true })
            .where(eq(waitlist.masterAssistantId, assistant.id));

        // ── US11: Send personalised Resend email to every waitlist entry ──────
        if (process.env.RESEND_API_KEY) {
            const waitlistEntries = await db
                .select({ email: waitlist.email })
                .from(waitlist)
                .where(eq(waitlist.masterAssistantId, assistant.id));

            for (const entry of waitlistEntries) {
                try {
                    await resend.emails.send({
                        from: FROM_EMAIL,
                        to: entry.email,
                        subject: `${assistant.name} is now Live on Be More Swan!`,
                        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
<div style="background:#111827;padding:28px 32px;text-align:center">
  <span style="color:#10b981;font-size:28px;font-weight:800;letter-spacing:-1px">Be More Swan</span>
  <span style="color:#fff;font-size:28px;font-weight:800;letter-spacing:-1px">-Assist</span>
</div>
<div style="padding:32px">
  <div style="width:56px;height:56px;background:#d1fae5;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;text-align:center;line-height:56px">🎉</div>
  <h1 style="margin:0 0 12px;font-size:24px;font-weight:800;color:#111827;text-align:center">
    ${assistant.name} is now Live!
  </h1>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.7;text-align:center">
    The role you've been waiting for is ready. Hire your ${assistant.name} today and put AI to work for your business.
  </p>
  <div style="text-align:center;margin-bottom:32px">
    <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/assistants.html"
       style="display:inline-block;background:#10b981;color:#fff;font-weight:700;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none">
      View ${assistant.name} &rarr;
    </a>
  </div>
  <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center">
    You're receiving this because you joined the waitlist for ${assistant.name}.<br>
    <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/workspace.html" style="color:#10b981;text-decoration:none">Manage preferences</a>
  </p>
</div>
  </div>
</body>
</html>`,
                    });
                } catch (emailErr) {
                    console.warn(`[role-launch] Waitlist email failed for ${entry.email}:`, emailErr);
                }
            }
        }
    } catch (fanOutErr) {
        // Non-blocking — update already applied; log and continue
        console.error('[role-launch] Fan-out error (non-blocking):', fanOutErr);
    }
    return notifiedCount;
}
