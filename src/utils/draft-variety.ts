// src/utils/draft-variety.ts
// Anti-repetition context for social drafting: what this assistant has ALREADY written, shown to
// the model so the next draft doesn't land on the same premise, hook or visual.
//
// The corpus deliberately spans every status — pending_approval, scheduled, published, rejected.
// A reviewer does not care whether the near-identical post they are looking at was already
// approved or is merely sitting two rows above in the queue; both read as the assistant repeating
// itself. Rejected captions matter most of all: the user has explicitly said no to that angle.

/** One prior post, as the drafting query returns it. */
export interface PriorPost {
    caption: string | null;
    media: string | null;
}

/**
 * How many prior posts to show. Was 8, which is under two days of output for a daily-cross-post
 * account — comfortably short enough for the model to "forget" a premise and write it again.
 * Each entry is truncated hard (below), so 20 costs roughly 1.5k prompt tokens.
 */
export const VARIETY_LOOKBACK = 20;

/** Visual concepts repeat over a shorter horizon than premises, and cost tokens to list. */
export const VARIETY_VISUAL_LOOKBACK = 10;

/** Opening hook is what gets reused, so the first ~140 chars is the part worth showing. */
const HOOK_CHARS = 140;
const VISUAL_CHARS = 120;

const tidy = (s: string | null, max: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Build the "already drafted / recent visuals" prompt block from the assistant's prior posts.
 *
 * Pure so it can be tested without a database — the ordering and status breadth of the rows is the
 * caller's job (see process-content-jobs.ts), the wording and truncation is this function's.
 * Returns '' when there is nothing to say, so a brand-new assistant's prompt is unchanged.
 */
export function buildVarietyBlock(rows: PriorPost[]): string {
    const hooks = rows.slice(0, VARIETY_LOOKBACK).map(r => tidy(r.caption, HOOK_CHARS)).filter(Boolean);
    const visuals = rows.slice(0, VARIETY_VISUAL_LOOKBACK).map(r => tidy(r.media, VISUAL_CHARS)).filter(Boolean);

    const parts: string[] = [];
    if (hooks.length) {
        parts.push(
            'ALREADY DRAFTED RECENTLY — these are this assistant\'s existing posts, whether they are '
            + 'awaiting review, scheduled, already published or rejected. Bring a genuinely DIFFERENT '
            + 'angle. Do NOT reuse the opening hook, core premise, or overall structure of any of these:\n'
            + hooks.map(h => `- "${h}…"`).join('\n'),
        );
    }
    if (visuals.length) {
        parts.push(
            'RECENT VISUALS — the "suggestedMediaDescription" for this post MUST use a different visual '
            + 'concept from these (and never a laptop/desk cliché):\n'
            + visuals.map(v => `- "${v}…"`).join('\n'),
        );
    }
    return parts.join('\n\n');
}

// ── Near-duplicate detection ──────────────────────────────────────────────────────────────────
// Telling the model "don't repeat yourself" is advice, and advice is not a guarantee. This is the
// check that verifies it actually complied, so a near-identical draft never reaches the queue
// unchallenged.
//
// Deliberately DETERMINISTIC — no model call, no embeddings. It runs on every generated caption,
// so it has to be free and instant; an LLM judge here would double the cost of drafting to answer
// a question that set arithmetic answers well. It is also then perfectly testable, which a model
// judge is not.

/**
 * Strip a caption to the words that carry its meaning: no case, no punctuation, no emoji, no URLs,
 * no hashtags, no @mentions. Two posts that differ only in hashtags and an emoji are the same post.
 */
export function normaliseForCompare(text: string): string[] {
    return (text || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')       // links
        .replace(/[#@][\w-]+/g, ' ')           // hashtags and mentions
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')     // punctuation + emoji (any non letter/number)
        .split(/\s+/)
        .filter(Boolean);
}

/** Overlapping word pairs. Order-sensitive enough to tell a rewrite from a reshuffle. */
function bigrams(words: string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
    return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const v of a) if (b.has(v)) shared++;
    return shared / (a.size + b.size - shared);
}

/** Words of the opening hook — the part a reader sees before "…more", and the part that repeats. */
const HOOK_WORDS = 12;

/**
 * How alike two captions are, 0–1.
 *
 * The higher of two views, because repetition shows up as either:
 *   - whole-caption overlap — the same post lightly reworded; and
 *   - opening overlap — different bodies behind an identical hook, which is what a reviewer
 *     scrolling a queue actually notices, and what the first live cross-post batch produced.
 * Taking the max means catching either is enough; requiring both would miss the common cases.
 */
export function captionSimilarity(a: string, b: string): number {
    const { whole, hook } = scorePair(a, b);
    return Math.max(whole, hook);
}

/**
 * The two views of one pair, computed once. Both the score and the trip test read from here, so
 * they can never disagree about how similar two captions are.
 */
function scorePair(a: string, b: string): { whole: number; hook: number } {
    const wa = normaliseForCompare(a);
    const wb = normaliseForCompare(b);
    if (wa.length < 4 || wb.length < 4) return { whole: 0, hook: 0 };   // too short to judge
    return {
        whole: jaccard(bigrams(wa), bigrams(wb)),
        hook: jaccard(new Set(wa.slice(0, HOOK_WORDS)), new Set(wb.slice(0, HOOK_WORDS))),
    };
}

/**
 * Trip points, tuned so a genuine rewrite of the same premise trips and two posts merely sharing a
 * content pillar do not. They are not symmetric on purpose: two captions can share a lot of
 * vocabulary across a whole post and still read as different posts, whereas a near-identical
 * OPENING reads as a duplicate however the body continues.
 *
 * Erring low here is not free — every trip costs one extra generation call, and the drainer runs
 * to a tight time budget. These are set to catch what a human would call "I've seen this already".
 */
export const NEAR_DUPLICATE_WHOLE = 0.45;
export const NEAR_DUPLICATE_HOOK = 0.7;

export interface NearDuplicate {
    /** The existing caption the new draft is too close to. */
    caption: string;
    /** 0–1, for the log line. */
    score: number;
}

/**
 * The prior post this caption is too close to, or null when it is genuinely new.
 * Returns the WORST offender so the corrective re-ask quotes the most similar one.
 */
export function findNearDuplicate(caption: string, priors: PriorPost[]): NearDuplicate | null {
    let worst: NearDuplicate | null = null;
    for (const prior of priors) {
        if (!prior.caption) continue;
        const { whole, hook } = scorePair(caption, prior.caption);
        if (whole < NEAR_DUPLICATE_WHOLE && hook < NEAR_DUPLICATE_HOOK) continue;
        const score = Math.max(whole, hook);
        if (!worst || score > worst.score) worst = { caption: prior.caption, score };
    }
    return worst;
}

/**
 * The corrective turn sent when a draft trips the check. Quotes BOTH captions: the model cannot
 * fix a collision it can't see, and naming the specific existing post is what stops it rewording
 * the same idea a second time.
 */
export function nearDuplicateRetryPrompt(dup: NearDuplicate): string {
    return 'That draft is too close to a post this assistant has already produced — the user would '
        + 'see the same idea twice in their review queue.\n\n'
        + `THE EXISTING POST:\n"${dup.caption.replace(/\s+/g, ' ').trim().slice(0, 400)}"\n\n`
        + 'Write a COMPLETELY different post instead: a different opening hook, a different core '
        + 'premise, and a different angle on the strategy above. Do not reword what you just wrote — '
        + 'the idea itself has to change. Return the same JSON shape as before.';
}
