// netlify/functions/pending-actions-digest.ts
// US-GOV-2.1.1: Daily digest email for pending HITL actions older than 24 h.
// Scheduled: every day at 09:00 UTC via netlify.toml [functions.schedule]

import type { Handler } from '@netlify/functions';
import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { pendingActions, users } from '../../db/schema';
import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM   = process.env.EMAIL_FROM || 'noreply@bemoreswan.com';
const BASE   = process.env.BASE_URL   || 'https://bemoreswan.com';

const handler = async () => {
    const db = getDb();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find all users with at least one pending action older than 24 h
    const rows = await db
        .select({
            userId:    pendingActions.userId,
            email:     users.email,
            firstName: users.firstName,
            count:     sql<number>`cast(count(*) as int)`,
        })
        .from(pendingActions)
        .innerJoin(users, eq(users.id, pendingActions.userId))
        .where(and(
            eq(pendingActions.status, 'pending'),
            lt(pendingActions.createdAt, cutoff),
        ))
        .groupBy(pendingActions.userId, users.email, users.firstName);

    let sent = 0;
    for (const row of rows) {
        const name = row.firstName || 'there';
        await resend.emails.send({
            from: FROM,
            to:   row.email,
            subject: `[Be More Swan] ${row.count} action${row.count > 1 ? 's' : ''} waiting for your review`,
            html: `
<p>Hi ${name},</p>
<p>You have <strong>${row.count} pending action${row.count > 1 ? 's' : ''}</strong> in your Be More Swan Review Queue that ${row.count > 1 ? 'have' : 'has'} been waiting for more than 24 hours.</p>
<p>Unapproved actions will expire automatically. Please review them before they expire.</p>
<p><a href="${BASE}/workspace.html" style="display:inline-block;padding:10px 20px;background:#059669;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Open Review Queue</a></p>
<p style="color:#6b7280;font-size:12px;">You are receiving this because you have pending actions awaiting human approval in your Be More Swan workspace.</p>
            `.trim(),
        });
        sent++;
    }

    console.log(`[pending-actions-digest] Sent ${sent} digest email(s).`);
    return { statusCode: 200 };
};

export { handler };
// Schedule: "0 9 * * *" — configured in netlify.toml
