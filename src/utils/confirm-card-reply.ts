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
const POINTS_AT_CARD = new RegExp([
    /\b(?:I(?:'|’)?ve|I have)\s+(?:added|included|attached|drafted|put)\b[^.\n]{0,40}\bcard\b/.source,
    /\bcard\s+(?:below|above|here)\b/.source,
    // "The card is below this time", "this time the card really is below" (prod 2026-11-07, org 40).
    /\bcard\s+(?:is|really is|should be|will be)\s+(?:below|above|here)\b/.source,
    /\b(?:the|a|this)\s+card\s+(?:that|which)\b/.source,
    /\bbelow is a card\b/.source,
    /\btap (?:the|an?) (?:button|answer) below\b/.source,
    // Without the word "card" (prod 2026-10-26: "I've put that change below for you to approve" over no card).
    /\b(?:I(?:'|’)?ve|I have)\s+(?:put|placed|attached|left|queued)\b[^.\n]{0,40}\b(?:below|above)\b/.source,
    /\b(?:below|above) for you to (?:approve|confirm|save|accept|review)\b/.source,
    /\b(?:the|that|this) (?:change|suggestion|update) (?:below|above)\b/.source,
    /\b(?:approve|confirm|save|accept) (?:it|that|this|them) (?:below|above)\b/.source,
].join('|'), 'i');

export const NO_CARD_NOTE = '(No card came with this reply. Ask me again and I’ll add it.)';

export function replyPointsAtCard(content: string): boolean {
    return POINTS_AT_CARD.test(content);
}

/** The reply, with NO_CARD_NOTE added when it points at a card that isn't there. */
export function missingCardReply(content: string, hasCard: boolean): string {
    if (hasCard || !replyPointsAtCard(content) || content.includes(NO_CARD_NOTE)) return content;
    return `${content}\n\n${NO_CARD_NOTE}`;
}

/**
 * Pictures (staging 2026-11-05): asked for a picture, the Website Assistant replied "I'm generating a
 * dramatic film scene for that section now. Once it's created, I'll add it to your site" — with no
 * card, and nothing ever came. A reply cannot make, find or place a picture; only a site_picture card
 * does, on a click. So a reply that says it is doing so is replaced.
 */
const PICTURE_CLAIM = new RegExp([
    /\bI(?:'|’)?m (?:now )?(?:generating|creating|making|finding|searching|looking for|adding|placing|putting)\b/.source,
    /\bI(?:'|’)?ll (?:generate|create|make|find|add|place|put|drop|insert)\b[^.\n]{0,60}\b(?:picture|image|photo|video|clip|it)\b/.source,
    /\bI will (?:generate|create|make|find|add|place|put|insert)\b[^.\n]{0,60}\b(?:picture|image|photo|video|clip|it)\b/.source,
    /\b(?:I(?:'|’)?ve|I have) (?:generated|created|made|found|added|placed|put|inserted)\b[^.\n]{0,60}\b(?:picture|image|photo|video|clip)\b/.source,
    /\bonce (?:it(?:'|’)?s|it is) (?:created|generated|ready|made|done)\b/.source,
    /\b(?:generating|creating) (?:it|that|the (?:picture|image)|one) now\b/.source,
].join('|'), 'i');

/** Only a reply about a picture: "I'll add it to your home page" beside a page-change card is fine. */
const ABOUT_PICTURE = /\b(?:picture|image|photo|illustration|graphic|visual|scene|video|clip|footage)s?\b/i;
export function replyClaimsPicture(content: string): boolean {
    return ABOUT_PICTURE.test(content) && PICTURE_CLAIM.test(content);
}

/** The Website Assistant's reply: never "I'm creating it" — with the card, point at it; without, say plainly. */
export function pictureReply(content: string, hasPictureCard: boolean): string {
    if (!replyClaimsPicture(content)) return content;
    return hasPictureCard
        ? 'Here it is — choose “Create with AI” or “Find stock photos” on the card below, then pick the one you like. Nothing is made or added until you do.'
        : 'I can’t make or add a picture from a message — ask me for a picture for a section and I’ll put a card here with options to choose from. Nothing has been made or added.';
}

/**
 * The one card in a reply, however the model shaped it. Every route draws ONE card, and every card
 * check downstream reads a single object — so a LIST of cards, or cards under "uiElements" / "cards",
 * matched no card type and was dropped without a word. Prod 2026-11-07 (org 40, Business Mentor):
 * asked to make three changes, it sent them together, turn after turn; the user saw "the card is
 * below" and no card six times, and even the ticket she asked for about it vanished the same way.
 * The token counts showed the cards were written. Now the first card is kept and the rest are said.
 */
export const MORE_CARDS_NOTE = '(I can show one card at a time. Ask me for the next one when you’ve dealt with this.)';
export function firstCard(parsed: Record<string, unknown>): { card: unknown | null; extra: number } {
    const isCard = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
    for (const key of ['uiElement', 'uiElements', 'cards', 'ui_element']) {
        const v = parsed[key];
        if (isCard(v)) return { card: v, extra: 0 };
        if (Array.isArray(v)) {
            const cards = v.filter(isCard);
            if (cards.length) return { card: cards[0], extra: cards.length - 1 };
        }
    }
    return { card: null, extra: 0 };
}
