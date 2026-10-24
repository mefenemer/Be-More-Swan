// src/config/hook-styles.ts
// How a piece OPENS — one shared list, so every assistant reaches past the same safe first line.
//
// Social posts have rotated an assigned opening ("hook") since 2026-08 (process-content-jobs.ts),
// because parallel drafts in one batch can't see each other and all reached for the same formula.
// Articles, emails and cold outreach had no such rotation, so every article opened with a definition
// and every newsletter with "I hope this finds you well" (owner, 2026-10-24: hooks everywhere).
//
// ⚠️ SOCIAL KEEPS ITS SEVEN, in this order. The social hook is chosen by the slot's HOUR and the post
// shape (content-shapes.ts, 11 shapes) by its DAY; 7 is prime and coprime with both 24 and 11, so a
// daily slot cycles through every hook without locking onto one shape. Adding an eighth here would
// alias (8 divides 24): a 9am-every-day schedule would open with the same hook for ever.
// Long-form openings rotate by a per-assistant COUNT (one step per piece, no aliasing), so they can
// use the longer list below.

/** The seven social hooks. Order and wording are load-bearing — see the header. */
export const SOCIAL_HOOK_STYLES = [
    'a provocative question aimed straight at the target reader',
    // Was "a surprising statistic or a concrete number" — which the NO INVENTED STATISTICS
    // standard then forbade, so one slot in seven was told to do the thing it may not do.
    'one concrete, specific real-life detail (a time, a place, a small moment)',
    'a short, vivid "this is you right now" scenario (one or two lines)',
    'a widely-believed myth stated plainly, then busted',
    'a bold, mildly contrarian claim',
    'a sharp pain-point callout',
    'a before/after contrast (the messy now vs. the calmer after)',
] as const;

/** The social hook for a slot — by its hour, exactly as process-content-jobs.ts always chose it. Null with no slot. */
export function socialHookFor(targetPublishDate: string | Date | null | undefined): string | null {
    if (!targetPublishDate) return null;
    const t = new Date(targetPublishDate).getTime();
    if (!Number.isFinite(t)) return null;
    return SOCIAL_HOOK_STYLES[Math.floor(t / 3_600_000) % SOCIAL_HOOK_STYLES.length];
}

/** Openings for articles and emails: the seven, plus two that suit longer pieces. */
export const LONG_FORM_OPENINGS = [
    ...SOCIAL_HOOK_STYLES,
    'a direct callout to one specific kind of reader ("For the café owner who…")',
    'a curiosity gap — something true and surprising that the piece goes on to explain',
] as const;

const at = <T>(list: readonly T[], n: number): T => list[((Math.floor(n) % list.length) + list.length) % list.length];

/** The opening for the Nth piece an assistant writes. Pure. */
export function longFormOpeningFor(sequence: number): string {
    return at(LONG_FORM_OPENINGS, Number.isFinite(sequence) ? sequence : 0);
}

const NEVER_OPEN = 'Never open with a definition, "In today\'s fast-paced world", "As a business owner…", "I hope this finds you well", or a statistic the brief does not supply. Never invent a customer, a named person or something that happened: a detail or scene must come from the brief, or be plainly hypothetical ("Picture a Tuesday morning…").';

/** The article's first paragraph (blog-generate.ts). Pure. */
export function blogOpeningBlock(sequence: number): string {
    return `OPENING for THIS article — the first paragraph opens with ${longFormOpeningFor(sequence)}, then gets to the point within two sentences. ${NEVER_OPEN} If this opening fits awkwardly with the ARTICLE TYPE, keep the type and adapt the opening.`;
}

/** Subject-line approaches for email, rotated with the opening (offset so the two don't pair up). */
export const EMAIL_SUBJECT_STYLES = [
    'names the one useful thing inside, plainly ("How to keep tulips standing up")',
    'a specific detail or piece of news ("Our new Saturday hours")',
    'a short, genuine question to the reader',
    'the start of a story ("The wedding that almost didn\'t happen")',
    'a clear benefit in under six words — with no number the brief does not give',
] as const;

/** The email's subject line and first line (newsletter-generate.ts). Pure. */
export function emailOpeningBlock(sequence: number): string {
    const n = Number.isFinite(sequence) ? sequence : 0;
    return `OPENING for THIS email — the subject line ${at(EMAIL_SUBJECT_STYLES, n + 2)}; after the greeting, the first line opens with ${longFormOpeningFor(n)}. ${NEVER_OPEN} The subject must never promise something the email doesn't deliver, and carries no number of hours, percentage or result the brief does not give — in digits or in words ("three hours back" is a claim too).`;
}

/** Cold-email openings — only the ones that suit a stranger's first email (no myths, no contrarian claims). */
export const OUTREACH_OPENINGS = [
    'one concrete, specific detail about THEIR business (a branch, a post, a job advert, a review) — only one the lead details actually give',
    'a short "this is probably you right now" line about a business like theirs',
    'the sharp, specific problem businesses like theirs have',
    'a genuine question about how they handle that problem today',
] as const;

/** The opening rule every first-email seam gets (src/config/outreach-offer.ts). Pure. */
export const OUTREACH_OPENING_RULE = `OPENING: open with ONE of these, and vary it — when you write several emails in one reply, use them in turn, so no two neighbouring emails open the same way:\n${OUTREACH_OPENINGS.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}\nIf the lead details give no real detail about them, never invent one — use 2, 3 or 4.`;
