// src/config/newsletter-purposes.ts
// What an email is FOR — the closed-ish vocabulary shared by the New Issue dialog, the drafting
// prompt, the starting template and the label on the list row.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The Newsletter Assistant could write exactly one kind of email: a newsletter. But the emails a
// small business actually needs to send are mostly NOT newsletters — "we're changing our terms on
// the 1st", "the thing that was broken this morning is fixed", "here's what shipped this month",
// "we're closed on Monday". Those are different in register, in length, in who they go to and in
// what a reader is entitled to expect from them. Sent in newsletter voice, a terms-change notice
// reads as marketing and gets deleted unread, which is the one outcome that matters legally.
//
// A purpose changes three things and deliberately nothing else:
//   1. the template a new issue starts from (src/config/newsletter-templates.ts)
//   2. the brief the assistant is given (`promptGuidance` below, injected verbatim)
//   3. how the issue is labelled wherever it is listed
//
// ⚠️ NOT A SQL CHECK CONSTRAINT. See db/newsletter-design.sql — this list will grow, a constraint
// would make each addition a two-environment SQL deploy, and an unknown value degrades to
// 'newsletter' (see `purposeOrDefault`) rather than failing a write.

export interface NewsletterPurpose {
    key: string;
    /** The name on the button and the chip. Sentence case — it appears mid-sentence. */
    label: string;
    /** One line, shown under the label when choosing. Says who it is for, not what it contains. */
    description: string;
    /** The chip's colour family. Tailwind classes, compiled — see src/generated for the mirror. */
    chipClass: string;
    /** Template key this purpose starts from. Must exist in NEWSLETTER_TEMPLATES. */
    defaultTemplate: string;
    /**
     * Injected into the drafting system prompt verbatim, after the tone. Written as instructions to
     * a writer, not as a description of the category — the model acts on it.
     */
    promptGuidance: string;
}

export const NEWSLETTER_PURPOSES: NewsletterPurpose[] = [
    {
        key: 'newsletter',
        label: 'Newsletter',
        description: 'Your regular issue — news, stories and whatever is worth sharing this time.',
        chipClass: 'bg-gray-100 text-gray-600 border-gray-200',
        defaultTemplate: 'classic',
        promptGuidance:
            'This is a regular newsletter issue. Two to four short sections, each worth reading on '
            + 'its own, in a warm and unhurried voice.',
    },
    {
        key: 'product_update',
        label: 'Product update',
        description: 'What is new, what changed, and what it means for the people using it.',
        chipClass: 'bg-sky-100 text-sky-700 border-sky-200',
        defaultTemplate: 'update',
        promptGuidance:
            'This is a product update. Lead with what a reader can now DO that they could not do '
            + 'before — never with the internal name of a feature. One short paragraph per change, '
            + 'strongest first, and say plainly if a change needs anything from them. Do not '
            + 'describe work in progress as though it has shipped, and do not promise dates the '
            + 'brief does not give you.',
    },
    {
        key: 'incident',
        label: 'Fixed or fixing',
        description: 'Something broke. What happened, what you did, what it means for them.',
        chipClass: 'bg-amber-100 text-amber-800 border-amber-200',
        defaultTemplate: 'notice',
        promptGuidance:
            'This is a message about something that went wrong. Plain, short and unspun: what was '
            + 'affected, when, what has been done, and whether the reader needs to do anything. '
            + 'Apologise once, early, and then be useful. ⚠️ Do NOT minimise, do NOT use "some '
            + 'users may have experienced", and do NOT open with thanks for their patience. Never '
            + 'invent a cause, a duration, or a number of people affected — if the brief does not '
            + 'say, write around it or say it is still being established.',
    },
    {
        key: 'policy_change',
        label: 'Terms or policy change',
        description: 'A change to your terms, privacy policy or pricing, in language people can act on.',
        chipClass: 'bg-violet-100 text-violet-700 border-violet-200',
        defaultTemplate: 'notice',
        promptGuidance:
            'This is a notice of a change to terms, a policy or a price. Say WHAT is changing, WHEN '
            + 'it takes effect, and WHAT the reader can do about it — including leaving, if that is '
            + 'an option. Put the date in the first two sentences. Neutral register: no enthusiasm, '
            + 'no selling, no "exciting news". ⚠️ Do not summarise the legal text as though your '
            + 'summary replaces it, and never invent a date, a price or a clause that the brief '
            + 'does not give you — link to the full text instead.',
    },
    {
        key: 'announcement',
        label: 'Announcement or event',
        description: 'An opening, a date for the diary, a milestone worth telling people about.',
        chipClass: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        defaultTemplate: 'announcement',
        promptGuidance:
            'This is a single-subject announcement. One thing, said clearly, with the date, the '
            + 'place and the next step a reader needs. Keep it short — an announcement that runs on '
            + 'reads as a newsletter and buries its own news.',
    },
    {
        key: 'offer',
        label: 'Offer',
        description: 'A promotion, discount or limited run — with the terms said out loud.',
        chipClass: 'bg-pink-100 text-pink-700 border-pink-200',
        defaultTemplate: 'offer',
        promptGuidance:
            'This is a promotional email. State the offer, who it applies to and when it ends, in '
            + 'the first three lines. One call to action, repeated at most twice. ⚠️ Never invent a '
            + 'discount, a deadline, a stock level or a "only N left" — those are facts, and a '
            + 'promotional email that makes them up is the kind of thing regulators write to people '
            + 'about. Do not manufacture urgency the brief did not give you.',
    },
];

export const NEWSLETTER_PURPOSE_KEYS = NEWSLETTER_PURPOSES.map((p) => p.key);

export const DEFAULT_PURPOSE = 'newsletter';

/** An unknown or missing purpose is a newsletter — a stored value must never break a read. */
export function purposeOrDefault(key: unknown): string {
    const k = typeof key === 'string' ? key.trim() : '';
    return NEWSLETTER_PURPOSE_KEYS.includes(k) ? k : DEFAULT_PURPOSE;
}

export function findPurpose(key: unknown): NewsletterPurpose {
    const k = purposeOrDefault(key);
    return NEWSLETTER_PURPOSES.find((p) => p.key === k) as NewsletterPurpose;
}

/** The guidance block injected into the drafting prompt. Empty for the plain newsletter default. */
export function purposePromptBlock(key: unknown): string {
    const p = findPurpose(key);
    return p.key === DEFAULT_PURPOSE ? '' : `WHAT THIS EMAIL IS: ${p.label}. ${p.promptGuidance}`;
}
