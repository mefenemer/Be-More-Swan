// src/utils/chat-draft-claims.ts
//
// Reply ↔ persistence reconciliation for the social-media chat route.
//
// The orchestrator builds its reply text and its scheduled_posts row from the SAME model
// response but by two INDEPENDENT paths: `reply` is a free-text string shown to the user,
// while the post is only ever created from a well-formed `uiElement` of type
// social_post_draft. Nothing has ever compared the two. So a reply saying "all three posts
// are drafted and ready for your review" ships happily alongside a null uiElement, and the
// user goes to a Review Queue that has nothing in it.
//
// That is not hypothetical. On 2026-08-05 a live assistant made SIX such claims across
// 22 minutes before the user challenged it; `chat_messages.ui_element_json` was NULL on
// every one of them (the tell). Two of the turns in that window also blew the route's
// 1024-token budget mid-caption, so the JSON never parsed and the draft was lost even
// though the model had written it.
//
// This module supplies the missing comparison: given the reply text, does it ASSERT that a
// post now exists? The orchestrator asks that question only when it knows nothing was
// persisted, and swaps in an honest message when the answer is yes. Detection is
// deliberately dumb and deterministic — no second model call — because the guard must hold
// on exactly the turns where the model is already behaving unreliably.
//
// Kept free of DB/SDK imports so tests can exercise it without booting the function.

/** Phrasings that assert a post exists, is being made now, or is waiting to be reviewed. */
const CLAIM_PATTERNS: readonly RegExp[] = [
    // Completed-action assertions: "Drafted Tuesday's post", "saved", "added to your queue".
    /\b(?:drafted|saved|scheduled|created|queued|added)\b/i,
    // Present progressive. "Drafting your Tue/Wed/Thu posts now" promises work that would have
    // to happen after the turn ends — there is no such phase, so it is as false as the past tense.
    /\b(?:drafting|writing up|putting together|creating|scheduling)\b/i,
    // "ready to review", "ready for you to review", "all ready for your review now".
    /\bready\s+(?:to|for)\b[^.!?]{0,30}\breview/i,
    /\breview queue\b/i,
    // "Here's your Tuesday post", "Here are your three posts".
    /\bhere(?:'|’)?(?:s| is| are)\b[^.!?]{0,40}\bposts?\b/i,
    // "I'll draft those now" — same problem as the progressive form. Note \bdraft does NOT match
    // inside "redraft", which keeps the orchestrator's own retry line ("I'll redraft it cleanly")
    // out of this set.
    /\bi(?:'|’)?ll\s+(?:draft|write|put together|get|have)\b/i,
];

/** A negated sentence is a confession, not a claim — "I haven't actually delivered them yet". */
const NEGATED = /\b(?:haven(?:'|’)?t|hasn(?:'|’)?t|have not|has not|didn(?:'|’)?t|did not|don(?:'|’)?t|won(?:'|’)?t|will not|can(?:'|’)?t|cannot|couldn(?:'|’)?t|wasn(?:'|’)?t|isn(?:'|’)?t|nothing|not yet)\b/i;

/** Openers that make the sentence an offer or a proposal rather than a statement of fact. */
const OFFER_OPENER = /^(?:want(?:s)? me to|would you like|shall i|should i|do you want|can i|could i|i can|i could|happy to|let me know|if you(?:'|’)?d like)\b/i;

/**
 * Split on sentence terminators AND on the em/en dashes this model uses as one
 * ("Drafting your Tue/Wed/Thu posts now—all ready to review" is two assertions, and the
 * leading clause must be judged on its own).
 */
function sentences(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+|\s*[—–]\s*|\n+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * True when the reply tells the user a post has been (or is being) drafted, saved, scheduled
 * or queued for review.
 *
 * Questions, offers and negations are excluded, so the ordinary honest turns — "Want me to
 * draft one?", "What should it be about?", "I haven't drafted anything yet" — never trip it.
 * The caller is responsible for only asking when persistence genuinely produced nothing.
 */
export function replyClaimsPostSaved(reply: string): boolean {
    if (!reply || !reply.trim()) return false;
    return sentences(reply).some((s) => {
        if (s.endsWith('?')) return false;          // asking, not asserting
        if (OFFER_OPENER.test(s)) return false;     // offering, not asserting
        if (NEGATED.test(s)) return false;          // denying, not asserting
        return CLAIM_PATTERNS.some(re => re.test(s));
    });
}

/**
 * Why a claim could not be honoured:
 *   no_draft       — the model asserted a post but returned no usable draft object, so there
 *                    was never anything to save (the six-false-claims case).
 *   persist_failed — a valid draft came back but the scheduled_posts write threw; the caption
 *                    still reaches the user via the uiElement, so the message points at it.
 *   not_saved_here — drafting INTO a post the user has open. Persisting is correct-by-design
 *                    here; only the claim is wrong, and the client renders an apply button.
 */
export type DraftClaimFailure = 'no_draft' | 'persist_failed' | 'not_saved_here';

/** The reply that ships instead of the false one. Plain, first-person, and actionable. */
export function honestDraftReply(kind: DraftClaimFailure): string {
    switch (kind) {
        case 'no_draft':
            // Careful with the wording here: these strings are held to the same standard as the
            // model's, and a closing "I'll write it properly" would trip replyClaimsPostSaved
            // itself. tests/chat-draft-claims.test.ts asserts none of them do.
            return "Sorry — I said that was done, but nothing actually saved, so there's nothing in your Review Queue to look at. Ask me for a single post and I'll do it properly this time.";
        case 'persist_failed':
            return "I've written this one, but couldn't save it to your Review Queue just then. The caption's below — ask me to try again in a moment.";
        case 'not_saved_here':
            // Phrased to hold whether or not a caption card accompanies it: the model may have
            // claimed a save without producing a draft at all, in which case there is no button.
            return "To be clear, nothing from this chat is saved on its own — a caption only reaches the post you're editing when you press the button underneath it.";
    }
}
