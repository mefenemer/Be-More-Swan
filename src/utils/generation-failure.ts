// src/utils/generation-failure.ts — why a post (or blog article) could not be written, in words the
// customer can act on. PURE. tests/generation-failure.test.ts.
//
// content_generation_jobs.error_message holds the RAW error: a provider's HTTP body, a stack-ish
// message, sometimes our own billing state ("credit balance is too low"). None of it may reach the
// customer — it reads as their fault, and the provider body leaks how our account stands. So the
// raw text is matched here and replaced with one of a few plain explanations, each saying whose
// problem it is and whether "Try again" can work:
//
//   ours      — our side broke (the AI service refused us, a bug). Nothing for them to fix; trying
//               again later works once we have fixed it.
//   temporary — busy, timed out, an answer that came back malformed. Trying again usually works.
//   theirs    — something they can change: a flagged brief, the monthly allowance, a paused
//               assistant, no picture credits.
//
// The raw error stays on the job and in the audit log for us; this never returns it.

export type FailureOwner = 'ours' | 'temporary' | 'theirs';

export interface FailureExplanation {
    /** One sentence, plain words. Safe to show to the customer. */
    reason: string;
    owner: FailureOwner;
    /** Whether a "Try again" button can help right now. */
    canRetry: boolean;
    /** What to do, when it is something they can do. */
    action: string | null;
}

const RULES: Array<{ test: RegExp; explain: FailureExplanation }> = [
    {
        test: /credit balance|quota|billing|insufficient_quota|authentication|permission|401|403/i,
        explain: { owner: 'ours', canRetry: true, action: null, reason: 'Our writing service was unavailable at the time — this was at our end, not yours. Your settings and schedule are fine.' },
    },
    {
        test: /hex escape|not valid json:|invalid json|surrogate/i,
        explain: { owner: 'ours', canRetry: true, action: null, reason: 'A fault at our end stopped the post being written. It has been fixed, so trying again should work.' },
    },
    {
        test: /SAFE_CONTENT|moderation|flagged|content policy|safety/i,
        explain: { owner: 'theirs', canRetry: false, action: 'Change the brief or the notes you gave, then ask for the post again.', reason: 'The brief for this post was flagged by our safety check, so it was not written.' },
    },
    {
        test: /task allowance|task limit|monthly task/i,
        explain: { owner: 'theirs', canRetry: false, action: 'Your allowance resets on the 1st of the month, or you can move to a bigger plan.', reason: 'Your monthly task allowance was used up, so this post was not written.' },
    },
    {
        test: /insufficient_ai_credits|ai credits/i,
        explain: { owner: 'theirs', canRetry: false, action: 'Add picture credits, or turn off AI pictures for this assistant, then try again.', reason: 'There were not enough AI picture credits to make this post\'s picture.' },
    },
    {
        test: /blueprint not found|assistant (is )?(paused|archived|not active)|no active blueprint/i,
        explain: { owner: 'theirs', canRetry: false, action: 'Check the assistant is active on its page, then try again.', reason: 'The assistant was paused or changed while this post was waiting to be written.' },
    },
    {
        test: /rate.?limit|429|overloaded|529|503|timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|network/i,
        explain: { owner: 'temporary', canRetry: true, action: null, reason: 'Our writing service was very busy and did not answer in time. Trying again usually works.' },
    },
    {
        test: /cut off|max_tokens|was not valid JSON with a caption|no_card_headline|too similar|near-duplicate/i,
        explain: { owner: 'temporary', canRetry: true, action: null, reason: 'The draft that came back was incomplete, so it was not saved. Trying again usually works.' },
    },
];

const FALLBACK: FailureExplanation = {
    owner: 'ours', canRetry: true, action: null,
    reason: 'Something went wrong at our end while writing this post. Trying again usually works; if it keeps happening, contact support.',
};

export function explainGenerationFailure(raw: string | null | undefined, kind: 'post' | 'article' = 'post'): FailureExplanation {
    const msg = String(raw || '');
    const hit = RULES.find((r) => r.test.test(msg))?.explain ?? FALLBACK;
    return kind === 'article' ? { ...hit, reason: hit.reason.replace(/\bpost\b/g, 'article') } : hit;
}
