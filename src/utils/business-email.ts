// src/utils/business-email.ts — an email FROM the business TO its customer (booking confirmations, stay emails, deposit
// and balance receipts), sent only from the owner's own address: their verified sending domain, else their connected
// Gmail or Outlook (Email Marketing's resolveSendRoute). Never "via Be More Swan" (owner 2026-11-27). With neither
// connected it is NOT sent; the caller tells the owner (bookingEmailLine / bookingEmailsBlocked).
// tests/booking-emails-own-address.test.ts.

import type { getDb } from '../../db/client';
import { htmlToPlainText } from './email-template';
import { resolveSendRoute } from './newsletter-send';
import { deliverStep } from './newsletter-sequence';

type Db = ReturnType<typeof getDb>;

export type BusinessEmailResult = 'sent' | 'no_route' | 'failed';
export interface BusinessEmail {
    business: string;
    to: string;
    subject: string;
    html: string;
    /** Where replies go when the sending domain names no reply-to of its own (usually the owner). */
    replyTo?: string | null;
    attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}
export interface BusinessEmailDeps { resolveRoute?: typeof resolveSendRoute; deliver?: typeof deliverStep }

/** Send one customer email from the business's own address. Never throws. */
export async function sendBusinessEmail(db: Db, orgId: number, m: BusinessEmail, deps: BusinessEmailDeps = {}): Promise<BusinessEmailResult> {
    const to = m.to.replace(/[\r\n,;]/g, '').trim();
    if (!to) return 'failed';
    try {
        const routed = await (deps.resolveRoute ?? resolveSendRoute)(db, orgId, { recipientCount: 1, senderName: (m.business || 'Your booking').slice(0, 60) });
        if ('error' in routed) return 'no_route';
        const route = { ...routed.route, replyTo: routed.route.replyTo || m.replyTo || null };
        await (deps.deliver ?? deliverStep)(db, route, orgId, {
            to, subject: m.subject, html: m.html, text: htmlToPlainText(m.html), listUnsubscribe: null,
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        });
        return 'sent';
    } catch (err) {
        console.error('[business-email] not sent', { orgId, message: err instanceof Error ? err.message : String(err) });
        return 'failed';
    }
}

/** The owner's line when the customer wasn't emailed; null when it went. Pure. */
export function bookingEmailLine(r: BusinessEmailResult, what = 'confirmation'): string | null {
    if (r === 'no_route') return `Your customer was NOT sent their booking ${what}: booking emails go only from your own address, and none is set up. Please email them yourself. Verify a sending domain or connect your Gmail or Outlook in Email Studio ▸ Sending so future customers get it by themselves.`;
    if (r === 'failed') return `Your customer's booking ${what} couldn't be sent from your email account. Please email them yourself.`;
    return null;
}

/** The Bookings tab's warning: there is no own address, so customers get no booking emails. null = fine or unknown. */
export async function bookingEmailsBlocked(db: Db, orgId: number, route: typeof resolveSendRoute = resolveSendRoute): Promise<string | null> {
    try {
        const r = await route(db, orgId, { recipientCount: 1, senderName: 'Your booking' });
        return 'error' in r ? 'Customers get no booking emails (confirmations, reminders, cancellations): they go only from your own address, and none is set up. Verify a sending domain or connect your Gmail or Outlook in Email Studio ▸ Sending.' : null;
    } catch (err) {
        console.error('[business-email] route check failed', err instanceof Error ? err.message : err);
        return null;
    }
}
