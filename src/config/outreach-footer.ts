// src/config/outreach-footer.ts
// The compliance footer appended to every tenant→prospect cold outreach email, and the
// List-Unsubscribe header values that go with it.
//
// ── Why this is code-owned, not model-written ───────────────────────────────────────────────────
// The outreach body is drafted by a model and can then be rewritten by a human reviewer in the
// Review Queue. Neither is a place to put a legally required notice: the model would paraphrase it
// (or drop it when it decides the email reads better short), and a reviewer editing the draft would
// delete it without realising what it was. So the footer is appended AFTER both, at the send sites,
// from here — the same reason email-template.ts owns the platform footer and admins only ever edit
// the inner body.
//
// ── What the law actually asks for ──────────────────────────────────────────────────────────────
//   • CAN-SPAM (US)  — a clear opt-out mechanism AND a valid physical postal address, every email.
//   • CASL (Canada)  — a working unsubscribe mechanism, valid ≥60 days, plus sender identification.
//   • UK GDPR Art.21 — the right to object, made explicit rather than merely available on request.
//   • RFC 8058       — List-Unsubscribe + List-Unsubscribe-Post, so Gmail/Yahoo render a native
//                      one-click unsubscribe and treat the mail as well-behaved.
// The link satisfies the first three; the headers satisfy the fourth and are NOT a substitute for
// the visible line (a header alone is not "clear and conspicuous").
//
// ── The fallback matters ────────────────────────────────────────────────────────────────────────
// The unsubscribe URL is keyed on the thread's replyToken, which is minted just before the first
// send. openLeadThread is best-effort — if it fails we still send, because a lead who never hears
// from us is worse than one whose replies are untracked. That means there is a real path with no
// token and therefore no link, and sending a bare cold email down it would be exactly the gap this
// module exists to close. So buildOutreachFooter always produces SOME opt-out route: with a token
// it is a link, without one it is a "reply with the word UNSUBSCRIBE" instruction — which is not a
// consolation prize, it is the mechanism src/config/opt-out.ts already detects and enforces.

const BASE_URL = (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/+$/, '');

/**
 * Is this a plausible postal address?
 *
 * Deliberately weak — this cannot verify an address exists, and pretending otherwise would mean
 * rejecting valid ones. What it DOES catch is the failure this gate exists to prevent: a required
 * field satisfied with "UK" or "n/a", which passes a non-empty check and satisfies no regulator.
 * A real address has a building/street number and more than one word.
 *
 * Shared by the send gate and the settings UI so a value the form accepts can never be one the
 * sender rejects — a field that saves green and then silently blocks outreach is worse than no
 * validation at all.
 */
export function isUsablePostalAddress(value: string | null | undefined): boolean {
    const v = String(value ?? '').trim();
    if (v.length < 10) return false;
    if (!/\d/.test(v)) return false;               // no building number or postcode
    return v.split(/\s+/).filter(Boolean).length >= 3;
}

/** The public unsubscribe endpoint for a thread. */
export function unsubscribeUrl(replyToken: string): string {
    return `${BASE_URL}/.netlify/functions/lead-unsubscribe?t=${encodeURIComponent(replyToken)}`;
}

export interface OutreachFooterOptions {
    /** The sending organisation's name — who the prospect is hearing from. */
    senderName: string;
    /** organisations.outreach_postal_address. Omitted from the footer when absent. */
    postalAddress?: string | null;
    /** The thread's replyToken. Absent ⇒ the reply-based fallback is used instead of a link. */
    replyToken?: string | null;
}

export interface OutreachFooter {
    /** Plain-text block to append to the body. Always non-empty. */
    text: string;
    /** Value for the List-Unsubscribe header, or null when there is no token to key it on. */
    listUnsubscribe: string | null;
    /**
     * True when the footer carries a real postal address. False means the email is still missing a
     * CAN-SPAM/CASL element — the send is not blocked, but the caller logs it so the gap is visible
     * rather than silent. See the note in lead-generation.ts.
     */
    hasPostalAddress: boolean;
}

/**
 * Build the footer for one outreach email.
 *
 * Deliberately plain text with no HTML: both send paths post a text/plain body (gmail.ts sets
 * Content-Type: text/plain, outlook.ts sends contentType 'Text'), so markup here would be shown to
 * the prospect as literal angle brackets.
 */
export function buildOutreachFooter(opts: OutreachFooterOptions): OutreachFooter {
    const sender = (opts.senderName || '').trim() || 'the sender';
    const postal = (opts.postalAddress || '').trim();
    const token = (opts.replyToken || '').trim();

    const optOutLine = token
        ? `Don't want to hear from us? Unsubscribe here: ${unsubscribeUrl(token)}`
        // No token ⇒ no link. This instruction is a working mechanism, not a placeholder: a reply
        // containing "unsubscribe" is matched by src/config/opt-out.ts, recorded in lead_opt_outs
        // and enforced by checkSuppression before every subsequent send.
        : `Don't want to hear from us? Reply to this email with the word UNSUBSCRIBE and we'll remove you straight away.`;

    const lines = [
        '',
        '—',
        `This message was sent by ${sender}.`,
        ...(postal ? [postal] : []),
        optOutLine,
    ];

    return {
        text: lines.join('\n'),
        // RFC 8058 wants a URL the client can POST to. Only the https form is advertised: a mailto:
        // alternative would route to the sender's own inbox, where nothing observes it, so a client
        // choosing it would produce an opt-out we never record.
        listUnsubscribe: token ? `<${unsubscribeUrl(token)}>` : null,
        hasPostalAddress: !!postal,
    };
}

/**
 * Append the footer to a drafted body, collapsing any trailing whitespace first so the separator
 * always sits one blank line below the sign-off however the model ended its draft.
 */
export function appendOutreachFooter(body: string, footer: OutreachFooter): string {
    return `${String(body ?? '').replace(/\s+$/, '')}\n${footer.text}`;
}
