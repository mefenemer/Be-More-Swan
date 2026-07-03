// onboarding-reminder.ts
// Scheduled function — runs daily at 10:00 UTC.
// Finds users who started onboarding but never completed their assistant setup,
// and whose draft has been idle for > 24 hours. Sends a single reminder email
// with a magic-link that routes them back to the exact step where they left off.
// Won't re-send if a reminder was already dispatched within the last 72 hours.

import type { Config } from '@netlify/functions';
import * as crypto from 'crypto';
import { and, lt, or, isNull, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, onboardingDrafts, aiAssistants, plans } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';
import { isEmailAllowedForUser } from '../../src/utils/notification-email-gate';

// ── Onboarding path → HTML page map ──────────────────────────────────────────
const ONBOARDING_PAGE: Record<string, string> = {
    'social-media':  'onboarding-social-media.html',
    'social_media':  'onboarding-social-media.html',
    'custom':        'onboarding-custom.html',
    'inventory':     'onboarding-inventory.html',
    'performance':   'onboarding-performance.html',
};

// ── Reminder email HTML ───────────────────────────────────────────────────────
function buildReminderEmail(firstName: string, resumeUrl: string): string {
    const name = firstName ? `Hi ${firstName}` : 'Hi there';
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Finish setting up your Assistant</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 4px 16px rgba(0,0,0,.06);overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#064e3b 0%,#065f46 100%);padding:36px 40px;">
              <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                Be More Swan
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <h2 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#111827;">${name},</h2>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#4b5563;">
                Your Digital Assistant is waiting for you — you just need to finish setting it up!
              </p>
              <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#6b7280;">
                You started configuring your assistant but didn't quite reach the finish line. Your progress has been saved, so you can pick up exactly where you left off.
              </p>
              <p style="margin:0 0 24px;font-size:15px;font-weight:700;color:#059669;">
                ⏱️ Takes less than 5 minutes to complete.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background-color:#059669;border-radius:10px;">
                    <a href="${resumeUrl}"
                       style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:0.01em;">
                      Finish Setting Up My Assistant →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- What's waiting -->
              <table cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:24px;width:100%;">
                <tr>
                  <td>
                    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.07em;">What's waiting for you</p>
                    <ul style="margin:0;padding:0 0 0 18px;color:#374151;font-size:14px;line-height:1.8;">
                      <li>Your assistant briefed and ready to deploy</li>
                      <li>Background automations active from day one</li>
                      <li>Hours back in your week — starting immediately</li>
                    </ul>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;">
                This link expires in 15 minutes for security. If you didn't start an Be More Swan onboarding,
                you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;background:#f9fafb;border-top:1px solid #f3f4f6;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                Be More Swan · 85 Great Portland Street, London, W1W 7LT ·
                <a href="mailto:support@bemoreswan.com" style="color:#059669;text-decoration:none;">support@bemoreswan.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Scheduled handler ─────────────────────────────────────────────────────────
export default async (req: Request): Promise<Response> => {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
        console.warn('[onboarding-reminder] RESEND_API_KEY not set — skipping.');
        return new Response('RESEND_API_KEY missing', { status: 500 });
    }

    const baseUrl = process.env.BASE_URL || 'https://bemoreswan.com';
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        console.error('[onboarding-reminder] JWT_SECRET missing.');
        return new Response('JWT_SECRET missing', { status: 500 });
    }

    try {
        const db = getDb();
        const now = Date.now();
        const cutoff24h = new Date(now - 24 * 60 * 60 * 1000);   // draft idle > 24 h
        const cutoff72h = new Date(now - 72 * 60 * 60 * 1000);   // don't re-send within 72 h

        // Find abandoned drafts: idle > 24 h and either never reminded or reminded > 72 h ago
        const staleDrafts = await db
            .select({
                userId:         onboardingDrafts.userId,
                currentStep:    onboardingDrafts.currentStep,
                onboardingPath: onboardingDrafts.onboardingPath,
            })
            .from(onboardingDrafts)
            .where(
                and(
                    lt(onboardingDrafts.updatedAt, cutoff24h),
                    or(
                        isNull(onboardingDrafts.reminderSentAt),
                        lt(onboardingDrafts.reminderSentAt, cutoff72h)
                    )
                )
            );

        console.log(`[onboarding-reminder] ${staleDrafts.length} stale draft(s) found.`);

        let sent = 0;
        let skipped = 0;

        for (const draft of staleDrafts) {
            // Skip users who have already completed onboarding (have an AI assistant)
            const [assistant] = await db
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(eq(aiAssistants.userId, draft.userId))
                .limit(1);

            if (assistant) { skipped++; continue; }

            // Load user — must be active to receive email
            const [user] = await db
                .select({
                    id:         users.id,
                    email:      users.email,
                    firstName:  users.firstName,
                    status:     users.status,
                })
                .from(users)
                .where(eq(users.id, draft.userId))
                .limit(1);

            if (!user || user.status !== 'active') { skipped++; continue; }

            // Respect the user's Onboarding email preference (account settings).
            if (!(await isEmailAllowedForUser(user.id, 'onboarding_incomplete'))) { skipped++; continue; }

            // ── Generate a magic link ─────────────────────────────────────────
            const plainToken  = crypto.randomBytes(32).toString('hex');
            const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
            const expiresAt   = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

            await db.update(users)
                .set({ verificationToken: hashedToken, tokenExpiresAt: expiresAt })
                .where(eq(users.id, user.id));

            // Build the resume URL — verify.ts will redirect to the right onboarding step
            const resumeUrl = `${baseUrl}/verify-account.html?token=${plainToken}&intent=resume_onboarding`;

            // ── Send reminder email ───────────────────────────────────────────
            try {
                // US-GAP-6.1.2 SC1: Only send if user has an active paid plan
                const [activePlan] = await db
                    .select({ id: plans.id })
                    .from(plans)
                    .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                    .limit(1);
                if (!activePlan) { skipped++; continue; }

                await sendMagicLinkEmail({
                    to:      user.email,
                    subject: 'Your Digital Assistant is waiting for you',
                    html:    buildReminderEmail(user.firstName || '', resumeUrl),
                });

                // Record that the reminder was sent
                await db.update(onboardingDrafts)
                    .set({ reminderSentAt: new Date() })
                    .where(eq(onboardingDrafts.userId, user.id));

                sent++;
                console.log(`[onboarding-reminder] Reminder sent → userId=${user.id} email=${user.email}`);
            } catch (emailErr) {
                console.error(`[onboarding-reminder] Failed to send to userId=${user.id}:`, (emailErr as any)?.message);
            }
        }

        console.log(`[onboarding-reminder] Done — sent=${sent}, skipped=${skipped}`);
        return new Response(JSON.stringify({ sent, skipped }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: any) {
        console.error('[onboarding-reminder] Fatal error:', err.message);
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
};

// Run daily at 10:00 UTC
export const config: Config = {
    schedule: '0 10 * * *',
};
