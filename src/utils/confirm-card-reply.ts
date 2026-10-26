// src/utils/confirm-card-reply.ts
// The words beside a confirm card must never say the change has happened — only the card's click
// does that.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every card's prompt says "never say it HAS changed — say the card is there to confirm", and the
// first live turns on staging (2026-10-22) ignored it three times in four: "Schedule updated to
// Tuesdays and Thursdays", "I'll write like that", and — over a card the server had REFUSED because
// Facebook was not connected — "I'll stop drafting for Facebook from now on". A prompt cannot hold
// this line, so the server does: a refused card gets a reply that says so, and a live card's reply
// that claims the change is replaced with one that does not. A reply that only offers the card
// ("Goal card is ready to confirm.") is kept as written.

/** Words that report a change as made or promise to make it — what only the click may do. */
const CLAIMS = /\b(updated|changed|saved|switched|stopped|started|added|removed|approved|declined|turned (on|off)|set up|all set|done)\b|\bI(?:'|’)?ll (stop|start|write|post|switch|turn|add|change|update|save|keep|use|draft)\b|\bI will (stop|start|write|post|switch|turn|add|change|update|save|keep|use|draft)\b|\bI(?:'|’)?ve (stopped|started|written|switched|turned|added|changed|updated|saved|set)\b/i;

export function replyClaimsChange(content: string): boolean {
    return CLAIMS.test(content);
}

/**
 * The reply to show with a confirm card. `blocked` is the card's own refusal (null when its button
 * is live); `settled` cards are history and keep their words.
 */
export function confirmCardReply(content: string, card: { blocked?: unknown; settled?: unknown } | null | undefined): string {
    if (!card || card.settled) return content;
    if (typeof card.blocked === 'string' && card.blocked) {
        return 'I can’t do that as asked — the card below says why. Nothing has changed.';
    }
    return replyClaimsChange(content) ? 'Here it is — nothing changes until you confirm on the card below.' : content;
}

/**
 * A reply that points at a card when none came with it (Business Mentor rubric W6, staging
 * 2026-10-26: "I've added a card that looks up the up-to-date rules" over no card at all). The prompt
 * can't hold this either, so the server says so plainly beside the reply.
 */
const POINTS_AT_CARD = /\b(?:I(?:'|’)?ve|I have)\s+(?:added|included|attached|drafted|put)\b[^.\n]{0,40}\bcard\b|\bcard\s+(?:below|above|here)\b|\b(?:the|a|this)\s+card\s+(?:that|which)\b|\bbelow is a card\b|\btap (?:the|an?) (?:button|answer) below\b/i;

export const NO_CARD_NOTE = '(No card came with this reply. Ask me again and I’ll add it.)';

export function replyPointsAtCard(content: string): boolean {
    return POINTS_AT_CARD.test(content);
}

/** The reply, with NO_CARD_NOTE added when it points at a card that isn't there. */
export function missingCardReply(content: string, hasCard: boolean): string {
    if (hasCard || !replyPointsAtCard(content) || content.includes(NO_CARD_NOTE)) return content;
    return `${content}\n\n${NO_CARD_NOTE}`;
}
