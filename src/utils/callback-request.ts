// src/utils/callback-request.ts
//
// "Request a call back" (owner, 2026-10-19). A customer who left said it felt like there were no
// humans, only AI — there were, but nothing in the product said so or let them ask for one. Help &
// Support → Contact us (and the assistant chat, which offers the same form) now let a customer ask
// for a phone call. It is a support ticket like any other — category 'callback', priority 'high' —
// so it lands in Admin ▸ Inbox and the business inbox, and the customer can follow it under "Your
// requests". These rules are shared by the server and the tests; the browser repeats only the shape.
//
// ⚠️ NO TIME IS OFFERED OR PROMISED (owner, 2026-10-19): "I cannot commit to meeting the user's time
// expectation." The customer gives a number; we say a person will call them back, nothing more. The
// browser's timezone is recorded only so whoever rings does not call in the middle of their night.

export const CALLBACK_CATEGORY = 'callback';

export interface CallbackInput { phone?: unknown; timezone?: unknown; notes?: unknown }
export interface CallbackRequest { phone: string; timezone: string | null; notes: string }

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
    const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
    return { ok: true, value: { phone, timezone: cleanTimezone(input.timezone), notes } };
}

/** The ticket the request becomes. The subject reads as a call-back at a glance in the Inbox. */
export function callbackTicket(r: CallbackRequest): { subject: string; description: string } {
    return {
        subject: 'Call-back request',
        description: [
            'Please call me back.',
            `Phone: ${r.phone}`,
            `My time zone: ${r.timezone ?? 'not known'}`,
            '',
            r.notes ? `What I'd like to talk about:\n${r.notes}` : 'No topic given.',
        ].join('\n'),
    };
}

// ── Chat ───────────────────────────────────────────────────────────────────────────────────────
// The chat never books a call. When the customer's message asks for a call or a person, the reply
// carries this card, which opens the Help & Support form (the same server action as the GUI).

export const CALLBACK_OFFER_TYPE = 'callback_offer';

/**
 * Does this message ask to speak to a person or for a phone call? Deliberately narrow: "call to
 * action", "phone number on my website" and "a person in my audience" must NOT offer a call.
 */
export function asksForACall(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const t = text.toLowerCase();
    return /\b(call|ring|phone)\s+me\b/.test(t)
        || /\b(call|ring)\s*-?\s*back\b/.test(t)
        || /\b(speak|talk|chat)\s+(to|with)\s+(a|an|some|the)?\s*(real\s+|actual\s+)?(human|person|people|someone|somebody|team|support|founder)\b/.test(t)
        || /\b(a|an)\s+(real\s+|actual\s+)?(human|person)\b.*\b(help|speak|talk|call|contact)\b/.test(t)
        || /\bis\s+(there|anyone)\s+(a\s+)?(human|real person|anyone real)\b/.test(t)
        || /\b(book|schedule|arrange|have)\s+(a\s+)?(phone\s+)?call\b/.test(t);
}

export function callbackOfferElement(): { type: string } {
    return { type: CALLBACK_OFFER_TYPE };
}
