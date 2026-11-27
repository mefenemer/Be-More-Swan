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

/** 'slow': the account didn't answer within the budget — it may still go, so a claim is kept and the owner told to check. */
export type BusinessEmailResult = 'sent' | 'no_route' | 'failed' | 'slow';
/** A send may take this long (review #917: a webhook or a visitor's booking must not wait on a slow mailbox). */
export const BUSINESS_EMAIL_BUDGET_MS = 4000;
export interface BusinessEmail {
    business: string;
    to: string;
    subject: string;
    html: string;
    /** Where replies go — the owner, ahead of the sending domain's own reply-to ("reply to this email" to change a booking). */
    replyTo?: string | null;
    attachments?: Array<{ filename: string; content: string; contentType?: string }>;
    /** The plain-text part, when the caller has its own (else derived from the HTML). */
    text?: string;
}
export interface BusinessEmailDeps {
    resolveRoute?: typeof resolveSendRoute; deliver?: typeof deliverStep; budgetMs?: number;
    /** Told how it went out once sent: the provider and its message id (Resend only), e.g. to log a Resend cost. */
    onSent?: (provider: string, id: string | null) => void | Promise<void>;
}

/** Send one customer email from the business's own address. Never throws. */
export async function sendBusinessEmail(db: Db, orgId: number, m: BusinessEmail, deps: BusinessEmailDeps = {}): Promise<BusinessEmailResult> {
    const to = m.to.replace(/[\r\n,;]/g, '').trim();
    if (!to) return 'failed';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const routed = await (deps.resolveRoute ?? resolveSendRoute)(db, orgId, { recipientCount: 1, senderName: (m.business || 'Your booking').slice(0, 60) });
        if ('error' in routed) return 'no_route';
        const route = { ...routed.route, replyTo: m.replyTo || routed.route.replyTo || null };
        const send = (deps.deliver ?? deliverStep)(db, route, orgId, {
            to, subject: m.subject, html: m.html, text: m.text ?? htmlToPlainText(m.html), listUnsubscribe: null,
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        });
        const slow = new Promise<'slow'>((res) => { timer = setTimeout(() => res('slow'), deps.budgetMs ?? BUSINESS_EMAIL_BUDGET_MS); });
        let id: string | null = null;
        const r = await Promise.race([send.then((x) => { id = x ?? null; return 'sent' as const; }), slow]);
        if (r === 'sent' && deps.onSent) await Promise.resolve(deps.onSent(routed.route.provider, id)).catch(() => undefined);
        if (r === 'slow') { send.catch(() => undefined); console.error('[business-email] slow — may still go', { orgId }); }
        return r;
    } catch (err) {
        console.error('[business-email] not sent', { orgId, message: err instanceof Error ? err.message : String(err) });
        return 'failed';
    } finally {
        clearTimeout(timer);
    }
}

/** The owner's line when the customer wasn't emailed; null when it went. Pure. */
export function bookingEmailLine(r: BusinessEmailResult, what = 'confirmation'): string | null {
    if (r === 'no_route') return `Your customer was NOT sent their booking ${what}: booking emails go only from your own address, and none is set up. Please email them yourself. Verify a sending domain or connect your Gmail or Outlook in Email Studio ▸ Sending so future customers get it by themselves.`;
    if (r === 'failed') return `Your customer's booking ${what} couldn't be sent from your email account. Please email them yourself.`;
    if (r === 'slow') return `We couldn't confirm your customer's booking ${what} went: your email account was slow to answer. Check your sent mail, and if it isn't there, email them yourself.`;
    return null;
}

/** The workspaces among these that have their own address to send from (review #917: due work is looked for only
 *  there, so workspaces still waiting for one never fill a batch). A failed check counts as no route. */
export async function orgsWithRoute(db: Db, orgIds: number[], route: typeof resolveSendRoute = resolveSendRoute): Promise<number[]> {
    const out: number[] = [];
    for (const id of [...new Set(orgIds)]) {
        const r = await route(db, id, { recipientCount: 1, senderName: 'Your booking' }).catch(() => ({ error: 'check failed' }));
        if ('route' in r) out.push(id);
    }
    return out;
}

/** Audience ▸ Sign-up forms: a form asks people to confirm by email, but there is no own address to send it from,
 *  so nobody can sign up on it until there is (owner 2026-11-27). null = fine or unknown. Never throws. */
export async function signupConfirmBlocked(db: Db, orgId: number, route: typeof resolveSendRoute = resolveSendRoute): Promise<string | null> {
    try {
        const r = await route(db, orgId, { recipientCount: 1, senderName: 'Your business' });
        return 'error' in r ? 'Nobody can sign up on a form that asks people to confirm by email or gives a free download: those emails go only from your own address, and none is set up. Verify a sending domain or connect your Gmail or Outlook in Email Studio ▸ Sending.' : null;
    } catch (err) {
        console.error('[business-email] route check failed', err instanceof Error ? err.message : err);
        return null;
    }
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
