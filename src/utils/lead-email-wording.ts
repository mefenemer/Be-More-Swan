// src/utils/lead-email-wording.ts
// The words of the Lead Generator's outreach emails, for its chat to read.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Prod 2026-11-10 (org 40, found while checking Fix pipeline #36): asked "what kind of questions are
// you including in these emails?", the chat described the outreach SETTINGS and made up two closing
// questions as examples. The user had approved emails that ended nothing like that, and the chat had
// to admit it "can't see the full wording of the emails you've already approved, only their subject
// lines". Its snapshot listed each waiting email by subject alone, and sent emails not at all.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// The chat-orchestrator's leads snapshot passes the waiting emails and the most recently SENT first
// emails here. Each email's wording is quoted under its line, so the chat can answer from the real
// text. Bounded: each email is capped, and once the total budget is spent the rest are listed with
// their wording left out and a line saying so, so the chat never mistakes a gap for an empty email.
// Follow-ups live in lead_messages, not on the lead, and are NOT here — the block says so.
//
// Pure. Never throws.

/** One email, already resolved by the caller (sendableDraft for waiting ones, the stored draft for sent ones). */
export interface LeadEmailLine {
    id: number;
    title: string;
    /** Where it sits, in the Outreach tab's own words. */
    where: string;
    to: string | null;
    subject: string;
    body: string;
    /** ISO time it went, for sent emails. */
    sentAt?: string | null;
}

/** The longest single email quoted, in characters. A first outreach email is meant to be under 75 words. */
export const LEAD_EMAIL_BODY_MAX = 1200;
/** All quoted wording together, in characters, so the system prompt stays a sensible size. */
export const LEAD_EMAIL_WORDING_BUDGET = 9000;
/** How many sent first emails the chat sees. */
export const LEAD_SENT_EMAILS_SHOWN = 5;

const WORDING_LEFT_OUT = '(wording left out to keep this message short — never guess it)';

function quote(body: string): string {
    const clean = body.replace(/\r\n?/g, '\n').trim();
    const cut = clean.length > LEAD_EMAIL_BODY_MAX ? `${clean.slice(0, LEAD_EMAIL_BODY_MAX).trimEnd()} […]` : clean;
    return cut.split('\n').map((l) => `    > ${l}`).join('\n');
}

/**
 * The quoted lines for a list of emails, sharing one budget. Returns the text and how much budget
 * is left, so the caller can carry it from the waiting list to the sent list.
 */
export function quoteLeadEmails(emails: LeadEmailLine[], budget: number): { text: string; left: number } {
    let left = budget;
    const out: string[] = [];
    for (const e of emails) {
        const head = `- #${e.id} ${e.title} (${e.where}${e.sentAt ? `, sent ${e.sentAt.slice(0, 10)}` : ''}, to ${e.to ?? 'no address'}) — subject: "${e.subject}"`;
        const q = quote(e.body);
        if (q.length <= left) {
            out.push(`${head}\n${q}`);
            left -= q.length;
        } else {
            out.push(`${head}\n    ${WORDING_LEFT_OUT}`);
            left = 0;
        }
    }
    return { text: out.join('\n'), left };
}

/** The rule that goes with the quoted emails, so the chat answers from them and nothing else. */
export const LEAD_EMAIL_WORDING_RULE =
    'The text under each email above (lines starting ">") is its exact wording: what the user will approve, or what was sent. '
    + 'When the user asks what your emails say, how they open or end, or what questions they ask, answer from that wording and quote it. '
    + 'Never describe them from your outreach settings instead, and never make up example lines. '
    + 'Where the wording is left out, or an email is not listed, say you can’t see that one here: for a waiting email offer the card that shows every word, for a sent one point at the Outreach tab. '
    + 'Only first emails are shown here, not follow-ups.';
