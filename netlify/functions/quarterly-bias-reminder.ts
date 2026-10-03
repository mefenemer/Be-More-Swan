// netlify/functions/quarterly-bias-reminder.ts
// US-GOV-3.3.1: Quarterly prompt review reminder to all SuperAdmins.
// Scheduled: 1st Jan, Apr, Jul, Oct at 08:00 UTC.

import type { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { sendEmail } from '../../src/utils/email';
import { withLambda } from '@netlify/aws-lambda-compat';

import { adminInbox } from '../../src/utils/admin-inbox';
const CHECKLIST = [
    'Demographic proxy language (e.g. gendered terms, nationality assumptions)',
    'Communication style framing (formal vs. informal defaults)',
    'Geographic / language quality filtering',
    'Lead priority criteria (name-origin clusters, region weighting)',
];

const handler = async () => {
    const db = getDb();
    const BASE = process.env.BASE_URL || 'https://bemoreswan.com';

    const superAdmins = await db.select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(eq(users.role, 'super_admin'));

    for (const admin of superAdmins) {
        // In-app notification
        await createNotification(db, 'quarterly_bias_reminder', {
            userId: admin.id,
            metadata: { dueDate: new Date().toISOString() },
        });
    }

    // One email to the business inbox (admin-inbox.ts), not one per admin account — those went to a
    // personal address. The in-app notification above still reaches every super admin.
    for (const to of adminInbox()) {
            await sendEmail({
                to,
                subject: '[Be More Swan] Quarterly Bias Prompt Review Due',
                html: `<p>Hi there,</p>
<p>It's time for the <strong>quarterly bias review</strong> of every active assistant's system prompt.</p>
<p>Please review the following checklist for each active assistant:</p>
<ul>${CHECKLIST.map(c => `<li>${c}</li>`).join('')}</ul>
<p>Once complete, record your findings in the Bias Audit section of the Admin Dashboard:</p>
<p><a href="${BASE}/admin.html?view=bias-audit" style="display:inline-block;padding:10px 20px;background:#059669;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Open Bias Audit Dashboard</a></p>
<p style="color:#6b7280;font-size:12px;">Review outcomes should include: reviewDate, promptsReviewed, findingsCount, and actionsRequired.</p>`,
            }).catch(() => {});
    }

    console.log(`[quarterly-bias-reminder] Notified ${superAdmins.length} super admin(s).`);
    return { statusCode: 200 };
};

export default withLambda(handler);
