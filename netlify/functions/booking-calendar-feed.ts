// netlify/functions/booking-calendar-feed.ts — the owner's private bookings calendar.
// GET /api/bookings/calendar.ics?t=<token>   (src/utils/booking-calendar-feed.ts; docs/booking-plan.md phase 3)
//
// No session: calendar apps fetch it on their own. The 32-hex token is the key, checked before any
// customer data is read; a wrong or reset token gets a 404 with nothing in it.

import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { bookingSettings, bookings, classSessions, organisations } from '../../db/schema';
import { buildOwnerFeed, FEED_TOKEN_RE } from '../../src/utils/booking-calendar-feed';
import { describeBooking } from '../../src/utils/bookings';
import { settingsFromRow } from '../../src/utils/booking-settings';

type Res = { statusCode: number; headers?: Record<string, string>; body: string };
const notFound = (): Res => ({ statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: 'Not found' });

export default withLambda(async (event): Promise<Res> => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return { statusCode: 405, body: 'Method Not Allowed' };
    const token = String(event.queryStringParameters?.t || '');
    if (!FEED_TOKEN_RE.test(token)) return notFound();
    try {
        const db = getDb();
        const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.calendarFeedToken, token)).limit(1);
        if (!row) return notFound();
        const orgId = row.organisationId;
        const st = settingsFromRow(row as Record<string, unknown>);
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 86_400_000);
        const to = new Date(now.getTime() + (st.maxAdvanceDays + 30) * 86_400_000);
        const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const rows = await db.select().from(bookings)
            .where(and(eq(bookings.organisationId, orgId), gte(bookings.startsAt, from), lte(bookings.startsAt, to), inArray(bookings.status, ['pending', 'confirmed', 'cancelled'])))
            .orderBy(asc(bookings.startsAt)).limit(3000);
        const sessions = await db.select().from(classSessions)
            .where(and(eq(classSessions.organisationId, orgId), gte(classSessions.startsAt, from), lte(classSessions.startsAt, to))).orderBy(asc(classSessions.startsAt)).limit(1000);
        // Cancelled bookings stay for two weeks after being cancelled, so a calendar removes them; then drop out.
        const recent = new Date(now.getTime() - 14 * 86_400_000);
        const body = buildOwnerFeed({
            business: org?.name || 'Your business', now,
            bookings: rows.filter((b) => b.status !== 'cancelled' || (b.decidedAt && new Date(b.decidedAt) > recent)).filter((b) => b.paymentStatus !== 'expired').map((b) => ({
                id: b.id, kind: b.kind, status: b.status, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), what: describeBooking(b, st.timezone).what,
                customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone, notes: b.notes, partySize: b.partySize,
                depositPence: b.depositPence, paymentStatus: b.paymentStatus,
            })),
            sessions: sessions.map((s) => {
                const people = rows.filter((b) => b.sessionId === s.id && (b.status === 'pending' || b.status === 'confirmed'));
                return {
                    id: s.id, title: s.title, status: s.status, startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), resourceName: s.resourceName, capacity: s.capacity,
                    taken: people.reduce((n, b) => n + b.partySize, 0), people: people.map((b) => `${b.customerName}${b.partySize > 1 ? ` ×${b.partySize}` : ''}`),
                };
            }),
        });
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex', 'Content-Disposition': 'inline; filename="bookings.ics"' },
            body: event.httpMethod === 'HEAD' ? '' : body,
        };
    } catch (err) {
        console.error('[booking-calendar-feed] failed', err instanceof Error ? err.message : err);
        return { statusCode: 503, headers: { 'Retry-After': '300' }, body: 'Try again shortly.' };
    }
});
