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
