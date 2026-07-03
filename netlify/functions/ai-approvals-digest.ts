// netlify/functions/ai-approvals-digest.ts
// Epic 3 US8: opt-in email digest of pending AI-drafted posts.
//
// Schedule: "0 8 * * *" (08:00 UTC daily). For each org with ai_digest_frequency set:
//   • daily  → run every day
//   • weekly → run on Mondays only
// Emails the workspace owner a summary + deep link IF there are pending AI drafts. Sends NOTHING
// when the queue is empty (zero-spam rule, AC).

import { Handler } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, scheduledPosts } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    const db = getDb();
    const isMonday = new Date().getUTCDay() === 1;

    // Orgs that opted in (and are due today).
    const orgs = await db
        .select({ id: organisations.id, name: organisations.name, frequency: organisations.aiDigestFrequency })
        .from(organisations)
        .where(sql`${organisations.aiDigestFrequency} IN ('daily','weekly')`);

    let sent = 0, skippedEmpty = 0, skippedNotDue = 0;

    for (const org of orgs) {
        if (org.frequency === 'weekly' && !isMonday) { skippedNotDue++; continue; }

        const [{ count } = { count: 0 }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, org.id),
                eq(scheduledPosts.status, 'pending_approval'),
                eq(scheduledPosts.isAutonomous, true),
            ));

        if (!count) { skippedEmpty++; continue; }   // zero-spam rule

        // Workspace owner email.
        const owner = await db.execute<{ email: string; first_name: string }>(sql`
            SELECT u.email, u.first_name
            FROM users u
            JOIN user_organisations uo ON uo.user_id = u.id
            WHERE uo.organisation_id = ${org.id} AND uo.role = 'owner'
            LIMIT 1
        `);
        const to = owner[0]?.email;
        if (!to) { skippedEmpty++; continue; }

        await sendEmail({
            to,
            subject: `${count} AI-drafted post${count === 1 ? '' : 's'} waiting for your review`,
            html: `
              <div style="font-family:sans-serif;padding:32px 20px;background:#fdfcf9;">
                <div style="max-width:520px;margin:0 auto;background:#fff;padding:36px;border-radius:14px;border:1px solid #eae4d7;">
                  <h2 style="color:#1f1e1b;margin-top:0;">Your AI assistant has been busy</h2>
                  <p style="color:#5c564b;font-size:15px;line-height:1.6;">
                    Hi ${owner[0].first_name || 'there'},<br><br>
                    You have <strong>${count}</strong> AI-drafted post${count === 1 ? '' : 's'} waiting in your AI review queue.
                    Review, edit, or approve ${count === 1 ? 'it' : 'them'} whenever you're ready.
                  </p>
                  <a href="${BASE_URL}/workspace.html#ai-approvals"
                     style="display:inline-block;margin:16px 0;padding:12px 24px;background:#00e55c;color:#fff;font-weight:bold;border-radius:8px;text-decoration:none;">
                    Review your drafts →
                  </a>
                  <p style="color:#9e9689;font-size:13px;margin-bottom:0;">You're receiving this because AI digest emails are turned on for ${org.name}. You can change this in your workspace.</p>
                </div>
              </div>`,
        }).then(() => { sent++; }).catch(err => console.error('[ai-approvals-digest] send failed for org', org.id, err));
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, orgsConsidered: orgs.length, sent, skippedEmpty, skippedNotDue }),
    };
};
