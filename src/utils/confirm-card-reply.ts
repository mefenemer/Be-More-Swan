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
// "I'll set that up as a rule across your whole team" over a rule card got through (staging 2026-11-11, FR#10):
// set / make / remove / delete joined the I'll and I will lists.
const CLAIMS = /\b(updated|changed|saved|switched|stopped|started|added|removed|approved|declined|turned (on|off)|set up|all set|done)\b|\bI(?:'|’)?ll (stop|start|write|post|switch|turn|add|change|update|save|keep|use|draft|set|make|remove|delete)\b|\bI will (stop|start|write|post|switch|turn|add|change|update|save|keep|use|draft|set|make|remove|delete)\b|\bI(?:'|’)?ve (stopped|started|written|switched|turned|added|changed|updated|saved|set)\b/i;

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
    // "Here it is now, and nothing is saved until you confirm on it" over no card (prod 2026-11-07, org 40).
    /\bhere it is now\b[^\n]{0,80}\bconfirm\b/.source,
    // Without the word "card" (prod 2026-10-26: "I've put that change below for you to approve" over no card).
    /\b(?:I(?:'|’)?ve|I have)\s+(?:put|placed|attached|left|queued)\b[^.\n]{0,40}\b(?:below|above)\b/.source,
    /\b(?:below|above) for you to (?:approve|confirm|save|accept|review)\b/.source,
    /\b(?:the|that|this) (?:change|suggestion|update) (?:below|above)\b/.source,
    /\b(?:approve|confirm|save|accept) (?:it|that|this|them) (?:below|above)\b/.source,
].join('|'), 'i');

export const NO_CARD_NOTE = '(No card came with this reply. Ask me again and I’ll add it.)';

/**
 * An OFFER of a card, not a claim of one (Fix pipeline #33/#36, prod 2026-11-10): "tell me which one
 * and I'll put it on a card that shows every word", "just tell me … and I'll put a card here". The
 * note was added to those, so a correct reply read as a fault. A match counts as an offer when, in
 * the same sentence and BEFORE it, the reply says what it will/can do. "I can't see #118's text, so
 * the card below asks…" is still a claim, and so is "Approve the card below and I'll do the rest".
 */
const OFFER_BEFORE = /\b(?:I(?:'|’)ll|I will|I can(?!(?:'|’)t|not)|I could|I(?:'|’)d|I would|shall I|want me to|like me to)\b/i;
const POINTS_AT_CARD_ALL = new RegExp(POINTS_AT_CARD.source, 'gi');

export function replyPointsAtCard(content: string): boolean {
    for (const m of content.matchAll(POINTS_AT_CARD_ALL)) {
        const upTo = content.slice(0, m.index);
        const sentenceStart = Math.max(upTo.lastIndexOf('.'), upTo.lastIndexOf('!'), upTo.lastIndexOf('?'), upTo.lastIndexOf('\n')) + 1;
        if (!OFFER_BEFORE.test(upTo.slice(sentenceStart))) return true;
    }
    return false;
}

/** The reply, with NO_CARD_NOTE added when it points at a card that isn't there. */
export function missingCardReply(content: string, hasCard: boolean): string {
    if (hasCard || !replyPointsAtCard(content) || content.includes(NO_CARD_NOTE)) return content;
    return `${content}\n\n${NO_CARD_NOTE}`;
}

/**
 * What to keep when a reply points at a card that was not drawn (Fix pipeline #33, prod 2026-11-10).
 * Three Blog Writer replies said "the card below…" over nothing, and the card the model sent (if any)
 * was only console.warn'd, gone by the time anyone looked. This is stored as a hidden role 'system'
 * chat message beside the reply, like the [suppressed:…] row, so the cause can be read afterwards:
 * no card sent, a card the server refused (sentType set), or a reply that was prose, not JSON.
 * Capped so one bad turn can't write a huge row. Pure.
 */
export const DROPPED_CARD_TAG = '[card-dropped]';
export function droppedCardRecord(input: { route: string; roleKey: string | null; sentUiElement: unknown; raw: string }): { content: string; uiElementJson: Record<string, unknown> } {
    const sent = input.sentUiElement && typeof input.sentUiElement === 'object' ? input.sentUiElement as Record<string, unknown> : null;
    const sentType = typeof sent?.type === 'string' ? sent.type : null;
    let sentJson: string | null = null;
    if (sent) { try { sentJson = JSON.stringify(sent).slice(0, 4000); } catch { sentJson = null; } }
    const replyWasJson = input.raw.trimStart().startsWith('{');
    const why = sentType ? `sent ${sentType}, not drawn` : replyWasJson ? 'no card in the reply' : 'reply was prose, not JSON';
    return {
        content: `${DROPPED_CARD_TAG} ${input.route} / ${input.roleKey ?? '?'}: ${why}`,
        uiElementJson: { route: input.route, roleKey: input.roleKey, sentType, sentCard: sentJson, replyWasJson, rawLength: input.raw.length, rawEnd: input.raw.slice(-1500) },
    };
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
        ? 'Here it is — choose “Choose from My Content”, “Create with AI” or “Find stock photos” on the card below, then pick the one you like. Nothing is made or added until you do.'
        : 'I can’t make or add a picture from a message — ask me for a picture for a section and I’ll put a card here with options to choose from. Nothing has been made or added.';
}

/**
 * The Website Assistant's reply with NO card (prod 2026-11-07, Restorative Futures, org 41): asked to
 * "fill in the content on the blank pages", it answered "I've filled in all five blank pages…" and
 * described each — with no card at all. Nothing changed; the pages stayed blank, and the next morning
 * it had to admit it. Only a card's click changes the site, so a reply that says it already changed
 * the site, beside no card, is replaced. Narrow on purpose: "Your home page has a hero" (describing
 * the draft) and "I can add that" (an offer) are kept.
 */
const SITE_CHANGE_CLAIM = new RegExp([
    /\b(?:I(?:'|’)?ve|I have)\s+(?:now\s+|just\s+|also\s+)?(?:filled(?: in)?|added|updated|changed|written|rewritten|wrote|removed|deleted|moved|replaced|created|built|made|put|placed|switched|turned|renamed|reworded|fixed|copied|imported|applied|set up)\b(?![^.\n]{0,40}\bcard\b)/.source,
    /\b(?:is|are) now (?:on|in) your (?:site|website|draft|page|home page)\b/.source,
    /\b(?:all|it(?:'|’)?s|that(?:'|’)?s) done\b/.source,
].join('|'), 'i');

export const SITE_NO_CARD_REPLY = 'I haven’t changed your website — no change card came with this reply, so nothing was applied. Ask me again and I’ll put the change on a card for you to approve.';

export function replyClaimsSiteChange(content: string): boolean {
    return SITE_CHANGE_CLAIM.test(content);
}

/** The Website Assistant's reply when no card came with it: never "I've filled in the pages". */
export function siteNoCardReply(content: string, hasCard: boolean): string {
    if (hasCard || !replyClaimsSiteChange(content)) return content;
    return SITE_NO_CARD_REPLY;
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
