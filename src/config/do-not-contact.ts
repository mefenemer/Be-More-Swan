// src/config/do-not-contact.ts
// The single rule for "this lead must not be emailed", shared by every path that can send.
//
// The qualification pass can conclude a lead is not contactable at all — an internal/test account,
// a competitor, an existing customer, someone who has asked not to be contacted. Until now that
// conclusion existed ONLY as free text in `suggestedNextStep` ("Do not contact. Remove from
// qualified leads pipeline."), which nothing read. A real staging send went to a lead carrying
// exactly that text; the drafter, handed a record describing an internal account and told to write
// cold outreach anyway, invented an account pretext to reconcile the two.
//
// So the signal is now structured (`doNotContact`), and this module is the ONLY place that decides.
// Two callers enforce it — send_outreach in lead-generation.ts and processEnrolment in
// process-sequence-sends.ts — and an already-enrolled lead has to be caught by the second, because
// the first never runs again for a cadence that is already in flight.
//
// NOT a suppression-list replacement. Suppression is tenant-wide and permanent (see
// src/utils/suppression.ts); this is per-lead and comes from qualification.

/** The structured verdict a scoring pass can attach to a lead record's `data`. */
export interface DoNotContactVerdict {
    blocked: boolean;
    /** Short human-readable why, safe to show in a toast. Null when not blocked. */
    reason: string | null;
    /** 'flag' = the structured field; 'text' = the legacy free-text backstop. */
    source: 'flag' | 'text' | null;
}

const NOT_BLOCKED: DoNotContactVerdict = { blocked: false, reason: null, source: null };

/**
 * Legacy backstop. Records scored before `doNotContact` existed carry the verdict only as prose,
 * and those records are still live and still sendable — record #173 is one. Deliberately tight:
 * it matches an imperative "do not contact / don't reach out / do not email", not any sentence
 * mentioning contact. A false positive here silently blocks legitimate outreach, so the cost of
 * missing an odd phrasing is lower than the cost of over-matching.
 */
const LEGACY_DO_NOT_CONTACT = /\b(?:do not|don'?t|never)\s+(?:contact|reach out to|reach out|email|approach|pursue|engage)\b/i;

function asText(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

/**
 * Decide whether a lead record may be emailed.
 *
 * @param data the lead record's `data` blob (assistant_records.data), whatever shape it is in.
 */
export function evaluateDoNotContact(data: unknown): DoNotContactVerdict {
    if (!data || typeof data !== 'object') return NOT_BLOCKED;
    const d = data as Record<string, unknown>;

    // 1. The structured flag wins. Explicit `false` is a real answer — a later scoring pass that
    //    cleared the flag must not be overridden by stale prose left in suggestedNextStep.
    if (typeof d.doNotContact === 'boolean') {
        if (!d.doNotContact) return NOT_BLOCKED;
        const reason = asText(d.doNotContactReason).trim() || asText(d.suggestedNextStep).trim();
        return { blocked: true, reason: reason.slice(0, 300) || 'Marked do-not-contact during qualification.', source: 'flag' };
    }

    // 2. No flag at all — fall back to the prose the older scoring passes wrote.
    const nextStep = asText(d.suggestedNextStep).trim();
    if (nextStep && LEGACY_DO_NOT_CONTACT.test(nextStep)) {
        return { blocked: true, reason: nextStep.slice(0, 300), source: 'text' };
    }

    return NOT_BLOCKED;
}
