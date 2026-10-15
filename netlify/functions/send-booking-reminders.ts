// netlify/functions/send-booking-reminders.ts — the day-before reminder for website bookings
// (docs/booking-plan.md phase 2). Scheduled hourly (netlify.toml).
//
// Each run finds CONFIRMED bookings that start within the next 24 hours, were made more than a day
// before they start (a booking made this morning for tonight needs no reminder), and have not been
// reminded; emails each customer with the details and their "Change or cancel" link; and stamps
// reminder_sent_at so nobody is reminded twice. A reminder is a message, not AI work: no tasks.

import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { bookingSettings, bookings, organisations, sites } from '../../db/schema';
import { emailCustomer, type BookingRow } from '../../src/utils/bookings';
import { settingsFromRow } from '../../src/utils/booking-settings';
import { siteOrigin } from '../../src/utils/site-hosting';
import { sweepExpiredHolds } from '../../src/utils/booking-deposits';

const BATCH = 200;

export async function sendDueReminders(db: ReturnType<typeof getDb>, now: Date): Promise<number> {
    const soon = new Date(now.getTime() + 24 * 3600_000);
    const due = await db.select().from(bookings).where(and(
        eq(bookings.status, 'confirmed'), isNull(bookings.reminderSentAt),
        gt(bookings.startsAt, now), lte(bookings.startsAt, soon),
        sql`${bookings.createdAt} < ${bookings.startsAt} - interval '24 hours'`,
    )).limit(BATCH);
    if (!due.length) return 0;
    const orgIds = [...new Set(due.map((b) => b.organisationId))];
    const siteIds = [...new Set(due.map((b) => b.siteId).filter((x): x is number => x !== null))];
    const [settingsRows, orgRows, siteRows] = await Promise.all([
        db.select().from(bookingSettings).where(inArray(bookingSettings.organisationId, orgIds)),
        db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, orgIds)),
        siteIds.length ? db.select({ id: sites.id, slug: sites.slug, status: sites.status, aiAssistantId: sites.aiAssistantId }).from(sites).where(inArray(sites.id, siteIds)) : Promise.resolve([]),
    ]);
    let sent = 0;
    for (const b of due) {
        // Claim it first, so two overlapping runs cannot both send.
        const [claimed] = await db.update(bookings).set({ reminderSentAt: new Date() })
            .where(and(eq(bookings.id, b.id), isNull(bookings.reminderSentAt))).returning({ id: bookings.id });
        if (!claimed) continue;
        const settings = settingsFromRow(settingsRows.find((r) => r.organisationId === b.organisationId) as Record<string, unknown> | undefined);
        const site = siteRows.find((s) => s.id === b.siteId);
        await emailCustomer(b as BookingRow, 'reminder', {
            business: orgRows.find((o) => o.id === b.organisationId)?.name || 'Your booking',
            timezone: settings.timezone, assistantId: site?.aiAssistantId ?? null, cancellationPolicy: settings.cancellationPolicy,
            siteOrigin: site?.slug && site.status === 'published' ? siteOrigin(site.slug) : null,
        }, null);
        sent++;
    }
    return sent;
}

export default withLambda(async () => {
    try {
        // Unpaid deposit holds past their time (booking-deposits.ts) — they already stopped counting.
        const lapsed = await sweepExpiredHolds(getDb(), new Date()).catch((err) => { console.error('[send-booking-reminders] hold sweep failed', err); return 0; });
        if (lapsed) console.log(`[send-booking-reminders] released ${lapsed} unpaid holds`);
        const sent = await sendDueReminders(getDb(), new Date());
        if (sent) console.log(`[send-booking-reminders] sent ${sent}`);
        return { statusCode: 200, body: JSON.stringify({ sent }) };
    } catch (err) {
        console.error('[send-booking-reminders] failed', err instanceof Error ? err.message : err);
        return { statusCode: 500, body: 'failed' };
    }
});
