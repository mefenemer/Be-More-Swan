// netlify/functions/send-onboarding-reminders.ts
// US-ONB-2.1.2: Hourly scheduled function — sends 24h and 72h onboarding reminder emails
// to users who registered but have not yet chosen a plan.
// Email CTA deep-links to workspace.html?action=select-plan&ref={code}

import { Handler } from '@netlify/functions';
import { eq, and, isNull, lt, gte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, notificationLog, userOrganisations } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();

    // Find users who: are active, have no active plan, and registered 24–25h or 72–73h ago
    const window24hStart = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const window24hEnd   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const window72hStart = new Date(now.getTime() - 73 * 60 * 60 * 1000);
    const window72hEnd   = new Date(now.getTime() - 72 * 60 * 60 * 1000);

    // Users registered in the 24h window
    const candidates24h = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName, referralCode: users.referralCode, createdAt: users.createdAt })
        .from(users)
        .where(and(
            eq(users.status, 'active'),
            gte(users.createdAt, window24hStart),
            lt(users.createdAt, window24hEnd),
        ));

    // Users registered in the 72h window
    const candidates72h = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName, referralCode: users.referralCode, createdAt: users.createdAt })
        .from(users)
        .where(and(
            eq(users.status, 'active'),
            gte(users.createdAt, window72hStart),
            lt(users.createdAt, window72hEnd),
        ));

    let sent = 0;

    const buildEmailBody = (firstName: string, ctaUrl: string, hasReferral: boolean, body: string) => `
        <p>Hi ${firstName || 'there'},</p>
        ${body}
        ${hasReferral ? '<p style="margin:12px 0;padding:12px 16px;background:#ecfdf5;border-left:4px solid #059669;border-radius:4px;color:#065f46;font-size:0.9rem;">Don\'t forget — your referral discount is waiting for you.</p>' : ''}
        <p style="margin-top:24px;">
          <a href="${ctaUrl}" style="background:#059669;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
            Choose My Plan →
          </a>
        </p>
        <p style="font-size:0.8rem;color:#9ca3af;margin-top:8px;">Or paste this link into your browser: ${ctaUrl}</p>
        <p style="font-size:0.85rem;color:#9ca3af;margin-top:16px;">Questions? Reply to this email — we're happy to help. Or visit our <a href="${BASE_URL}/help.html" style="color:#059669;text-decoration:none;">Help Center</a>.</p>
        <p>The Be More Swan Team</p>
    `;

    const SUBJECT = 'Your Be More Swan workspace is waiting — choose a plan to get started';

    for (const { candidates, type, bodyText } of [
        {
            candidates: candidates24h,
            type: '24h_reminder' as const,
            bodyText: '<p>You signed up for Be More Swan yesterday — your workspace is ready and waiting for you.</p><p>Choosing a plan takes less than a minute and unlocks your Digital Assistant straight away.</p>',
        },
        {
            candidates: candidates72h,
            type: '72h_reminder' as const,
            bodyText: '<p>It\'s been a few days since you joined Be More Swan. Your workspace is still here — all you need to do is choose a plan to get started.</p>',
        },
    ]) {
        for (const user of candidates) {
            // Check no active plan
            const [activePlan] = await db
                .select({ id: plans.id })
                .from(plans)
                .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                .limit(1);
            if (activePlan) continue;

            // Check not already sent this type
            const [alreadySent] = await db
                .select({ id: notificationLog.id })
                .from(notificationLog)
                .where(and(eq(notificationLog.userId, user.id), eq(notificationLog.type, type)))
                .limit(1);
            if (alreadySent) continue;

            const ctaUrl = user.referralCode
                ? `${BASE_URL}/workspace.html?action=select-plan&ref=${user.referralCode}`
                : `${BASE_URL}/workspace.html?action=select-plan`;

            try {
                await sendEmail({
                    to: user.email,
                    subject: SUBJECT,
                    html: buildEmailBody(user.firstName || '', ctaUrl, !!user.referralCode, bodyText),
                });
                await db.insert(notificationLog).values({ userId: user.id, type });
                sent++;
            } catch (err) {
                console.warn(`[send-onboarding-reminders] Failed for user ${user.id}:`, err);
            }
        }
    }

    console.log(`[send-onboarding-reminders] Sent ${sent} reminder emails`);
    return { statusCode: 200, body: JSON.stringify({ sent }) };
};
