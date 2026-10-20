// src/utils/email-delivery.ts
// What Resend did with OUR transactional mail (login links, verification, notifications) after it
// accepted it — and the one answer an admin needs: "why isn't this person getting our email?"
//
// ⚠️ A SUPPRESSED SEND LOOKS LIKE A SUCCESS. Resend accepts a send to an address on its suppression
// list, returns an id, and then drops the message. `sendEmail` cannot see that; only the webhook
// event (email.suppressed) can. On 2026-10-20 a user had received nothing — login links included —
// for weeks, and the only record was in the Resend dashboard. This module is that record.
//
// ⚠️ A DELIVERY AFTER A PROBLEM CLEARS IT. Once an admin removes a suppression, the next delivered
// event is proof the address works again, so the status reads from the NEWEST event, not the worst.
//
// Every function that touches the table tolerates it not existing (db/z-email-delivery-events.sql is
// applied by hand): the webhook must never 500 because of this, and the user panel must still open.

import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { emailDeliveryEvents, users } from '../../db/schema';
import { normaliseEmail } from './audience-contacts';

export type DeliveryEventType = 'delivered' | 'bounced' | 'soft_bounced' | 'complained' | 'suppressed' | 'failed';

/** Events that mean the person is NOT getting our mail. A soft bounce is a full mailbox, not this. */
export const PROBLEM_TYPES: ReadonlySet<DeliveryEventType> = new Set(['bounced', 'complained', 'suppressed', 'failed']);

/** Same rule as newsletter-webhook: an undetermined bounce is treated as permanent. */
const HARD_BOUNCE_TYPES = new Set(['hard', 'permanent', 'undetermined']);

export interface ClassifiedEvent {
    eventType: DeliveryEventType;
    email: string;
    providerMessageId: string;
    subject: string | null;
    reason: string | null;
    occurredAt: Date;
}

const clip = (s: unknown, n = 500): string | null => {
    const v = typeof s === 'string' ? s.trim() : '';
    return v ? v.slice(0, n) : null;
};

/**
 * Map a Resend webhook payload to a row, or null when it is not an event we record (opens, clicks,
 * delays, sends, anything without a message id or recipient). Pure — the webhook and tests share it.
 */
export function classifyResendEvent(payload: any): ClassifiedEvent | null {
    const type = String(payload?.type || '');
    const data = payload?.data ?? {};
    const providerMessageId = String(data?.email_id || data?.id || '');
    const email = normaliseEmail(Array.isArray(data?.to) ? data.to[0] : data?.to);
    if (!providerMessageId || !email) return null;

    let eventType: DeliveryEventType;
    let reason: string | null = null;
    switch (type) {
        case 'email.delivered':
            eventType = 'delivered';
            break;
        case 'email.bounced': {
            const kind = String(data?.bounce?.type || '').toLowerCase();
            eventType = !kind || HARD_BOUNCE_TYPES.has(kind) ? 'bounced' : 'soft_bounced';
            reason = clip([data?.bounce?.type, data?.bounce?.subType, data?.bounce?.message].filter(Boolean).join(' — '));
            break;
        }
        case 'email.complained':
            eventType = 'complained';
            reason = 'Recipient marked the email as spam';
            break;
        case 'email.suppressed':
            eventType = 'suppressed';
            reason = clip([data?.suppressed?.type, data?.suppressed?.message].filter(Boolean).join(' — '))
                ?? 'Address is on the Resend suppression list';
            break;
        case 'email.failed':
            eventType = 'failed';
            reason = clip(data?.failed?.reason ?? data?.failed?.message ?? data?.reason);
            break;
        default:
            return null;
    }

    const when = new Date(payload?.created_at || data?.created_at || Date.now());
    return {
        eventType,
        email,
        providerMessageId,
        subject: clip(data?.subject, 300),
        reason,
        occurredAt: Number.isNaN(when.getTime()) ? new Date() : when,
    };
}

const isMissingTable = (err: any) => {
    const msg = String(err?.message || '');
    return err?.code === '42P01' || (msg.includes('relation') && msg.includes('does not exist'));
};

/** Store one event. Webhook retries are no-ops (unique message+event). Never throws. */
export async function recordDeliveryEvent(db: any, ev: ClassifiedEvent): Promise<boolean> {
    try {
        await db.insert(emailDeliveryEvents).values(ev).onConflictDoNothing();
        return true;
    } catch (err: any) {
        if (!isMissingTable(err)) console.error('[email-delivery] could not record event:', err?.message);
        return false;
    }
}

export type DeliveryStatus = 'ok' | 'no_data' | 'suppressed' | 'bounced' | 'complained' | 'failed';

export interface DeliveryEventRow {
    eventType: string;
    subject: string | null;
    reason: string | null;
    occurredAt: Date | string;
}

export interface DeliverySummary {
    status: DeliveryStatus;
    /** The event behind a problem status; for 'ok', the last problem a later delivery cleared. */
    problem: DeliveryEventRow | null;
    lastDeliveredAt: Date | string | null;
    /** Plain-English next step for the admin; null when there is nothing to do. */
    advice: string | null;
}

const ADVICE: Record<Exclude<DeliveryStatus, 'ok' | 'no_data'>, string> = {
    suppressed: 'Resend is dropping every email to this address (login links included) because of an earlier bounce or spam complaint. Remove the address in Resend → Suppressions, ask the user to check spam, then send a login link.',
    bounced: 'Their mail server permanently rejected our email, so Resend will suppress further sends. Confirm the address with the user; if it is right, ask them to check with their IT, then remove the suppression in Resend.',
    complained: 'The user marked one of our emails as spam, so Resend suppresses everything to them. Ask them to mark noreply@bemoreswan.com as safe, then remove the suppression in Resend.',
    failed: 'Resend could not send the email at all — see the reason. This is usually on our side (sending domain or API key).',
};

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

/** Status from events of ONE address, any order. The newest of (problem, delivery) wins. */
export function summariseDelivery(events: DeliveryEventRow[]): DeliverySummary {
    const sorted = [...events].sort((a, b) => time(b.occurredAt) - time(a.occurredAt));
    const problem = sorted.find((e) => PROBLEM_TYPES.has(e.eventType as DeliveryEventType)) ?? null;
    const delivered = sorted.find((e) => e.eventType === 'delivered') ?? null;
    const lastDeliveredAt = delivered?.occurredAt ?? null;

    if (!problem) return { status: sorted.length ? 'ok' : 'no_data', problem: null, lastDeliveredAt, advice: null };
    if (delivered && time(delivered.occurredAt) > time(problem.occurredAt)) {
        return { status: 'ok', problem, lastDeliveredAt, advice: null };
    }
    const status = problem.eventType as Exclude<DeliveryStatus, 'ok' | 'no_data'>;
    return { status, problem, lastDeliveredAt, advice: ADVICE[status] };
}

export interface DeliveryReport extends DeliverySummary {
    /** False when the table is not migrated yet — the panel says so instead of "no data". */
    tracked: boolean;
    recent: DeliveryEventRow[];
}

/** Everything the admin user panel shows for one address. Never throws. */
export async function loadDeliveryReport(db: any, rawEmail: string | null | undefined): Promise<DeliveryReport> {
    const email = normaliseEmail(rawEmail);
    const empty: DeliveryReport = { ...summariseDelivery([]), tracked: true, recent: [] };
    if (!email) return empty;
    try {
        const recent: DeliveryEventRow[] = await db.select({
            eventType: emailDeliveryEvents.eventType,
            subject: emailDeliveryEvents.subject,
            reason: emailDeliveryEvents.reason,
            occurredAt: emailDeliveryEvents.occurredAt,
        }).from(emailDeliveryEvents)
            .where(eq(emailDeliveryEvents.email, email))
            .orderBy(desc(emailDeliveryEvents.occurredAt))
            .limit(25);
        return { ...summariseDelivery(recent), tracked: true, recent };
    } catch (err: any) {
        if (!isMissingTable(err)) console.error('[email-delivery] report failed:', err?.message);
        return { ...empty, tracked: isMissingTable(err) ? false : true };
    }
}

export interface DeliveryProblem {
    email: string;
    status: DeliveryStatus;
    problem: DeliveryEventRow;
    advice: string | null;
    userId: number | null;
    userName: string | null;
}

/**
 * Addresses whose NEWEST event in the window is a problem — the list on Admin → Users. Addresses with
 * a user account come first; the rest are still shown (an invitee or a mistyped sign-up has no row).
 */
export async function listDeliveryProblems(db: any, { days = 30 }: { days?: number } = {}): Promise<{ tracked: boolean; problems: DeliveryProblem[] }> {
    try {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows: Array<DeliveryEventRow & { email: string }> = await db.select({
            email: emailDeliveryEvents.email,
            eventType: emailDeliveryEvents.eventType,
            subject: emailDeliveryEvents.subject,
            reason: emailDeliveryEvents.reason,
            occurredAt: emailDeliveryEvents.occurredAt,
        }).from(emailDeliveryEvents)
            .where(and(gte(emailDeliveryEvents.occurredAt, since), ne(emailDeliveryEvents.eventType, 'soft_bounced')))
            .orderBy(desc(emailDeliveryEvents.occurredAt))
            .limit(2000);

        const byEmail = new Map<string, DeliveryEventRow[]>();
        for (const r of rows) {
            const list = byEmail.get(r.email) ?? [];
            list.push(r);
            byEmail.set(r.email, list);
        }
        const flagged: Array<{ email: string; summary: DeliverySummary }> = [];
        for (const [email, events] of byEmail) {
            const summary = summariseDelivery(events);
            if (summary.status !== 'ok' && summary.status !== 'no_data' && summary.problem) flagged.push({ email, summary });
        }
        if (!flagged.length) return { tracked: true, problems: [] };

        const accounts: Array<{ id: number; email: string; firstName: string | null; lastName: string | null }> = await db
            .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(inArray(users.email, flagged.map((f) => f.email)));
        const accountByEmail = new Map(accounts.map((a) => [normaliseEmail(a.email), a]));

        const problems = flagged.map(({ email, summary }) => {
            const acct = accountByEmail.get(email);
            return {
                email,
                status: summary.status,
                problem: summary.problem!,
                advice: summary.advice,
                userId: acct?.id ?? null,
                userName: acct ? [acct.firstName, acct.lastName].filter(Boolean).join(' ') || null : null,
            };
        });
        problems.sort((a, b) => (a.userId ? 0 : 1) - (b.userId ? 0 : 1) || time(b.problem.occurredAt) - time(a.problem.occurredAt));
        return { tracked: true, problems };
    } catch (err: any) {
        if (!isMissingTable(err)) {
            console.error('[email-delivery] problem list failed:', err?.message);
            throw err;
        }
        return { tracked: false, problems: [] };
    }
}
