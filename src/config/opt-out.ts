// src/config/opt-out.ts
// Detects "stop emailing me" in a prospect's reply.
//
// Until now a reply saying "unsubscribe" did nothing: it halted that one cadence as a side effect of
// being a reply at all, and was never recorded. Re-score or re-add the same person and outreach
// resumed. `suppression_list` is written only by the CRM sync, and is DOMAIN-grained — so it is the
// wrong home for this (see db/lead-opt-outs.sql).
//
// ── Why a regex and not the model ────────────────────────────────────────────────────────────────
// This runs inside the SendGrid Inbound Parse webhook, which must answer fast and must never throw
// (a 500 makes SendGrid retry, and eventually bounce a real prospect's reply). An LLM call there
// adds latency, a failure mode and a per-inbound-email cost to catch phrasing that is, in practice,
// formulaic. If a genuinely novel opt-out is missed, the cadence still halts because they replied.
//
// ── The actual difficulty: quoted text ───────────────────────────────────────────────────────────
// A reply usually carries the entire prior thread beneath it, and anything quoted may contain the
// word "unsubscribe" — a footer, a forwarded newsletter, a signature. Matching the raw body would
// opt people out for text they did not write. So we match ONLY the new text above the quote.

/** Lines that mark the start of quoted history. Everything from the first hit is discarded. */
const QUOTE_BOUNDARIES: RegExp[] = [
    /^\s*-{2,}\s*original message\s*-{2,}/im,
    /^\s*_{5,}\s*$/m,                                   // Outlook's divider
    /^\s*on .{0,120}\bwrote:\s*$/im,                    // "On <date>, <name> wrote:"
    /^\s*(?:from|de|von)\s*:.{0,200}$\n^\s*(?:sent|date)\s*:/im, // Outlook header block
    /^\s*at .{0,80}, .{0,80} wrote:\s*$/im,
    /^\s*>{1,}\s?/m,                                    // first quoted line
    /^\s*begin forwarded message:/im,
];

/**
 * The new text a person actually typed, with quoted history removed.
 * Exported for tests — the quote stripping is where this gets things wrong, so it is worth
 * exercising directly rather than only through detectOptOut().
 */
export function newTextOnly(body: string | null | undefined): string {
    let text = String(body ?? '').replace(/\r\n/g, '\n');
    let cut = text.length;
    for (const re of QUOTE_BOUNDARIES) {
        const m = re.exec(text);
        if (m && m.index < cut) cut = m.index;
    }
    text = text.slice(0, cut);
    // A signature block below "-- " is the sender's own, but it is boilerplate they did not write
    // for this reply, and corporate footers there routinely mention unsubscribing.
    const sig = /^\s*--\s*$/m.exec(text);
    if (sig) text = text.slice(0, sig.index);
    return text.trim();
}

/**
 * Opt-out phrasings. Deliberately imperative and narrow.
 *
 * A false positive is expensive and effectively permanent — the prospect is never emailed again and
 * nobody finds out why — so these require an actual instruction, not a mention. "I couldn't find
 * your unsubscribe link" matching is fine (it IS an opt-out); "we help clients unsubscribe from
 * legacy tools" is the shape being avoided by requiring first/second-person framing.
 */
const OPT_OUT_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /\bunsubscribe\b/i, label: 'unsubscribe' },
    { re: /\bopt(?:ing)?[\s-]?out\b/i, label: 'opt out' },
    { re: /\bopt me out\b/i, label: 'opt me out' },
    { re: /\b(?:please\s+)?remove me\b/i, label: 'remove me' },
    { re: /\btake me off\b/i, label: 'take me off' },
    { re: /\bstop (?:emailing|contacting|messaging|mailing)\b/i, label: 'stop emailing' },
    { re: /\bstop sending\b.{0,30}\b(?:emails?|messages?)\b/i, label: 'stop sending emails' },
    { re: /\b(?:do not|don'?t) (?:contact|email|message) (?:me|us)\b/i, label: 'do not contact me' },
    { re: /\bno longer wish to (?:receive|be contacted)\b/i, label: 'no longer wish to receive' },
    { re: /\bnot interested\b.{0,40}\b(?:remove|stop|unsubscribe)\b/i, label: 'not interested + remove' },
    { re: /\bremove (?:me |us )?from (?:your |this |the )?(?:list|mailing|database|records)\b/i, label: 'remove from list' },
];

export interface OptOutVerdict {
    optedOut: boolean;
    /** Which rule matched — stored as audit evidence, so a wrong suppression can be explained. */
    matched: string | null;
    /** The sentence it matched in, trimmed. Null when nothing matched. */
    evidence: string | null;
}

const NOT_OPTED_OUT: OptOutVerdict = { optedOut: false, matched: null, evidence: null };

/**
 * Does this reply ask us to stop emailing?
 *
 * @param body    the inbound message body (quoted history is stripped internally)
 * @param subject checked too — "Re: unsubscribe" is a real pattern, and some clients put the whole
 *                message in the subject when the body is empty.
 */
export function detectOptOut(body: string | null | undefined, subject?: string | null): OptOutVerdict {
    const text = newTextOnly(body);
    // The subject is not quoted history, so it is safe to scan whole — but only the part after any
    // "Re:" prefixes, which carry our own original subject and are not the prospect's words.
    const subj = String(subject ?? '').replace(/^\s*(?:re|fwd?|aw|sv)\s*:\s*/gi, '').trim();
    const haystacks = [text, subj].filter(Boolean);

    for (const hay of haystacks) {
        for (const { re, label } of OPT_OUT_PATTERNS) {
            const m = re.exec(hay);
            if (!m) continue;
            // Quote the sentence it landed in, so a human reviewing a suppression can see the words.
            const start = Math.max(0, hay.lastIndexOf('.', m.index) + 1);
            const endDot = hay.indexOf('.', m.index + m[0].length);
            const end = endDot < 0 ? Math.min(hay.length, m.index + 160) : endDot + 1;
            return { optedOut: true, matched: label, evidence: hay.slice(start, end).trim().slice(0, 300) };
        }
    }
    return NOT_OPTED_OUT;
}
