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
    /**
     * True when the lead WOULD have been blocked but a human overrode it. Distinct from a plain
     * `blocked: false` — callers log it, because a bypassed compliance gate should never be
     * indistinguishable from a gate that never fired.
     */
    overridden: boolean;
    override: DoNotContactOverride | null;
}

/**
 * A human's explicit decision that a do-not-contact verdict was wrong. Persisted on the lead
 * record's `data`, NOT passed per-request: both the send path and the sequence worker consult the
 * same rule, and a per-send bypass would send the opener, enrol a cadence, then halt it at step 2.
 *
 * Deliberately NOT sticky across re-scoring. `upsertRecord` replaces `data` wholesale, so a fresh
 * scoring pass drops the override with the verdict it overrode — which is correct: the human
 * overruled one judgement, not every future one.
 */
export interface DoNotContactOverride {
    at: string;
    by: string;
    reason: string;
}

const NOT_BLOCKED: DoNotContactVerdict = { blocked: false, reason: null, source: null, overridden: false, override: null };

/** A stored override is only honoured if it carries a reason — an unexplained bypass is not one. */
function readOverride(v: unknown): DoNotContactOverride | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const reason = asText(o.reason).trim();
    const by = asText(o.by).trim();
    const at = asText(o.at).trim();
    if (!reason || !by || !at) return null;
    return { at, by, reason: reason.slice(0, 500) };
}

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

    let blocked: DoNotContactVerdict | null = null;

    // 1. The structured flag wins. Explicit `false` is a real answer — a later scoring pass that
    //    cleared the flag must not be overridden by stale prose left in suggestedNextStep.
    if (typeof d.doNotContact === 'boolean') {
        if (!d.doNotContact) return NOT_BLOCKED;
        const reason = asText(d.doNotContactReason).trim() || asText(d.suggestedNextStep).trim();
        blocked = {
            blocked: true,
            reason: reason.slice(0, 300) || 'Marked do-not-contact during qualification.',
            source: 'flag', overridden: false, override: null,
        };
    } else {
        // 2. No flag at all — fall back to the prose the older scoring passes wrote.
        const nextStep = asText(d.suggestedNextStep).trim();
        if (nextStep && LEGACY_DO_NOT_CONTACT.test(nextStep)) {
            blocked = { blocked: true, reason: nextStep.slice(0, 300), source: 'text', overridden: false, override: null };
        }
    }

    if (!blocked) return NOT_BLOCKED;

    // 3. A human overruled this specific verdict. Evaluated LAST so an override can only ever
    //    release a block that was genuinely raised — an override sitting on a lead nobody flagged
    //    is inert, and cannot pre-authorise a verdict a future scoring pass has not yet made.
    const override = readOverride(d.doNotContactOverride);
    if (override) {
        return { blocked: false, reason: blocked.reason, source: blocked.source, overridden: true, override };
    }

    return blocked;
}
