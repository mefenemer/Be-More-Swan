// src/utils/reply-address.ts
// The per-thread inbound alias — reply+<token>@<INBOUND_PARSE_DOMAIN> — and its parser.
//
// Phase 2a of docs/lead-generator-revenue-engine-plan.md. This is the mechanism that makes a reply
// attributable to ONE conversation. The alternatives are all worse:
//   • matching on sender address — the same person can be a prospect of two assistants in one org,
//     and replies routinely arrive from a colleague or an EA rather than the addressee;
//   • parsing quoted text or subject lines — mail clients mangle both.
// A token in the envelope recipient survives every client, and the routing is exact.
//
// Reuses the SendGrid Inbound Parse MX that inbound-email.ts already terminates
// (parse.bemoreswan.com). No new DNS, no new provider — the plus-addressed local part is carried
// through to the webhook's `to` field and envelope untouched.

import { randomBytes } from 'crypto';

/**
 * Host that Inbound Parse delivers to. MUST match the SendGrid Parse "Host" setting.
 * Defaults to the value already in production use so a missing env var cannot silently produce
 * addresses that route nowhere.
 */
export function inboundDomain(): string {
    return (process.env.INBOUND_PARSE_DOMAIN || 'parse.bemoreswan.com').trim().toLowerCase();
}

/**
 * Mint a thread token. 18 bytes of base64url ≈ 24 chars.
 *
 * This value is effectively a bearer credential: anyone who learns it can post a message into the
 * thread through a public webhook. It must be unguessable, so it is random — never derived from
 * the thread id, the lead, or anything enumerable.
 */
export function mintReplyToken(): string {
    return randomBytes(18).toString('base64url');
}

/** The full Reply-To address for a thread. */
export function replyAddress(token: string): string {
    return `reply+${token}@${inboundDomain()}`;
}

// Local part we own. Anything else on this host is ordinary support mail and must fall through to
// the existing pipeline untouched.
const REPLY_LOCAL = 'reply';
// Mirrors mintReplyToken's alphabet. Deliberately strict: a loose pattern would let a crafted
// address reach the thread lookup with junk, and would make "is this ours?" ambiguous.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Extract a thread token from a recipient address, or null when it is not one of ours.
 *
 * Accepts the forms mail actually arrives in: bare address, display-name form, and a
 * comma-separated recipient list (a reply that also CCs someone). Case-insensitive, because
 * relays routinely rewrite the local part's case.
 */
export function parseReplyToken(recipient: string | null | undefined): string | null {
    if (!recipient) return null;
    const domain = inboundDomain();
    for (const partRaw of String(recipient).split(',')) {
        const part = partRaw.trim();
        if (!part) continue;
        // "Name <addr>" → addr
        const m = part.match(/<([^>]+)>/);
        const addr = (m ? m[1] : part).trim().toLowerCase();
        const at = addr.lastIndexOf('@');
        if (at < 0) continue;
        if (addr.slice(at + 1) !== domain) continue;
        const local = addr.slice(0, at);
        const plus = local.indexOf('+');
        if (plus < 0) continue;
        if (local.slice(0, plus) !== REPLY_LOCAL) continue;
        // Preserve the ORIGINAL case of the token — base64url is case-sensitive, and lowercasing
        // the whole address above would corrupt it. Recover it from the untouched source.
        const rawLocal = (m ? m[1] : part).trim().slice(0, at);
        const token = rawLocal.slice(plus + 1);
        if (!TOKEN_RE.test(token)) continue;
        return token;
    }
    return null;
}

/**
 * Pull the best recipient string out of a SendGrid Inbound Parse payload.
 * The SMTP envelope is authoritative (it is what the MX actually received); the To header is a
 * fallback and can legitimately not contain our alias at all when the reply was BCC'd.
 */
export function recipientFromParsePayload(fields: Record<string, string>): string | null {
    try {
        const env = fields.envelope ? JSON.parse(fields.envelope) : null;
        const to = env?.to;
        if (Array.isArray(to) && to.length) return to.join(',');
        if (typeof to === 'string' && to) return to;
    } catch { /* envelope is best-effort — fall through to the header */ }
    return fields.to || null;
}
