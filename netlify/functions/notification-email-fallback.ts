// netlify/functions/notification-email-fallback.ts
// Dynamic Communications Engine — Omni-Channel Routing & Offline Fallbacks (US4).
//
// Scheduled every 15 min (schedule: "*/15 * * * *"). When an urgent notification (opt-in
// allowlist in notification-actions.ts) has gone UNSEEN for > 1 hour, email the user so they
// don't miss crucial workflow tasks while offline (AC4.2/AC4.3). Sends at most one email per
// notification (fallback_email_sent_at guard). AC4.4 (squelch state_change/informational/
// celebratory) holds automatically — the allowlist is entirely critical/suggested types, and
// every type on it has been confirmed NOT to already send its own email (no double-sends).

import type { Handler } from '@netlify/functions';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { notifications, users } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { EMAIL_FALLBACK_TYPES } from '../../src/utils/notification-actions';

const BASE_URL = (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');
const UNSEEN_FOR_MS = 60 * 60 * 1000; // AC4.2: delivered more than 1 hour ago
const BATCH_LIMIT = 200;             // cap per run; the next sweep picks up the rest

async function runFallbackSweep() {
    const db = getDb();
    const cutoff = new Date(Date.now() - UNSEEN_FOR_MS);

    // Due = allowlisted type, unseen, not resolved, not dismissed, not already emailed,
    // delivered over an hour ago.
    const due = await db.select({
        id: notifications.id,
        title: notifications.title,
        message: notifications.message,
        email: users.email,
        firstName: users.firstName,
    })
        .from(notifications)
        .innerJoin(users, eq(users.id, notifications.userId))
        .where(and(
            inArray(notifications.type, EMAIL_FALLBACK_TYPES),
            eq(notifications.isRead, false),
            isNull(notifications.resolvedAt),
            isNull(notifications.dismissedAt),
            isNull(notifications.fallbackEmailSentAt),
            lt(notifications.deliveredAt, cutoff),
        ))
        .limit(BATCH_LIMIT);

    let sent = 0;
    for (const n of due) {
        if (!n.email) continue;
        try {
            await sendEmail({
                to: n.email,
                subject: n.title,
                html: `<p>Hi ${n.firstName || 'there'},</p>
                       <p><strong>${n.title}</strong></p>
                       ${n.message ? `<p>${n.message}</p>` : ''}
                       <p>This needs your attention — you haven't seen it in your Be More Swan workspace yet.</p>
                       <p><a href="${BASE_URL}/workspace.html?view=notifications">Open your notifications →</a></p>`,
            });
            // Mark emailed (guarded so two overlapping runs can't double-send the same row).
            await db.update(notifications)
                .set({ fallbackEmailSentAt: new Date() })
                .where(and(eq(notifications.id, n.id), isNull(notifications.fallbackEmailSentAt)));
            sent++;
        } catch (err) {
            console.error(`[notification-email-fallback] send failed for notification ${n.id}:`, err);
        }
    }
    return { due: due.length, sent };
}

export const handler: Handler = async () => {
    try {
        const result = await runFallbackSweep();
        console.log(`[notification-email-fallback] swept ${result.due} due, emailed ${result.sent}.`);
        return { statusCode: 200, body: JSON.stringify(result) };
    } catch (err) {
        console.error('[notification-email-fallback]', err);
        return { statusCode: 500 };
    }
};
