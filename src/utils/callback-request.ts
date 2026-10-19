// src/utils/callback-request.ts
//
// "Request a call back" (owner, 2026-10-19). A customer who left said it felt like there were no
// humans, only AI — there were, but nothing in the product said so or let them ask for one. Help &
// Support → Contact us (and the assistant chat, which opens the same form) now let a customer ask
// for a phone call. It is a support ticket like any other — category 'callback', priority 'high' —
// so it lands in Admin ▸ Inbox and the business inbox, and the customer can follow it under "Your
// requests". These rules are shared by the server and the tests; the browser repeats only the shape.

export const CALLBACK_CATEGORY = 'callback';

/** When to call, in the customer's own timezone. Keys are what the form sends. */
export const CALLBACK_TIMES = {
    morning: 'Morning (9am–12pm)',
    afternoon: 'Afternoon (12pm–5pm)',
    evening: 'Early evening (5pm–7pm)',
    any: 'Any time in working hours',
} as const;
export type CallbackTime = keyof typeof CALLBACK_TIMES;

export interface CallbackInput { phone?: unknown; bestTime?: unknown; timezone?: unknown; notes?: unknown }
export interface CallbackRequest { phone: string; bestTime: CallbackTime; timezone: string | null; notes: string }

/** An IANA zone Intl accepts, or null — the browser sends it; a bad one is dropped, not refused. */
export function cleanTimezone(tz: unknown): string | null {
    if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return null;
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() }); return tz.trim(); } catch { return null; }
}

/**
 * A phone number someone could dial: digits with the usual separators, an optional leading +,
 * 7–15 digits (E.164 allows 15). Returned as typed, tidied of repeated spaces.
 */
export function cleanPhone(phone: unknown): string | null {
    if (typeof phone !== 'string') return null;
    const p = phone.trim().replace(/\s+/g, ' ');
    if (!/^\+?[\d\s().-]+$/.test(p)) return null;
    const digits = p.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? p : null;
}

export function validateCallback(input: CallbackInput): { ok: true; value: CallbackRequest } | { ok: false; error: string } {
    const phone = cleanPhone(input.phone);
    if (!phone) return { ok: false, error: 'Please give a phone number we can call, including the country code if you are outside the UK.' };
    const bestTime = (typeof input.bestTime === 'string' && input.bestTime in CALLBACK_TIMES ? input.bestTime : 'any') as CallbackTime;
    const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
    return { ok: true, value: { phone, bestTime, timezone: cleanTimezone(input.timezone), notes } };
}

/** "Afternoon (12pm–5pm), their time: America/New_York" */
export function whenLine(r: CallbackRequest): string {
    return `${CALLBACK_TIMES[r.bestTime]}${r.timezone ? `, their time (${r.timezone})` : ''}`;
}

/** The ticket the request becomes. The subject reads as a call-back at a glance in the Inbox. */
export function callbackTicket(r: CallbackRequest): { subject: string; description: string } {
    return {
        subject: `Call-back request — ${CALLBACK_TIMES[r.bestTime]}`,
        description: [
            'Please call me back.',
            `Phone: ${r.phone}`,
            `Best time: ${whenLine(r)}`,
            '',
            r.notes ? `What I'd like to talk about:\n${r.notes}` : 'No topic given.',
        ].join('\n'),
    };
}
