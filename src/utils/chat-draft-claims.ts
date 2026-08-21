// src/utils/chat-draft-claims.ts
//
// Reply ↔ persistence reconciliation for the chat routes that can produce a draft.
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
// ── 2026-08-21: the detector matched TOPICS, not claims ──────────────────────────────────
// The first version tested for bare verbs anywhere in a sentence — `drafted|saved|scheduled|
// created|queued|added` — which are also ordinary words about a business's own work. A Blog
// Writer asked for "a post about the new features ADDED during August" replied, correctly,
// "I can't see your changelog — tell me which features you added and I'll write it up", and
// every clause of that was scored as a claim: `added` (the user's own topic) and `I'll write`
// (a promise conditional on their answer). The guard then replaced a truthful refusal with
// "Sorry — I said that was done", an apology for something the model never said. Worse, the
// replacement asks the user to send the topic again, they do, the model gives the same honest
// answer, and the swap repeats byte-for-byte: a loop with no exit.
//
// So the patterns below no longer ask "does this sentence contain a drafting word?" but
// "does this sentence attribute a finished draft to the ASSISTANT?". A completed action has
// to be self-reported (sentence-initial "Drafted …"), first-person ("I've saved it"), or
// predicated of the content itself ("the posts are drafted"). "features you added", "what was
// added in August" and "the scheduling changes" name someone else's actions, or no action at
// all, and are no longer claims.
//
// Kept free of DB/SDK imports so tests can exercise it without booting the function.

/**
 * Nouns that stand for the thing this guard is about. Used to keep a sentence-initial gerund
 * ("Drafting your Tuesday posts now") apart from ordinary prose that happens to open with one
 * ("Creating a good headline takes practice").
 */
const CONTENT_NOUN = /\b(?:posts?|articles?|blogs?|drafts?|captions?|pieces?|issues?|newsletters?|it|them|these|those|one|three)\b/i;

/** The verbs that describe making a draft. Split by tense — they are gated differently below. */
const DONE_VERB = '(?:drafted|saved|scheduled|created|queued|added)';
const DOING_VERB = '(?:drafting|writing up|putting together|creating|scheduling)';

/**
 * Phrasings that assert a post EXISTS, or is being made right now. Each one requires the
 * action to belong to the assistant — that is the whole difference from the version that
 * flagged a user's own topic.
 */
const ASSERTS_EXISTS: readonly RegExp[] = [
    // Terse self-report, sentence-initially: "Drafted Tuesday's post", "Saved", "Scheduled for
    // Thursday morning". This is the register the 2026-08-05 incident actually used.
    new RegExp(`^(?:yes[,.]?\\s+|done[,.]?\\s+|ok(?:ay)?[,.]?\\s+)?${DONE_VERB}\\b`, 'i'),
    // First person, completed: "I've added it to your Review Queue", "I have saved that".
    new RegExp(`\\bi(?:'|’)?(?:ve|\\s+have)?\\s+(?:just\\s+|now\\s+|already\\s+)?${DONE_VERB}\\b`, 'i'),
    // Predicated of the content: "all three posts are drafted", "it is drafted", "the post has
    // been saved". Deliberately NOT triggered by "that"/"this" as the subject — "the features
    // that have been added" is the user's topic, not a claim about a draft.
    new RegExp(
        `\\b(?:it|they|these|those|posts?|articles?|drafts?|captions?|pieces?|issues?)\\b[^.!?]{0,40}?`
        + `\\b(?:is|are|was|were|has been|have been|(?:'|’)s|(?:'|’)re)\\s+(?:now\\s+|already\\s+)?${DONE_VERB}\\b`,
        'i',
    ),
    // Present progressive, self-reported. "Drafting your Tue/Wed/Thu posts now" promises work
    // that would have to happen after the turn ends — there is no such phase, so it is as false
    // as the past tense. The content-noun requirement keeps ordinary prose out.
    new RegExp(`^${DOING_VERB}\\b[^.!?]*${CONTENT_NOUN.source}`, 'i'),
    new RegExp(`\\bi(?:'|’)?m\\s+(?:just\\s+|now\\s+)?${DOING_VERB}\\b`, 'i'),
    // "ready to review", "ready for you to review", "all ready for your review now".
    /\bready\s+(?:to|for)\b[^.!?]{0,30}\breview/i,
    /\breview queue\b/i,
    // "Here's your Tuesday post", "Here are your three posts".
    /\bhere(?:'|’)?(?:s| is| are)\b[^.!?]{0,40}\bposts?\b/i,
];

/**
 * A promise to write, which is only false when it is unconditional. "I'll draft that one now"
 * describes a phase that does not exist and leaves the user waiting; "give me the list and I'll
 * write it up" is the assistant doing its job — asking for what it needs. Note \bdraft does NOT
 * match inside "redraft", which keeps the orchestrator's own retry line ("I'll redraft it
 * cleanly") out of this set.
 */
const PROMISES_TO_WRITE = /\bi(?:'|’)?ll\s+(?:draft|write|put together|get|have)\b/i;

/**
 * The same sentence asks the user for something, so the promise beside it is conditional on
 * their answer rather than a report of work done. Applied ONLY to PROMISES_TO_WRITE: a
 * completed-action claim is never rescued by a trailing request ("I've saved it, let me know if
 * you want changes" is still a false claim).
 */
const ASKS_USER_FOR_INPUT = /\b(?:send|tell|give|show|share|pass|drop|paste|point)\s+(?:me|us)\b|\blet me know\b|\b(?:once|after|when|as soon as)\s+you\b|\bif you\b|\byou(?:'|’)?(?:d| would) like\b/i;

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
 * So are sentences that ask the user for the very input the promise depends on. The caller is
 * responsible for only asking when persistence genuinely produced nothing.
 */
export function replyClaimsPostSaved(reply: string): boolean {
    if (!reply || !reply.trim()) return false;
    return sentences(reply).some((s) => {
        if (s.endsWith('?')) return false;          // asking, not asserting
        if (OFFER_OPENER.test(s)) return false;     // offering, not asserting
        if (NEGATED.test(s)) return false;          // denying, not asserting
        if (ASSERTS_EXISTS.some(re => re.test(s))) return true;
        return PROMISES_TO_WRITE.test(s) && !ASKS_USER_FOR_INPUT.test(s);
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
 *   blog_no_draft  — the DRAFT-CARD routes' version of no_draft, shared by blog_writer and
 *                    newsletter_editor. Neither writes on the turn (the user keeps or discards
 *                    from the card), so the only unbacked claim available to them is claiming
 *                    something that was never drafted at all. Its sentence deliberately names no
 *                    surface, which is what lets one string serve both — if it ever gains a
 *                    "check your Blogs tab", the newsletter route needs its own member.
 */
export type DraftClaimFailure = 'no_draft' | 'persist_failed' | 'not_saved_here' | 'blog_no_draft';

const ALL_FAILURES: readonly DraftClaimFailure[] = ['no_draft', 'persist_failed', 'not_saved_here', 'blog_no_draft'];

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
        case 'blog_no_draft':
            // "I'll do it properly" and not "I'll write it properly", for the reason above: the
            // latter matches the promise pattern, and this guard flagging its own replacement
            // text is a loop the user would see.
            return "Sorry — I said that was done, but no draft came through, so there's nothing here for you to keep. Send me the topic again and I'll do it properly this time.";
        case 'not_saved_here':
            // Phrased to hold whether or not a caption card accompanies it: the model may have
            // claimed a save without producing a draft at all, in which case there is no button.
            return "To be clear, nothing from this chat is saved on its own — a caption only reaches the post you're editing when you press the button underneath it.";
    }
}

/**
 * True when `text` is one of this module's own replacements — i.e. the previous turn was
 * already swapped out by the guard.
 *
 * The orchestrator uses this as a circuit breaker. Every replacement asks the user to try
 * again, so if the underlying cause is deterministic (the model cannot see the thing being
 * asked about, and says so every time) the guard would fire on the retry too and print the
 * identical apology for as long as the user kept trying. Seen doing exactly that on a Blog
 * Writer on 2026-08-21. After one swap, the model's own words go through and the user can at
 * least read what it is actually telling them.
 */
export function isHonestDraftReply(text: string): boolean {
    if (!text) return false;
    const trimmed = text.trim();
    return ALL_FAILURES.some((kind) => honestDraftReply(kind) === trimmed);
}
