// netlify/functions/ai-visibility-reminder.ts
// Monthly nudge to run the AI Visibility check (Admin → Platform → Insights → AI Visibility,
// admin-ai-visibility.ts). The check is only useful as a monthly series, and nothing else starts a
// run: the API fetch (ai-visibility-fetch-background.ts) fills a run an admin has created.
// Scheduled: 1st of every month at 08:00 UTC (netlify.toml). Email only, to the business inbox.

import { desc } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiVisibilityRuns } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { adminInbox } from '../../src/utils/admin-inbox';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const handler = async () => {
    const db = getDb();
    const BASE = process.env.BASE_URL || 'https://bemoreswan.com';
    const now = new Date();
    const label = `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

    let last: { label: string; createdAt: Date } | undefined;
    try {
        [last] = await db.select({ label: aiVisibilityRuns.label, createdAt: aiVisibilityRuns.createdAt })
            .from(aiVisibilityRuns).orderBy(desc(aiVisibilityRuns.createdAt)).limit(1);
    } catch (err: any) {
        // Table not created on this database yet: still send the reminder, just without the last run.
        if (err?.code !== '42P01' && err?.cause?.code !== '42P01') throw err;
    }
    const lastLine = last
        ? `The last run was <strong>${last.label}</strong>, started ${last.createdAt.toISOString().slice(0, 10)}.`
        : 'There is no run yet.';

    for (const to of adminInbox()) {
        await sendEmail({
            to,
            subject: `[Be More Swan] Run this month's AI Visibility check (${label})`,
            html: `<p>Hi there,</p>
<p>It's time for this month's <strong>AI Visibility check</strong>: do ChatGPT, Claude, Gemini, Copilot and Google's AI Overview name Be More Swan, and do they get the facts right? ${lastLine}</p>
<ol>
<li>Click <strong>New run</strong> and call it <strong>${label}</strong>.</li>
<li>Click <strong>Fetch automatic answers</strong> for Claude, ChatGPT and Gemini.</li>
<li>Ask Copilot and Google's AI Overview yourself, then use <strong>Fill in by hand</strong> to paste their answers in.</li>
<li>Click <strong>Check accuracy</strong> and confirm each suggestion, so wrong facts get fixed.</li>
</ol>
<p><a href="${BASE}/admin.html?view=ai-visibility" style="display:inline-block;padding:10px 20px;background:#059669;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Open AI Visibility</a></p>`,
        }).catch((err) => console.error('[ai-visibility-reminder] send failed', err));
    }

    console.log(`[ai-visibility-reminder] Reminder for ${label} sent to ${adminInbox().length} inbox(es).`);
    return { statusCode: 200 };
};

export default withLambda(handler);
