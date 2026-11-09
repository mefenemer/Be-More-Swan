// src/utils/stay-jobs.ts — the money after a stay is booked, run hourly (send-booking-reminders.ts).
// docs/holiday-lets-plan.md §5. tests/stay-jobs.test.ts.
//
//   1. The balance, on its due date (confirmed stays only — a request the owner hasn't accepted is
//      never charged): the owner's choice, copied onto the booking when it was made —
//        auto → charge the card saved at booking; if it fails, fall back to 2 and tell the owner;
//        link → email the guest a link to pay (a page on the site that opens Stripe when they press Pay).
//      3 days later, still unpaid: the guest is reminded. 6 days after the first email: the owner is told.
//      Nothing is ever cancelled automatically — what to do about an unpaid balance is the owner's call.
//   3. Arrival details, `arrival_details_days` before check-in (confirmed stays): check-in and check-out
//      times, the address, the room(s), house rules and the owner's private arrival details (key code,
//      Wi-Fi). Held back while a balance is still unpaid — a door code never goes to a guest who hasn't
//      paid — and sent within the hour once it is. Marked with bookings.reminder_sent_at, which stays
//      never otherwise use (the day-before reminder leaves them out), so no new column.
//   2. The damage deposit, after check-out: the owner is reminded the day before it goes back; on its
//      return date it goes back in full by itself. Keeping part is only ever the owner's click
//      (sites.ts damage_keep) — a guest's money is never kept because nobody decided.
//
// Every step claims its row first (a timestamp set only where it is still empty), so two overlapping
// runs can't email or charge twice. Not AI work: no tasks.

import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookings, organisations, sites, stayTypes } from '../../db/schema';
import { addDays, formatDate, formatTime } from './booking-time';
import { describeBooking, fromLine, ownerOf, type BookingRow } from './bookings';
import { createNotification } from './notify';
import { sendEmail } from './email';
import { esc, BOOK_PATH } from './site-render';
import { siteOrigin } from './site-hosting';
import { signBookingId } from './booking-links';
import { formatMoney } from './product-price';
import { balanceCharge, chargeBalanceOffSession, settleDamageDeposit } from './stay-charges';

type Db = ReturnType<typeof getDb>;
const BATCH = 100;
const DAY = 86_400_000;

/** The guest's link to pay the balance — a page on the business's site (the manage link's signature). */
export const balancePayUrl = (origin: string, id: number) => `${origin}${BOOK_PATH}?pay=${id}&t=${signBookingId(id)}`;

interface Who { business: string; origin: string | null; assistantId: number | null; }

async function whoFor(db: Db, b: BookingRow): Promise<Who> {
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, b.organisationId)).limit(1);
    const [site] = b.siteId ? await db.select({ slug: sites.slug, aiAssistantId: sites.aiAssistantId }).from(sites).where(eq(sites.id, b.siteId)).limit(1) : [];
    return { business: org?.name || 'Your stay', origin: site?.slug ? siteOrigin(site.slug) : null, assistantId: site?.aiAssistantId ?? null };
}

async function tellOwner(db: Db, b: BookingRow, who: Who, change: string, next: string, emailHtml: string, subject: string): Promise<void> {
    const owner = await ownerOf(db, who.assistantId);
    if (!owner) return;
    await createNotification(db, 'site_booking_changed', {
        userId: owner.userId, assistantId: who.assistantId ?? undefined, category: 'suggested_action',
        context: { assistant: { name: owner.name }, booking: { who: b.customerName, change, next } },
        metadata: { assistantId: who.assistantId, bookingId: b.id },
    }).catch((err) => console.error('[stay-jobs] owner notification failed', err));
    if (owner.email) {
        await sendEmail({ to: owner.email, replyTo: b.customerEmail, subject, html: emailHtml })
            .catch((err: unknown) => console.error('[stay-jobs] owner email failed', err instanceof Error ? err.message : err));
    }
}

const guestEmail = (b: BookingRow, who: Who, subject: string, html: string) => sendEmail({ to: b.customerEmail, from: fromLine(who.business), subject, html })
    .catch((err: unknown) => console.error('[stay-jobs] guest email failed', err instanceof Error ? err.message : err));

/** The email with the pay link (first ask, reminder, or after a card failed). */
export function payLinkEmail(b: BookingRow, who: Who, kind: 'first' | 'reminder' | 'card_failed'): { subject: string; html: string } {
    const { what, when } = describeBooking(b, 'UTC');
    const c = balanceCharge(b);
    const m = (n: number) => formatMoney(n, b.currency || 'GBP');
    const link = who.origin ? balancePayUrl(who.origin, b.id) : null;
    const due = b.balanceDueOn ? formatDate(b.balanceDueOn) : 'now';
    const lead = {
        first: `Your remaining balance of <strong>${esc(m(c.balance))}</strong> for <strong>${esc(what)}</strong>, ${esc(when)}, is due by <strong>${esc(due)}</strong>.`,
        reminder: `A reminder: your remaining balance of <strong>${esc(m(c.balance))}</strong> for <strong>${esc(what)}</strong>, ${esc(when)}, hasn't been paid yet.`,
        card_failed: `We couldn't take your remaining balance of <strong>${esc(m(c.balance))}</strong> for <strong>${esc(what)}</strong>, ${esc(when)}, from your card — it may need your bank's approval, or it may have expired.`,
    }[kind];
    const damage = c.damage ? `<p>This includes a refundable damage deposit of ${esc(m(c.damage))}, returned after your stay.</p>` : '';
    return {
        subject: kind === 'reminder' ? `Reminder: your balance for ${what} — ${who.business}` : `Your balance for ${what} — ${who.business}`,
        html: `<p>Hi ${esc(b.customerName)},</p><p>${lead}</p>${damage}${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#111827;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Pay ${esc(m(c.total))}</a></p>` : '<p>Reply to this email and we\'ll tell you how to pay.</p>'}<p>Any questions, just reply to this email.</p>`,
    };
}

/** 1. Balances due today or earlier on confirmed stays that haven't been asked for yet. */
export async function collectDueBalances(db: Db, now: Date): Promise<number> {
    const today = now.toISOString().slice(0, 10);
    const due = await db.select().from(bookings).where(and(
        eq(bookings.kind, 'stay'), eq(bookings.status, 'confirmed'), eq(bookings.balanceStatus, 'due'),
        lte(bookings.balanceDueOn, today), isNull(bookings.balanceRequestedAt),
    )).limit(BATCH);
    let done = 0;
    for (const b0 of due) {
        const [b] = await db.update(bookings).set({ balanceRequestedAt: now })
            .where(and(eq(bookings.id, b0.id), isNull(bookings.balanceRequestedAt), eq(bookings.balanceStatus, 'due'))).returning();
        if (!b) continue;
        const who = await whoFor(db, b);
        const { what, when } = describeBooking(b, 'UTC');
        const m = (n: number) => formatMoney(n, b.currency || 'GBP');
        if (b.balanceCollection === 'auto') {
            const r = await chargeBalanceOffSession(db, b);
            if (r.ok) {
                const c = balanceCharge(b);
                await guestEmail(r.booking, who, `Balance paid — ${who.business}`,
                    `<p>Hi ${esc(b.customerName)},</p><p>We've taken your remaining balance of <strong>${esc(m(c.balance))}</strong> for <strong>${esc(what)}</strong>, ${esc(when)}, from your card${c.damage ? `, with the refundable damage deposit of ${esc(m(c.damage))}` : ''}. You're all paid up — thank you.</p>`);
                done++;
                continue;
            }
            await db.update(bookings).set({ balanceStatus: 'failed' }).where(eq(bookings.id, b.id));
            const mail = payLinkEmail(b, who, 'card_failed');
            await guestEmail(b, who, mail.subject, mail.html);
            await tellOwner(db, b, who, `couldn't be charged the ${m(b.balancePence ?? 0)} balance for ${when}`,
                'We emailed them a link to pay. Get in touch with them if it stays unpaid.',
                `<p>We couldn't take the <strong>${esc(m(b.balancePence ?? 0))}</strong> balance for <strong>${esc(what)}</strong>, ${esc(when)}, from <strong>${esc(b.customerName)}</strong>'s card (${esc(r.reason)}).</p><p>We've emailed them a link to pay. Reply to this email to write to them.</p>`,
                `Balance not paid: ${b.customerName}, ${when}`);
            done++;
            continue;
        }
        const mail = payLinkEmail(b, who, 'first');
        await guestEmail(b, who, mail.subject, mail.html);
        done++;
    }
    return done;
}

/** 1b. Still unpaid: remind the guest after 3 days, tell the owner after 6. */
export async function chaseUnpaidBalances(db: Db, now: Date): Promise<number> {
    const threeDays = new Date(now.getTime() - 3 * DAY);
    const sixDays = new Date(now.getTime() - 6 * DAY);
    const rows = await db.select().from(bookings).where(and(
        eq(bookings.kind, 'stay'), eq(bookings.status, 'confirmed'), inArray(bookings.balanceStatus, ['due', 'failed']),
        lte(bookings.balanceRequestedAt, threeDays),
        // An ISO string, never a Date: postgres-js can't bind a Date inside raw sql (raw-sql-date-params test).
        sql`(${bookings.balanceRemindedAt} IS NULL OR (${bookings.balanceOwnerToldAt} IS NULL AND ${bookings.balanceRequestedAt} <= ${sixDays.toISOString()}::timestamptz))`,
    )).limit(BATCH);
    let done = 0;
    for (const b0 of rows) {
        const who = await whoFor(db, b0);
        if (!b0.balanceRemindedAt) {
            const [b] = await db.update(bookings).set({ balanceRemindedAt: now }).where(and(eq(bookings.id, b0.id), isNull(bookings.balanceRemindedAt))).returning();
            if (!b) continue;
            const mail = payLinkEmail(b, who, 'reminder');
            await guestEmail(b, who, mail.subject, mail.html);
            done++;
        } else if (b0.balanceRequestedAt && b0.balanceRequestedAt <= sixDays) {
            const [b] = await db.update(bookings).set({ balanceOwnerToldAt: now }).where(and(eq(bookings.id, b0.id), isNull(bookings.balanceOwnerToldAt))).returning();
            if (!b) continue;
            const { what, when } = describeBooking(b, 'UTC');
            const m = formatMoney(b.balancePence ?? 0, b.currency || 'GBP');
            await tellOwner(db, b, who, `hasn't paid the ${m} balance for ${when}`, 'We\'ve emailed them twice. Get in touch with them — the booking stays as it is until you decide.',
                `<p><strong>${esc(b.customerName)}</strong> hasn't paid the <strong>${esc(m)}</strong> balance for <strong>${esc(what)}</strong>, ${esc(when)}. We've sent them the payment link twice.</p><p>Their arrival details (key code, Wi-Fi) are held back until it's paid. The booking stays as it is — nothing is cancelled automatically. Reply to this email to write to them, or cancel it on your Website Assistant's Bookings tab.</p>`,
                `Balance still unpaid: ${b.customerName}, ${when}`);
            done++;
        }
    }
    return done;
}

/** What a stay's arrival email says — pure, for tests. The arrival details are the owner's own words, escaped. */
export function arrivalEmail(b: BookingRow, stay: { name: string; checkInTime: string; checkOutTime: string; address: string | null; houseRules: string | null; arrivalDetails: string | null; stayType: string }, business: string): { subject: string; html: string } {
    const lines = (t: string) => esc(t).replace(/\r?\n/g, '<br>');
    const nights = b.checkIn && b.checkOut ? Math.round((Date.parse(`${b.checkOut}T00:00:00Z`) - Date.parse(`${b.checkIn}T00:00:00Z`)) / DAY) : null;
    const room = stay.stayType === 'room' && b.resourceName ? `<p><strong>Your room${(b.rooms ?? 1) > 1 ? 's' : ''}:</strong> ${esc(b.resourceName)}</p>` : '';
    return {
        subject: `Your arrival details — ${stay.name}`,
        html: `<p>Hi ${esc(b.customerName)},</p>
<p>We're looking forward to welcoming you to <strong>${esc(stay.name)}</strong>${b.checkIn ? ` on <strong>${esc(formatDate(b.checkIn))}</strong>` : ''}${nights ? ` for ${nights} night${nights === 1 ? '' : 's'}` : ''}.</p>
<p><strong>Check-in:</strong> from ${esc(formatTime(stay.checkInTime))}${b.checkIn ? ` on ${esc(formatDate(b.checkIn))}` : ''}<br><strong>Check-out:</strong> by ${esc(formatTime(stay.checkOutTime))}${b.checkOut ? ` on ${esc(formatDate(b.checkOut))}` : ''}</p>
${room}${stay.address ? `<p><strong>Address:</strong><br>${lines(stay.address)}</p>` : ''}
${stay.arrivalDetails ? `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:12px 0"><p style="margin:0 0 6px"><strong>Getting in</strong></p><p style="margin:0">${lines(stay.arrivalDetails)}</p></div><p style="font-size:13px;color:#6b7280">Please keep these details to yourself.</p>` : ''}
${stay.houseRules ? `<p><strong>House rules:</strong><br>${lines(stay.houseRules)}</p>` : ''}
<p>Any questions before you arrive, just reply to this email.</p><p>${esc(business)}</p>`,
    };
}

/** 3. Arrival details, N days before check-in, once anything owed is paid. */
export async function sendArrivalDetails(db: Db, now: Date): Promise<number> {
    const today = now.toISOString().slice(0, 10);
    const rows = await db.select({ b: bookings, stay: stayTypes }).from(bookings).innerJoin(stayTypes, eq(stayTypes.id, bookings.stayTypeId)).where(and(
        eq(bookings.kind, 'stay'), eq(bookings.status, 'confirmed'), isNull(bookings.reminderSentAt),
        // Not after they've arrived; and only from N days before (a date minus whole days — no timezone involved).
        sql`${bookings.checkIn} >= ${today}::date`, sql`${bookings.checkIn} - ${stayTypes.arrivalDetailsDays} <= ${today}::date`,
        // Never a door code to a guest who still owes the balance.
        sql`coalesce(${bookings.balanceStatus}, 'none') NOT IN ('due', 'failed')`,
    )).limit(BATCH);
    let sent = 0;
    for (const { b: b0, stay } of rows) {
        const [b] = await db.update(bookings).set({ reminderSentAt: now }).where(and(eq(bookings.id, b0.id), isNull(bookings.reminderSentAt))).returning();
        if (!b) continue;
        const who = await whoFor(db, b);
        const owner = await ownerOf(db, who.assistantId);
        const mail = arrivalEmail(b, stay, who.business);
        await sendEmail({ to: b.customerEmail, from: fromLine(who.business), ...(owner?.email ? { replyTo: owner.email } : {}), subject: mail.subject, html: mail.html })
            .catch((err: unknown) => console.error('[stay-jobs] arrival email failed', err instanceof Error ? err.message : err));
        sent++;
    }
    return sent;
}

/** 2a. The day before a damage deposit goes back by itself: remind the owner, once. */
export async function remindDamageReturns(db: Db, now: Date): Promise<number> {
    const tomorrow = addDays(now.toISOString().slice(0, 10), 1);
    const rows = await db.select().from(bookings).where(and(
        eq(bookings.kind, 'stay'), eq(bookings.damageDepositStatus, 'held'), lte(bookings.damageDepositReturnOn, tomorrow),
        isNull(bookings.damageRemindedAt), isNull(bookings.damageDecidedAt),
    )).limit(BATCH);
    let done = 0;
    for (const b0 of rows) {
        const [b] = await db.update(bookings).set({ damageRemindedAt: now }).where(and(eq(bookings.id, b0.id), isNull(bookings.damageRemindedAt))).returning();
        if (!b) continue;
        const who = await whoFor(db, b);
        const { what, when } = describeBooking(b, 'UTC');
        const m = formatMoney(b.damageDepositPence ?? 0, b.currency || 'GBP');
        await tellOwner(db, b, who, `gets their ${m} damage deposit back tomorrow (${when})`, 'To keep part of it for damage, choose "Keep part" on the Bookings tab today.',
            `<p>The <strong>${esc(m)}</strong> damage deposit for <strong>${esc(b.customerName)}</strong>'s stay at <strong>${esc(what)}</strong>, ${esc(when)}, goes back to them in full tomorrow.</p><p>If something was damaged, choose <strong>Keep part</strong> on your Website Assistant's Bookings tab today and say why — they're sent your reason.</p>`,
            `Damage deposit returns tomorrow: ${b.customerName}`);
        done++;
    }
    return done;
}

/** 2b. Return date reached and the owner hasn't decided: it all goes back. */
export async function returnDueDamageDeposits(db: Db, now: Date): Promise<number> {
    const today = now.toISOString().slice(0, 10);
    const rows = await db.select().from(bookings).where(and(
        eq(bookings.kind, 'stay'), eq(bookings.damageDepositStatus, 'held'), lte(bookings.damageDepositReturnOn, today), isNull(bookings.damageDecidedAt),
    )).limit(BATCH);
    let done = 0;
    for (const b of rows) {
        const r = await settleDamageDeposit(db, b, 0, null);
        if (r === 'none') continue;
        const who = await whoFor(db, b);
        await damageEmail(b, who, r === 'returned' ? 0 : null, null);
        done++;
    }
    return done;
}

/** The guest hears what happened to their damage deposit. `keep` null = the refund failed (the business will sort it). */
export async function damageEmail(b: BookingRow, who: Who, keep: number | null, reason: string | null): Promise<void> {
    const { what } = describeBooking(b, 'UTC');
    const held = b.damageDepositPence ?? 0;
    const m = (n: number) => formatMoney(n, b.currency || 'GBP');
    const html = keep === null
        ? `<p>Hi ${esc(b.customerName)},</p><p>${esc(who.business)} will return your ${esc(m(held))} damage deposit for ${esc(what)} shortly.</p>`
        : keep === 0
            ? `<p>Hi ${esc(b.customerName)},</p><p>Thanks for staying at ${esc(what)}. Your <strong>${esc(m(held))}</strong> damage deposit is on its way back to your card — it usually arrives within 5–10 days.</p>`
            : `<p>Hi ${esc(b.customerName)},</p><p>Thanks for staying at ${esc(what)}. We've returned <strong>${esc(m(held - keep))}</strong> of your ${esc(m(held))} damage deposit to your card, and kept <strong>${esc(m(keep))}</strong>.</p><p><strong>Why:</strong> ${esc(reason || '')}</p><p>If you'd like to talk about it, reply to this email.</p>`;
    await guestEmail(b, who, keep && keep > 0 ? `About your damage deposit — ${who.business}` : `Your damage deposit is on its way back — ${who.business}`, html);
}

/** Everything above, for the hourly run. Each part's failure is logged and never stops the others. */
export async function runStayMoneyJobs(db: Db, now: Date): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [name, job] of [
        ['balancesAsked', collectDueBalances], ['balancesChased', chaseUnpaidBalances],
        ['damageReminders', remindDamageReturns], ['damageReturned', returnDueDamageDeposits], ['arrivalSent', sendArrivalDetails],
    ] as const) {
        try { out[name] = await job(db, now); }
        catch (err) { console.error(`[stay-jobs] ${name} failed`, err instanceof Error ? err.message : err); out[name] = 0; }
    }
    return out;
}

export { whoFor };
